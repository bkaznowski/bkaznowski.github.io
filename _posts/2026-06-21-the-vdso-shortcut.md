---
title: "The vDSO Shortcut"
categories: [tech]
tags: [epochd, linux, vdso]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 3
---

The reason `clock_gettime` is fast enough for Go's runtime to call constantly is that, on modern Linux, it usually isn't a syscall at all.

Every process on Linux gets a small shared library mapped into its address space automatically, without ever calling `mmap` for it — the **vDSO**, "virtual dynamic shared object." You can see it in any process's memory map:

```
$ cat /proc/self/maps | grep vdso
7ffd8a1fe000-7ffd8a200000 r-xp 00000000 00:00 0  [vdso]
```

Glibc's wall-clock functions — `clock_gettime`, `gettimeofday`, `time` — don't trap into the kernel through the syscall instruction at all. They call into this mapped vDSO region, which reads the kernel's timekeeping data directly out of a shared memory page. No context switch, no scheduler involvement, just a function call and a couple of memory reads. That's the whole reason these calls cost ~20ns instead of the ~200ns-plus a real syscall would cost, and it's exactly why a ptrace-per-call approach (the previous post) adds four to five orders of magnitude of overhead: it's forcing a full syscall-grade round trip onto something that was specifically engineered to avoid one.

Here's the insight that makes injected fake time practical: **the vDSO is just a normal mapped region of executable code, sitting in the target's own address space.** It happens to be mapped read+execute, not read+write+execute — but a region being *marked* read-only doesn't mean ptrace can't write to it. `PTRACE_POKETEXT` — the same primitive debuggers use to plant breakpoints in your program's `.text` section — can write to any mapped page in a ptrace-stopped tracee, read-only or not. Debuggers rely on exactly this to insert an `INT3` byte at a breakpoint address; nothing distinguishes the vDSO's pages from any other executable page as far as `PTRACE_POKETEXT` is concerned.

So instead of intercepting every call, forever, the plan becomes:

1. Stop the target process once, briefly, with ptrace.
2. Overwrite the first few bytes of `clock_gettime` (and, it turns out, two other functions — more on that in a later post) inside the vDSO with a jump instruction to code I control.
3. Detach. The process resumes and keeps running exactly as before — except now every call to those functions redirects through my code first.
4. Never touch ptrace again for the rest of the process's life, unless I want to change the fake time. Updating the fake time afterward is a single `process_vm_writev` — no ptrace stop required at all.

The cost of injection becomes a fixed, one-time price paid once at startup, and the cost of every subsequent clock read is back to native vDSO speed, because after the jump lands it's still just a function call into mapped memory — just a different one. This is the difference between "slow down every clock read forever" and "pay a millisecond once."

There's an obvious follow-up question this raises: a jump instruction has to jump *somewhere*, and that somewhere needs to be memory I control, close enough to the vDSO to be reachable, containing code that knows how to fake a timestamp and then get out of the way. Building that — the trampoline — is the subject of the next post.
