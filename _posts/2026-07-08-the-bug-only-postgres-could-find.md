---
title: "The Bug Only a Real Postgres Server Could Find"
categories: [tech]
tags: [epochd, go, postgres, vdso, testing]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 7
---

Every test I had — `pkg/vdso`, `pkg/procmem`, `pkg/trampoline`, `pkg/inject`, `pkg/faketime`, the end-to-end injection test that checks a target prints timestamps 24 hours ahead — passed. All of it, consistently, for weeks. Then I pointed the whole thing at a real PostgreSQL cluster instead of my own test binaries, wrapped the postmaster in `StartWithTracking`, opened a connection, and ran `SELECT now()`.

It returned the real time. Not close to the fake time, not off by a rounding error — the actual, unmodified wall clock, on the very first query, as if injection hadn't happened at all.

### Reproducing it before assuming Docker was the problem

My first instinct was to suspect the environment — I was running this in a container with `--cap-add SYS_PTRACE`, and containers are where ptrace-adjacent things go to break in surprising ways. I ruled that out directly: same result with `--privileged`, no cgroup or namespace change made any difference, and — more convincingly — every test I already had, including ones exercising the exact same `ChildTracker`/fork-following machinery from the previous post, was green throughout. Whatever this was, it wasn't Docker, and it wasn't the fork-tracking logic. It was specific to this target.

### Finding the actual gap

The thing that was different about this target wasn't that it forked (my tests already covered that) — it's that it wasn't a Go binary. Every test I'd written up to this point injected into `test/targets/clockprinter`, a small Go program built specifically for these tests. Go's runtime reads the wall clock through `clock_gettime`. Postgres's C code doesn't; `GetCurrentTimestamp()` (backing `now()`, `SELECT now()`, `CURRENT_TIMESTAMP`, and friends) calls `gettimeofday`.

I went back to the vDSO discovery code and actually checked, with `readelf -sD` on a dumped vDSO, exactly what `clock_gettime`, `gettimeofday`, and `time` are. I'd been treating them as effectively the same thing wearing different names — three ways of asking the kernel "what time is it," so surely patching one covers all three.

They aren't the same thing. They're three independent compiled functions, at three different addresses in the vDSO, each with its own entry point. My injector patched exactly one of them — `clock_gettime` — with the JMP that redirects into my trampoline. `gettimeofday` and `time` were completely untouched, on every single injection I had ever run. Any caller going through `clock_gettime` — which included every Go program I'd tested against, since that's what the Go runtime uses — saw the fake time perfectly. Any caller going through `gettimeofday` — Postgres, and as I found while checking, glibc and bash's own wall-clock reads like `$EPOCHREALTIME` too — saw completely real time, silently, with no error of any kind to indicate anything was wrong. My entire test suite was green because every test happened to only exercise the one function I'd actually patched.

### The fix, and why it isn't three times the previous work

The trampoline already had the right shape for this — one shared state struct, read by a stub. The fix was writing two more stubs of the same shape:

- **`gettimeofday_entry`** — same structure as the `clock_gettime` stub, adding the offset and writing back a `timeval` (microseconds) instead of a `timespec` (nanoseconds) — `offsetNsec / 1000`.
- **`time_entry`** — this one had its own trap. My first version called the real `time()` syscall internally and added the offset to the result. But the `time()` syscall only returns whole seconds — it discards the real fractional second before my stub ever sees it — so `time_entry` could disagree with the other two by up to a full second depending on where in the second the real call landed. The fix was to have `time_entry` call `clock_gettime(CLOCK_REALTIME)` internally instead, apply the identical carry-normalized offset add the other two stubs use, and only then truncate to whole seconds. Now all three agree to the second, always.

`pkg/vdso.Locate` grew resolution for all three symbols instead of one, `pkg/inject` now performs three JMP patches instead of one during the injection sequence, and all three stubs share the same 32-byte state struct — one `SetTime`, `Freeze`, or `Advance` call updates the fake time for all three functions in a target process at once, keeping them consistent with each other by construction rather than by convention.

While I had the vDSO symbol table open, I fixed two smaller things in the same pass: `clock_gettime_entry` now also catches `CLOCK_REALTIME_COARSE` (same wall clock, lower precision, a distinct clock ID some callers request), and I confirmed — by dumping the full vDSO symbol table, not just the three I already knew about — that `clock_getres`, `getcpu`, and `__vdso_sgx_enter_enclave` are the only other exports on x86-64, and none of them read current time. Three wall-clock functions really is the complete list.

### Why this needed a real target to find, not a better unit test

I could have written a unit test asserting `gettimeofday` gets patched, once I knew to ask the question. What I couldn't have done is *think of the question* from inside my own test suite, because every test I'd written was, by construction, exercising code I controlled — and I'd only ever written Go test targets. The bug wasn't a logic error I could have caught by trying harder at the same kind of test; it was a wrong assumption (`clock_gettime` and `gettimeofday` are basically the same call) that no amount of testing against Go binaries would ever surface, because Go binaries never call the path where the assumption was wrong.

That's the real argument for testing library code like this against a real, independent, non-Go target before trusting it: not "more tests," but a fundamentally different caller, exercising code paths your own assumptions never thought to route around. `pg-faketime-test` — a separate project running a real `initdb`/`postgres` cluster under `WithChildTracker` and asserting `SELECT now()` tracks the faked clock — is what actually caught this, and it's stayed in the loop since as the check that a Go-only test suite structurally cannot replicate.

This is also, for now, where the series pauses. `pkg/faketime` covers the Go-testing side of `epochd`; the other half of the project — turning the same injection mechanism into a Kubernetes-native agent and controller for shifting time across whole pods — is its own story, for another time.
