---
title: "Building the Injector: Remote Mmap and the Trampoline"
categories: [tech]
tags: [epochd, linux, ptrace, assembly]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 4
---

The previous post ended on: a jump instruction needs somewhere to jump to. That somewhere is a small hand-assembled payload — the **trampoline** — that has to live in memory I control, within reach of the vDSO, and it has to end up there without ever giving the target process a moment where its clock reads are broken or inconsistent. Getting this right turned into `pkg/procmem` (ptrace primitives), `pkg/trampoline` (the payload), and `pkg/inject` (the orchestration that ties them together).

### Step 1: get the target a page of memory it doesn't know it has

A `JMP rel32` instruction can only reach ±2GB from where it's placed, so the trampoline needs to land close to the vDSO — and I need the target process itself to allocate that memory, since I can't map pages into another process's address space from the outside. The trick is to make the target call `mmap` on my behalf, without it ever running any code of its own to do so:

1. Scan `/proc/<pid>/maps` for a free address within ±2GB of the vDSO — close enough for the eventual jump to reach.
2. Ptrace-stop the target. Temporarily stash three bytes at the `clock_gettime` entry point (safe — I haven't patched it yet, and I restore these bytes immediately after) with `0F 05 CC`: the `syscall` instruction followed by `int3`.
3. Set the target's registers by hand — `RAX` = `__NR_mmap`, and the arguments for `mmap(hint, 4096, PROT_READ|PROT_WRITE|PROT_EXEC, MAP_PRIVATE|MAP_ANON|MAP_FIXED_NOREPLACE, -1, 0)` — then resume the tracee with `PTRACE_CONT`.
4. The tracee executes the syscall, immediately hits the `int3` I planted right after it, and traps back to me with `SIGTRAP`.
5. Read `RAX` — that's the address of the freshly mapped page, chosen by the kernel to satisfy my hint. Restore the original three bytes and registers at the `clock_gettime` entry as if nothing happened.

This is the part of the codebase I'm proudest of, mostly because it's the part that felt like cheating when it finally worked: the target process just ran a real `mmap` syscall, with real kernel bookkeeping behind it, and has no idea it did.

### Step 2: write the payload into that page

With a rwx page now sitting in the target's address space, I copy in the trampoline: three tiny hand-written x86-64 stubs (one each for `clock_gettime`, `gettimeofday`, and `time` — why three separate ones is next week's post) plus a 32-byte shared state struct, all pre-assembled from `trampoline.asm` into `trampoline.bin` and embedded directly in the Go binary. This step uses `process_vm_writev`, which needs no ptrace stop at all — just the ptrace *relationship* (or `CAP_SYS_PTRACE`) already established.

```
state struct, at offset 436 in the page:
  +0   int64  offsetSec
  +8   int64  offsetNsec
  +16  uint64 enabledMask   // 1 = advancing, 3 = frozen
  +24  uint32 generation    // bumped on each update
  +28  uint32 _pad
```

`offsetSec`/`offsetNsec` are written pre-populated with the fake time's offset from real time before the page is ever wired up, so there's no window where the trampoline exists but reads garbage state.

### Step 3: patch the vDSO to jump into it

Now the actual hook: for each of the three functions, ptrace-stop the target again and use `PTRACE_POKETEXT` to overwrite its first five bytes with `E9 <disp32>` — `JMP rel32` — targeting that function's stub offset inside the new page. `PTRACE_POKETEXT` is what makes this possible at all despite the vDSO being mapped read-only-but-executable; it's the same primitive a debugger uses to plant a breakpoint byte in your `.text` section, just writing five bytes of jump instead of one byte of `int3`.

### Step 4: detach, and never come back (for reads)

The target resumes. From here on, every call to `clock_gettime`, `gettimeofday`, or `time` lands in the trampoline stub first, which does the real syscall (or, for `time`, an internal `clock_gettime`; more on why in the Postgres post), adds the offset from the shared state struct, and returns — all without a single ptrace round-trip. Updating the fake time later — `SetTime`, `Advance`, `Freeze` — is just another `process_vm_writev` write of a new 32-byte state struct. No stop, no signal, no coordination with whatever the target happens to be doing at that moment.

That last property is the entire payoff of everything above: the cost of *changing* the fake time, for the rest of the process's life, is one bulk memory write. Compare that to the ptrace-every-call approach from two posts back, where every single read carried the overhead this whole design exists to avoid.

The mechanics above are what make `pkg/inject` work in isolation. Turning that into an API that's actually pleasant to use from a Go test — starting a command, freezing versus advancing, cleaning up automatically when the test ends — is a different kind of design problem, and it's what the next post is about.
