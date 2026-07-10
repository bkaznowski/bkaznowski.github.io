---
title: "Designing the faketime API"
categories: [tech]
tags: [epochd, go, testing, api-design]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 5
---

`pkg/inject` (the previous post) is correct, but it is not something I'd want to look at from inside a test. It talks in terms of PIDs, ptrace tracers, and raw offset structs. `pkg/faketime` is the layer I actually wanted: a package whose only job is to make "start this process with a fake clock" read like a normal line of Go, and whose defaults match what a test author actually needs, not what the injection mechanism happens to expose.

The first two entry points map directly onto the two clock modes the trampoline supports:

```go
h, err := faketime.Start(cmd, target)        // advancing: clock ticks forward from target
h, err := faketime.StartFrozen(cmd, target)  // frozen: clock is pinned at target forever
```

Both return a `*Handle`, and both modes share the same follow-up operations — `h.Advance(d)` shifts the clock forward by a duration regardless of mode (for advancing clocks it moves the offset; for frozen clocks it moves the pinned instant), `h.Freeze(t)` and `h.SetTime(t)` switch modes outright. This was a deliberate choice: a test simulating billing cycles doesn't want to think about "am I in frozen or advancing mode right now," it wants to say "move forward 30 days" and have that mean the same thing either way.

### The methods that came from actually writing tests, not from the design doc

`Start` and `Advance` were there from the beginning. `Handle.EffectiveTime()`, `Handle.PID()`, `Handle.IsAlive()`, and `Session.Close()` were not — they came out of a backlog I only accumulated once I started writing real tests against the library and kept reaching for something that wasn't there:

- **`EffectiveTime() time.Time`** — I kept wanting to assert "what time does the process think it is right now" without doing the offset arithmetic myself in the test. It exists purely to make assertions read naturally: `h.EffectiveTime()` for advancing mode is `time.Now().Add(offset)`; for frozen mode it's just the pinned instant.
- **`PID() int`** — needed anywhere a test wants to correlate the handle with, say, a log line or a `/proc` inspection, without having grabbed `cmd.Process.Pid` and threaded it through separately.
- **`IsAlive() bool`** — a `kill(pid, 0)` check. Trivial to write inline, annoying to have to remember to write inline every time a test wants to check a process hasn't already exited before touching its clock again.
- **`Session.Close()`** — this one exists because `Session` isn't always just a bag of handles; once you add tracking (next post), a `Session` owns a background goroutine watching for forked children, and something has to stop it. `Close` is that something, and it needed to exist before `WithTracking` could ship responsibly.

None of these are exotic. That's the point — they're the small, obvious things you don't notice are missing until you're mid-test and reach for them.

### Cleanup is the part I didn't want to leave to the caller

The rawest form of the API — `Start`/`StartFrozen` returning a `*Handle` — still leaves cleanup up to the caller: kill the process, wait on it, reset the clock. Every example that used the raw form had the same three-line defer block. So the idiomatic entry point for a test isn't `Start` at all, it's:

```go
func TestCertRenewal(t *testing.T) {
    cmd := exec.Command("./my-service")
    target := time.Now()

    faketime.WithProcess(t, cmd, target, func(t *testing.T, h *faketime.Handle) {
        if err := h.Advance(29 * 24 * time.Hour); err != nil {
            t.Fatal(err)
        }
        // assert on the service's behaviour here
    })
    // process killed, waited, clock reset — even if the callback called t.Fatal
}
```

`WithProcess` wires cleanup through `t.Cleanup`, which is the one mechanism in the standard testing package that reliably runs even when the test body panics or fails early. That guarantee — the child process doesn't outlive the test, ever, regardless of how the test exits — mattered more to me than saving three lines. A leaked, fake-time-shifted subprocess sitting around after a test suite finishes is a much worse failure mode than a verbose defer block, because it fails silently and shows up as a mystery later.

`Session` extends the same idea across multiple processes that need to share one clock — `s.Start(cmd1)`, `s.Start(cmd2)`, then `s.Advance(d)` updates every tracked handle with one call, sent out concurrently so the window where processes disagree about the time is as small as possible.

Everything above assumes each process I inject into stays exactly one process for its whole life. That assumption breaks the moment the thing under test forks — which, for the specific real-world target that motivated most of this (Postgres, which forks a new backend process per connection), it does immediately. Making injected fake time survive a fork, and an `exec` after that, is the subject of the next post.
