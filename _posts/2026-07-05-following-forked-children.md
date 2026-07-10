---
title: "Following Forked Children"
categories: [tech]
tags: [epochd, go, linux, ptrace]
series: faketime
series_title: "Building epochd's Fake Time Injector"
part: 6
---

Everything up to this point assumes injecting into a process means injecting into *one* process, once, at startup. That assumption is fine for a lot of services. It falls apart completely against the target that mattered most to me: PostgreSQL, which forks a brand-new backend process for every client connection. Inject fake time into the postmaster and open a connection, and the actual work — the backend process that runs your query — is running code that was never injected, because it didn't exist yet when injection happened.

The fix has to be automatic. A test author starting a Postgres cluster with a fake clock shouldn't need to know, or care, that a `SELECT now()` on a fresh connection is actually running in a process that was `fork()`ed after the fact. So `pkg/faketime` grew a mode that watches the process tree and injects into new children as they appear, with no action required from the caller beyond opting in.

### Watching for fork and exec with ptrace options

Linux's ptrace has options for exactly this, set via `PTRACE_SETOPTIONS`:

- **`PTRACE_O_TRACEFORK`** (and `TRACEVFORK`) — when the tracee calls `fork`/`vfork`, the tracer gets a stop event carrying the new child's PID, and the child starts life already ptrace-stopped, before it runs a single instruction.
- **`PTRACE_O_TRACEEXEC`** — when the tracee calls `exec`, the tracer gets a stop event *before* the new program image starts running.

Both matter here for different reasons. `TRACEFORK` is the direct answer to the Postgres case — a new backend process appears, and I need to inject before it does any work. `TRACEEXEC` covers a different but related case: a process that re-execs itself (I ran into this with PEX's bootstrap process) or forks and then immediately execs a different binary. Without catching the exec event, an injection performed before the exec would just get thrown away — the new program image replaces the entire address space, vDSO included, so the trampoline page and the JMP patch are both gone, along with everything else the old process had mapped.

### ChildTracker: the piece that owns "keep injecting as things appear"

This became `ChildTracker`, reachable through `StartWithTracking`:

```go
ct, err := faketime.StartWithTracking(exec.Command("./postmaster"), target)
defer ct.Reset()
defer ct.Close()

// advances the parent AND every currently-tracked forked child in one call
if err := ct.Advance(24 * time.Hour); err != nil { ... }

fmt.Println(ct.PIDs())                       // parent PID first, then children
fmt.Println(ct.Handle.EffectiveTime())        // same accessor pattern as a plain Handle
```

Internally, a background goroutine calls a non-blocking wait (`WaitAnyNonBlocking` in `pkg/procmem`) in a loop, watching for fork/exec stop events from any tracked PID. On a fork event it reads the new child's PID via `PTRACE_GETEVENTMSG`, arms the same tracer options on it, injects the same fake-time state, and adds it to the tracked set. On an exec event it re-injects into the same PID, since the exec wiped out whatever was there before.

`Session` gained the equivalent as an option rather than a separate type — `faketime.NewSession(target, faketime.WithTracking())` — because the same need (auto-inject into anything that appears) applies just as much to a multi-process `Session` as to a single tracked command.

### The failure mode that shaped `IsAlive` and `Prune`

Tracking children well surfaces a problem that a single untracked process never has: forked children die on their own, all the time, as a completely normal part of the program's operation. Every time a Postgres client disconnects, its backend process exits. A `SetTime` call that assumes every tracked PID is still alive will hit `ESRCH` ("no such process") the moment it reaches a handle for a backend that closed its connection five seconds ago.

I didn't want callers to have to defensively check `IsAlive()` before every clock update just to avoid a spurious error from a process that was *supposed* to exit. So `applyAll` — the internal helper both `Session` and `ChildTracker` route bulk updates through — silently drops any handle that returns `ESRCH`, and `Session.Prune()` exists for callers who want to know the count without waiting for the next update to discover it. `IsAlive()` from a couple posts back turned out to be exactly the primitive this needed underneath, and `IsFrozen()` followed the same pattern once assertions in tests started wanting to check current mode, not just current time.

With children tracked and dead handles handled gracefully, the theory was that `pkg/faketime` was ready for its actual target: a real Postgres cluster, not a synthetic Go test binary. It mostly was. The part that wasn't is the subject of the next post, and it's the bug I'm least proud of and most glad was found before anyone else hit it.
