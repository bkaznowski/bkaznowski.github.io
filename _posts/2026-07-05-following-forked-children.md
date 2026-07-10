---
title: "Following Forked Children"
categories: [tech]
tags: [epochd, go, linux, ptrace, distributed-systems]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 6
---

Everything up to this point assumes injecting into a process means injecting into *one* process, once, at startup. That assumption is fine for a lot of services in a pipeline. It falls apart against two very ordinary shapes of program: a batch job that fans out — forking a worker process per account, per customer, per shard, to parallelize the end-of-day run — and, underneath almost any real pipeline, the datastore itself. PostgreSQL forks a brand-new backend process for every client connection. Inject fake time into the postmaster and open a connection to write the day's ledger entries, and the actual work — the backend process handling your query — is running code that was never injected, because it didn't exist yet when injection happened.

The fix has to be automatic. A test asserting an end-of-day batch job's fanned-out workers all agree on the simulated cutover instant shouldn't need to know, or care, that each worker is a process that came into existence *after* the fake clock was set. So `pkg/faketime` grew a mode that watches the process tree and injects into new children as they appear, with no action required from the caller beyond opting in.

### Watching for fork and exec with ptrace options

Linux's ptrace has options for exactly this, set via `PTRACE_SETOPTIONS`:

- **`PTRACE_O_TRACEFORK`** (and `TRACEVFORK`) — when the tracee calls `fork`/`vfork`, the tracer gets a stop event carrying the new child's PID, and the child starts life already ptrace-stopped, before it runs a single instruction.
- **`PTRACE_O_TRACEEXEC`** — when the tracee calls `exec`, the tracer gets a stop event *before* the new program image starts running.

Both matter here for different reasons. `TRACEFORK` is the direct answer to fan-out workers and to Postgres's connection-per-backend model — a new process appears mid-pipeline, and I need to inject before it does any work, including the very first clock read it makes to decide what "today" is. `TRACEEXEC` covers a related case: a batch-job launcher that re-execs itself into the actual worker binary, or forks and then immediately execs a different program. Without catching the exec event, an injection performed before the exec would just get thrown away — the new program image replaces the entire address space, vDSO included, so the trampoline page and the JMP patch are both gone, along with everything else the old process had mapped. A worker that silently reverted to the real wall clock mid-fan-out is exactly the kind of bug that would show up as one shard's ledger entries landing on the wrong day.

### ChildTracker: the piece that owns "keep injecting as things appear"

This became `ChildTracker`, reachable through `StartWithTracking`:

```go
ct, err := faketime.StartWithTracking(exec.Command("./end-of-day-batch"), target)
defer ct.Reset()
defer ct.Close()

// advances the launcher AND every currently-tracked forked worker in one call
if err := ct.Advance(24 * time.Hour); err != nil { ... }

fmt.Println(ct.PIDs())                       // launcher PID first, then workers
fmt.Println(ct.Handle.EffectiveTime())        // same accessor pattern as a plain Handle
```

Internally, a background goroutine calls a non-blocking wait (`WaitAnyNonBlocking` in `pkg/procmem`) in a loop, watching for fork/exec stop events from any tracked PID. On a fork event it reads the new child's PID via `PTRACE_GETEVENTMSG`, arms the same tracer options on it, injects the same fake-time state, and adds it to the tracked set — so a worker forked to handle shard 47 sees exactly the same simulated end-of-day instant as the launcher and every other shard's worker. On an exec event it re-injects into the same PID, since the exec wiped out whatever was there before.

`Session` gained the equivalent as an option rather than a separate type — `faketime.NewSession(target, faketime.WithTracking())` — because the same need (auto-inject into anything that appears, across every process in the pipeline) applies just as much to a multi-service `Session` as to a single tracked launcher.

### The failure mode that shaped `IsAlive` and `Prune`

Tracking children well surfaces a problem that a single untracked process never has: forked workers, and forked database backends, die on their own, all the time, as a completely normal part of the pipeline finishing its work. Every worker that finishes its shard exits. Every client that disconnects from Postgres ends its backend process. A `SetTime` call that assumes every tracked PID is still alive will hit `ESRCH` ("no such process") the moment it reaches a handle for a worker that finished five seconds ago — right when a test is trying to advance the clock again for the *next* simulated day.

I didn't want callers to have to defensively check `IsAlive()` before every clock update just to avoid a spurious error from a worker that was *supposed* to exit. So `applyAll` — the internal helper both `Session` and `ChildTracker` route bulk updates through — silently drops any handle that returns `ESRCH`, and `Session.Prune()` exists for callers who want to know the count without waiting for the next update to discover it. `IsAlive()` from a couple posts back turned out to be exactly the primitive this needed underneath, and `IsFrozen()` followed the same pattern once assertions in tests started wanting to check current mode, not just current time.

With fanned-out workers and dead handles handled gracefully, the theory was that `pkg/faketime` was ready for its actual target: a real end-to-end run against a real Postgres cluster backing the ledger, not a synthetic Go test binary standing in for it. It mostly was. The part that wasn't is the subject of the next post, and it's the bug I'm least proud of and most glad was found before it silently corrupted a test's idea of when something happened.
