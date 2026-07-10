---
title: "Why Fake Time for Go Tests"
categories: [tech]
tags: [epochd, go, testing]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 1
---

I keep writing the same kind of bug report against my own code: something works fine today and will silently misbehave the moment a certificate expires, a token needs refreshing, or a TTL rolls over. The logic that's supposed to catch that case only runs once a month, or once a year, so it barely gets exercised — and when it finally does run, in production, it's the first time.

The obvious fix is to test it. The obvious problem is that "test it" usually means one of:

- **Sleep in the test.** Actually wait the hour/day/month for the TTL to expire. Technically correct, unusably slow, and nobody runs it in CI.
- **Thread a `Clock` interface through the code.** Replace every `time.Now()` with `clock.Now()`, inject a fake clock in tests. Works, but it's an invasive refactor of code you may not own, and it doesn't help at all once the thing under test is a real binary — a Postgres server, a compiled service, anything you're driving as a subprocess rather than a package.

That second option is the one that actually stops me most often. A lot of the code I want to test isn't mine to refactor. I want to start the real `postgres` binary, or the real compiled service, with its clock already pointing at a date next year, and have it behave exactly as if that date had actually arrived — no source changes, no recompilation, no `Clock` interface anywhere in sight.

That's the shape of the problem `epochd`'s `pkg/faketime` sets out to solve: given a running (or about-to-run) Linux process, make `time.Now()` — and every other wall-clock read inside it — return a time I chose, while everything else about the process stays real. Not a mock. Not a wrapper. The actual process, actually fooled.

Concretely, I wanted to be able to write a Go test that looks roughly like this:

```go
func TestCertRenewsBeforeExpiry(t *testing.T) {
    cmd := exec.Command("./my-service")
    target := time.Now().Add(-1 * time.Hour) // start slightly in the past
    faketime.WithProcess(t, cmd, target, func(t *testing.T, h *faketime.Handle) {
        // service starts believing it's `target`
        if err := h.Advance(29 * 24 * time.Hour); err != nil { // fast-forward 29 days
            t.Fatal(err)
        }
        // assert the service renewed its cert before day 30
    })
}
```

No sleeping. No mocking. The service under test is a real, unmodified binary, and the test controls its clock from the outside.

Getting from "I want this" to "this exists and works against a real, unmodified Linux binary" turned out to require going a lot further down the stack than I expected — ptrace, the vDSO, hand-written trampoline assembly, and eventually a real Postgres cluster that found a bug no amount of testing against my own toy binaries ever would have. This series is that build, roughly in the order it actually happened.
