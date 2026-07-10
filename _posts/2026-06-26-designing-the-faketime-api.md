---
title: "Designing the faketime API"
categories: [tech]
tags: [epochd, go, testing, api-design, distributed-systems]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 5
---

`pkg/inject` (the previous post) is correct, but it only knows about one process at a time, and it talks in terms of PIDs, ptrace tracers, and raw offset structs. A test for an end-of-day pipeline doesn't want any of that — it wants to say "the whole system just crossed midnight" and have every service in it agree. `pkg/faketime` is the layer that makes that possible, and its design ended up centered less on injecting into one process than on keeping several in sync.

### One process at a time, first

The base primitives map directly onto the two clock modes the trampoline supports:

```go
h, err := faketime.Start(cmd, target)        // advancing: clock ticks forward from target
h, err := faketime.StartFrozen(cmd, target)  // frozen: clock is pinned at target forever
```

Both return a `*Handle`, and both share `h.Advance(d)` (shift forward by a duration, regardless of mode), `h.Freeze(t)`, and `h.SetTime(t)`. A single service's scheduling test doesn't want to think about "am I in frozen or advancing mode," it wants to say "move forward one day" and have that mean the same thing either way — whether the test is simulating a single instant (frozen, useful for asserting exactly what the pipeline does *at* the cutover) or letting time keep ticking forward from a chosen point (advancing, useful for watching a sequence of triggers fire in order after the jump).

### `Session`: the part that actually matters for a pipeline

A real end-of-day flow is rarely one process. It's a ledger service, whatever it talks to, and the datastore underneath — each independently deciding, from its own `time.Now()` calls, whether the day has ended. If I advance each one separately, one `SetTime` call at a time, there's a real window where one service believes it's tomorrow and another still believes it's today — exactly the kind of skew that doesn't happen (or happens for microseconds, not test-visible seconds) when a real day actually ends, but very much can happen if a test advances four processes' clocks one after another with unrelated Go function calls in between.

`Session` exists to close that window:

```go
s := faketime.NewSession(target)
if err := s.Start(ledgerCmd); err != nil { ... }
if err := s.Start(reconciliationCmd); err != nil { ... }
if err := s.Start(notifierCmd); err != nil { ... }

// every tracked process jumps together — writes are issued out
// concurrently so the skew between them is as small as it can be
if err := s.Advance(24 * time.Hour); err != nil { ... }
```

Internally this is still just one `process_vm_writev` per process — there's no cross-process transaction, no lock stepping the writes together at the kernel level. What `Session.Advance` does is fire all of those writes concurrently rather than one after another in a loop, which is the difference between a skew window measured in the time it takes several syscalls to complete versus one measured in however long the slowest step of a sequential loop happens to take. For a test asserting ordering between services — reconciliation shouldn't start before the ledger closes — that's the difference between a test that's reliably testing the real ordering logic and one that's occasionally just testing how fast your test harness happens to be that run.

### The methods that came from actually writing pipeline tests, not from a design doc

`Start`, `Advance`, and `Session` were there from the beginning. `Handle.EffectiveTime()`, `Handle.PID()`, `Handle.IsAlive()`, and `Session.Close()` were not — they came out of a backlog I only accumulated once I started writing real multi-service tests and kept reaching for something that wasn't there:

- **`EffectiveTime() time.Time`** — for asserting "what time does this service currently believe it is" without redoing the offset arithmetic in the test itself. Useful on its own, and essential once a test is checking that two services in the pipeline agree with each other, not just that either one individually jumped.
- **`PID() int`** — needed to correlate a handle with a log line from the actual service, when a pipeline test is trying to work out *which* process's scheduler fired first.
- **`IsAlive() bool`** — a `kill(pid, 0)` check. A pipeline test that expects one service to shut down cleanly after finishing its end-of-day work wants to check that without accidentally erroring out the whole `Session` because one handle no longer points at a live process.
- **`Session.Close()`** — exists because a `Session` isn't always just a bag of handles; once you add tracking (next post), it owns a background goroutine watching for forked children across every tracked process, and something has to stop that goroutine when the test ends.

None of these are exotic. That's the point — they're the small, obvious things you don't notice are missing until you're mid-test, watching four services' worth of output, and reach for them.

### Cleanup that survives a pipeline test failing halfway through

The rawest form of the API still leaves cleanup up to the caller — kill each process, wait on it, reset its clock. For a single service that's a three-line defer block; for a pipeline of several, it's easy to leak one if the test fails partway through starting them. So the idiomatic entry points wire cleanup through `t.Cleanup`, which is the one mechanism in the standard testing package that reliably runs even when the test body panics or fails early:

```go
faketime.WithSession(t, target,
    func(s *faketime.Session) error {
        if err := s.Start(ledgerCmd); err != nil { return err }
        return s.Start(reconciliationCmd)
    },
    func(t *testing.T, s *faketime.Session) {
        if err := s.Advance(24 * time.Hour); err != nil { t.Fatal(err) }
        // assert both services agree the day has ended
    },
)
// every started process is killed, waited, and reset here — even if
// the assertion callback called t.Fatal partway through
```

A leaked, fake-time-shifted service sitting around after a pipeline test finishes is a much worse failure mode than a verbose defer block, because it fails silently in CI and shows up as a mystery in some *other* test's flakiness later.

Everything above assumes each process in the pipeline stays exactly one process for its whole life. That assumption breaks the moment any of them forks — which the datastore behind a real ledger pipeline (Postgres, forking a new backend per connection) does immediately. Making injected fake time survive a fork, and an `exec` after that, is the subject of the next post.
