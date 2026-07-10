---
title: "The Bug Only a Real Postgres Server Could Find"
categories: [tech]
tags: [epochd, go, postgres, vdso, testing, distributed-systems]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 7
---

Every test I had — `pkg/vdso`, `pkg/procmem`, `pkg/trampoline`, `pkg/inject`, `pkg/faketime`, the end-to-end injection test that checks a target prints timestamps 24 hours ahead — passed. All of it, consistently, for weeks. Then I ran the test that actually mattered: a simulated end-of-day pipeline, ledger service in front, Postgres behind it, `StartWithTracking` following the connection-per-backend forks so every backend inherited the fake clock. Advance the clock a day, have the ledger service write the day's closing entries, then check what Postgres actually recorded for `now()` on those rows.

It recorded the real time. Not close to the fake time, not off by a rounding error — the actual, unmodified wall clock, on the very first write, as if injection hadn't happened at all. In a real system, that's not a cosmetic bug — it's every end-of-day ledger entry silently timestamped as having happened on the wrong day, in the one place (the datastore of record) where that's the hardest kind of wrong to notice after the fact.

### Reproducing it before assuming Docker was the problem

My first instinct was to suspect the environment — I was running this in a container with `--cap-add SYS_PTRACE`, and containers are where ptrace-adjacent things go to break in surprising ways. I ruled that out directly: same result with `--privileged`, no cgroup or namespace change made any difference, and — more convincingly — every test I already had, including ones exercising the exact same `ChildTracker`/fork-following machinery from the previous post against fanned-out Go workers, was green throughout. Whatever this was, it wasn't Docker, and it wasn't the fork-tracking logic. It was specific to this one target in the pipeline.

### Finding the actual gap

The thing that was different about Postgres wasn't that it forked (my tests already covered fan-out workers) — it's that it wasn't a Go binary. Every test I'd written up to this point injected into Go processes, either `test/targets/clockprinter` or Go stand-ins for the services in the pipeline. Go's runtime reads the wall clock through `clock_gettime`. Postgres's C code doesn't; `GetCurrentTimestamp()` — backing `now()`, and therefore backing every timestamp the ledger's closing entries would have gotten — calls `gettimeofday`.

I went back to the vDSO discovery code and actually checked, with `readelf -sD` on a dumped vDSO, exactly what `clock_gettime`, `gettimeofday`, and `time` are. I'd been treating them as effectively the same thing wearing different names — three ways of asking the kernel "what time is it," so surely patching one covers all three.

They aren't the same thing. They're three independent compiled functions, at three different addresses in the vDSO, each with its own entry point. My injector patched exactly one of them — `clock_gettime` — with the JMP that redirects into my trampoline. `gettimeofday` and `time` were completely untouched, on every single injection I had ever run. Any caller going through `clock_gettime` — which included every Go service in my pipeline tests, since that's what the Go runtime uses — saw the fake time perfectly, which is exactly why the ledger service itself correctly believed the day had ended. Any caller going through `gettimeofday` — Postgres, and as I found while checking, glibc and bash's own wall-clock reads like `$EPOCHREALTIME` too — saw completely real time, silently, with no error of any kind. The service deciding *whether* to close the day was fooled correctly; the datastore recording *when* it closed the day was not — and nothing in the pipeline would have told you the two disagreed unless you went looking.

### The fix, and why it isn't three times the previous work

The trampoline already had the right shape for this — one shared state struct, read by a stub. The fix was writing two more stubs of the same shape:

- **`gettimeofday_entry`** — same structure as the `clock_gettime` stub, adding the offset and writing back a `timeval` (microseconds) instead of a `timespec` (nanoseconds) — `offsetNsec / 1000`.
- **`time_entry`** — this one had its own trap. My first version called the real `time()` syscall internally and added the offset to the result. But the `time()` syscall only returns whole seconds — it discards the real fractional second before my stub ever sees it — so `time_entry` could disagree with the other two by up to a full second depending on where in the second the real call landed. For a ledger entry, a one-second disagreement between the service's timestamp and the database's timestamp is exactly the kind of thing that turns into a confusing off-by-one-second ordering bug in an audit trail. The fix was to have `time_entry` call `clock_gettime(CLOCK_REALTIME)` internally instead, apply the identical carry-normalized offset add the other two stubs use, and only then truncate to whole seconds. Now all three agree to the second, always.

`pkg/vdso.Locate` grew resolution for all three symbols instead of one, `pkg/inject` now performs three JMP patches instead of one during the injection sequence, and all three stubs share the same 32-byte state struct — one `SetTime`, `Freeze`, or `Advance` call updates the fake time for all three functions in a target process at once, keeping the ledger service and its datastore consistent with each other by construction rather than by convention.

While I had the vDSO symbol table open, I fixed two smaller things in the same pass: `clock_gettime_entry` now also catches `CLOCK_REALTIME_COARSE` (same wall clock, lower precision, a distinct clock ID some callers request), and I confirmed — by dumping the full vDSO symbol table, not just the three I already knew about — that `clock_getres`, `getcpu`, and `__vdso_sgx_enter_enclave` are the only other exports on x86-64, and none of them read current time. Three wall-clock functions really is the complete list.

### Why this needed a real pipeline to find, not a better unit test

I could have written a unit test asserting `gettimeofday` gets patched, once I knew to ask the question. What I couldn't have done is *think of the question* from inside my own test suite, because every test I'd written was, by construction, exercising services I controlled — and I'd only ever written Go test targets standing in for them. The bug wasn't a logic error I could have caught by trying harder at the same kind of test; it was a wrong assumption (`clock_gettime` and `gettimeofday` are basically the same call) that no amount of testing against Go binaries would ever surface, because Go binaries never call the path where the assumption was wrong. A pipeline test that only ever used Go stand-ins for "the database" would have stayed green forever, confidently testing the wrong thing.

That's the real argument for testing a distributed pipeline against its actual dependencies before trusting the fake-time story end to end: not "more tests," but a fundamentally different, non-Go caller in the loop, exercising a code path your own assumptions never thought to route around. `pg-faketime-test` — a separate project running a real `initdb`/`postgres` cluster under `WithChildTracker` and asserting `SELECT now()` tracks the faked clock — is what actually caught this, and it's stayed in the loop since as the check that a Go-only pipeline test structurally cannot replicate.

This is also, for now, where the series pauses. `pkg/faketime` covers testing a pipeline like this end to end on a single machine; the other half of `epochd` — turning the same injection mechanism into a Kubernetes-native agent and controller for shifting time across whole pods in a real cluster — is its own story, for another time.
