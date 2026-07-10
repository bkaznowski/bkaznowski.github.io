---
title: "The Naive Approach: Ptrace Every Clock Read"
categories: [tech]
tags: [epochd, go, linux, ptrace]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 2
---

Before writing any of the code that ended up in `epochd`, I tried the approach that seems obvious if you already know Linux gives you `ptrace`: attach to the target process, catch every `clock_gettime` syscall as it happens, and rewrite the return value before the process ever sees it.

Mechanically, this is completely possible. `PTRACE_ATTACH` lets you stop a process at every syscall entry and exit (`PTRACE_SYSCALL`), inspect its registers with `PTRACE_GETREGS`, and mutate them with `PTRACE_SETREGS` before resuming it. Catch a `clock_gettime` on entry, let it run, catch the exit, and rewrite the `timespec` it just wrote into the caller's buffer via `process_vm_writev`. Repeat forever.

I got a proof of concept working. Then I pointed it at a real Go binary and watched it fall over.

**The problem is volume, not mechanics.** Go's runtime — the scheduler, the garbage collector, `time.Now()` calls scattered through any nontrivial program — calls the wall-clock read tens of thousands of times per second under normal load. Every one of those, under the ptrace-every-syscall approach, means:

1. Stop the tracee (a context switch into the kernel, and a wakeup for the tracer).
2. Wake the tracer process, have it call `waitpid`, then `PTRACE_GETREGS`.
3. Decide what to do, then `PTRACE_SETREGS` and `PTRACE_CONT`.
4. Wake the tracee back up (another context switch).

That's two full scheduler round-trips per clock read, competing with everything else on the box for CPU time. A `clock_gettime` call that would normally cost ~20-200ns turns into something costing tens of microseconds — a three-to-four-order-of-magnitude slowdown, applied to a function some programs call more than almost anything else they do. Beyond a certain call rate the tracee spends most of its life stopped, waiting on a tracer that is itself waiting on the scheduler. I tried it against `test/targets/clockprinter` — a trivial program that just prints `time.Now()` in a loop — and it was already visibly janky. Against a real service, it was worse.

There's a second problem layered on top: this approach requires the tracer to stay attached and responsive for the entire lifetime of the target process. If the tracer process dies, or gets descheduled for too long, or the target forks (more on that a few posts from now), you've built a system whose steady-state behavior is "constantly intercepting," which is a much bigger permanent liability than "intercept once, then get out of the way."

That reframing — *intercept once, then get out of the way* — is what sent me looking for a different mechanism entirely. If I could make the *first* clock read after injection permanently different, without needing to be in the loop for every subsequent one, the whole performance problem disappears. That's exactly what Linux's vDSO makes possible, and it's the subject of the next post.
