---
title: "The Naive Approach: Ptrace Every Clock Read"
categories: [tech]
tags: [epochd, go, linux, ptrace, distributed-systems]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 2
---

Before writing any of the code that ended up in `epochd`, I tried the approach that seems obvious if you already know Linux gives you `ptrace`: attach to the target service, catch every `clock_gettime` syscall as it happens, and rewrite the return value before the process ever sees it.

Mechanically, this is completely possible. `PTRACE_ATTACH` lets you stop a process at every syscall entry and exit (`PTRACE_SYSCALL`), inspect its registers with `PTRACE_GETREGS`, and mutate them with `PTRACE_SETREGS` before resuming it. Catch a `clock_gettime` on entry, let it run, catch the exit, and rewrite the `timespec` it just wrote into the caller's buffer via `process_vm_writev`. Repeat forever.

I got a proof of concept working. Then I pointed it at a real service — the kind that's supposed to sit around quietly for hours doing nothing until an end-of-day trigger fires — and watched it fall over.

**The problem is volume, not mechanics.** A service that "only" does something once a day is still, moment to moment, calling the wall clock constantly: a scheduling loop checking the cutoff time, the Go runtime's own internal timekeeping for the scheduler and GC, logging timestamps, request-handling code that stamps every event it processes. None of that is specific to the once-a-day trigger I actually care about — it's just the ordinary background hum of a running service — but it means the wall clock gets read tens of thousands of times per second even while nothing "interesting" is happening. Under the ptrace-every-syscall approach, every one of those reads means:

1. Stop the tracee (a context switch into the kernel, and a wakeup for the tracer).
2. Wake the tracer process, have it call `waitpid`, then `PTRACE_GETREGS`.
3. Decide what to do, then `PTRACE_SETREGS` and `PTRACE_CONT`.
4. Wake the tracee back up (another context switch).

That's two full scheduler round-trips per clock read. A `clock_gettime` call that would normally cost ~20-200ns turns into something costing tens of microseconds — a three-to-four-order-of-magnitude slowdown, applied to a function a real service calls constantly just to exist, long before the specific batch trigger I'm trying to test ever fires. I tried it against `test/targets/clockprinter` — a trivial program that just prints `time.Now()` in a loop — and it was already visibly janky. Against a real service under any load, it was worse.

There's a second problem layered on top, and it matters more for a distributed-systems test than a single-process one: this approach requires the tracer to stay attached and responsive for the *entire* lifetime of every process in the pipeline, for as long as the test runs. Test an end-of-day pipeline with three or four services plus a database, and that's three or four processes' worth of clock reads all competing for the same tracer's attention at once, for the full duration of a test that might be simulating several simulated days back to back. If the tracer falls behind on any one of them, every process it's attached to slows down in lockstep, which is exactly the kind of test flakiness that erodes trust in a test suite until people stop running it.

That reframing — *intercept once, then get out of the way, for however many processes the pipeline has* — is what sent me looking for a different mechanism entirely. If I could make the *first* clock read after injection permanently different, without needing to be in the loop for every subsequent one, the whole performance problem disappears, for one process or a dozen. That's exactly what Linux's vDSO makes possible, and it's the subject of the next post.
