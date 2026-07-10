---
title: "Testing Batch Jobs Without Waiting for Them"
categories: [tech]
tags: [epochd, go, testing, distributed-systems]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 1
---

A lot of the distributed systems I work on have a shape like this: several independently-deployed services, each with its own scheduler, and a pile of behavior that only happens once a day — end-of-day settlement, nightly reconciliation, report generation, billing-period rollover, token and certificate expiry sweeps. Each service decides "has the day ended yet?" in its own way: a poll loop checking `time.Now()` against a cutoff, a cron-like expression evaluated on a timer, a sleep-until-deadline. None of that logic runs more than once every 24 hours, which means it barely gets exercised in normal operation — and the first time it really runs against production conditions is in production.

Testing this properly means testing the actual trigger, not just the handler it eventually calls. Calling `RunEndOfDaySettlement()` directly in a test tells you the settlement logic is correct. It tells you nothing about whether the scheduler that's supposed to call it actually fires at the right moment, across every service in the pipeline, in the right order, without one service's clock disagreeing with another's about whether the day has actually rolled over. That gap — between "the handler works" and "the system correctly decides to invoke the handler" — is exactly where I've seen real incidents come from.

The two conventional ways to close that gap both have a problem:

- **Wait for real time to pass.** Technically correct, completely unusable in CI. Nobody is running a test suite that blocks for 24 hours.
- **Give every service an injectable clock — a `Clock` interface, a test-only flag, a debug endpoint that sets the time.** This works for code you own and control completely. It falls apart the moment the pipeline includes anything you don't own the source of — the database backing the ledger, a message broker, a vendored scheduler binary — none of which ships a "pretend it's tomorrow" hook. And even within your own services, any code path that reads time in a way the injected clock doesn't cover (a library's internal timer, a syscall issued somewhere you didn't thread the interface through) quietly falls out of sync with the rest of the system, which is worse than not faking it at all — the test *looks* like it's exercising real timing behavior and isn't.

What I wanted instead: take the real, compiled, unmodified binaries — every service in the pipeline, and the datastore underneath them — and shift each one's actual OS-level wall clock forward, from outside the process, with zero source changes and zero test-only code shipped into production. If a service decides "the day changed" using an ordinary `time.Now()` call somewhere deep in a library it doesn't control, injected fake time makes that call return tomorrow, and the service's own real scheduling logic does the rest — I never call its internal handler myself. And because the injection happens at the OS level rather than the application level, I can advance every service in the pipeline together, so the whole distributed system crosses midnight at (approximately) the same instant — the way a real day boundary actually arrives, not staggered by whichever service's test harness happens to poke it first.

That's the shape of the problem `epochd`'s `pkg/faketime` solves. A test for an end-of-day pipeline ends up looking roughly like this:

```go
func TestEndOfDaySettlementFires(t *testing.T) {
    ledger := exec.Command("./ledger-service")
    target := time.Now()

    faketime.WithProcess(t, ledger, target, func(t *testing.T, h *faketime.Handle) {
        // jump the whole service straight to just before midnight
        if err := h.Advance(24 * time.Hour); err != nil {
            t.Fatal(err)
        }
        // the service's own scheduler — untouched, unmodified — now believes
        // the day has ended, and fires settlement on its own
        assertSettlementRan(t, ledger)
    })
}
```

No sleeping, no shortened "test day" config, no handler called directly. The service under test is a real, unmodified binary, deciding for itself that time has moved on.

Getting from "I want this" to "this reliably fools a real service's scheduler, and every other process downstream of it in the pipeline" took going further down the stack than I expected — ptrace, the vDSO, hand-assembled trampoline code, and eventually a real Postgres cluster that exposed a gap none of my own test binaries ever would have. This series is that build, in the order it actually happened.
