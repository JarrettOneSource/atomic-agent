# Local workers for Codex and Claude Code

Status: current
Owner: Atomic gateway fork maintainers

The Atomic GUI controller can run local coding jobs for Codex and Claude Code.
Both clients share one queue and the same on-demand model gateways. Keep Atomic
open on the hub; starting an MCP connection only discovers the controller and
does not load a model.

## Connect a client

Build the agent, then register its stdio adapter. Use an absolute path to the
installed launcher when it is not on the client's PATH:

```sh
codex mcp add atomic-workers -- /path/to/atomic-agent worker-mcp
claude mcp add --scope user --transport stdio atomic-workers -- /path/to/atomic-agent worker-mcp
```

The launcher and controller must use the same `ATOMIC_AGENT_STATE_DIR`. The
controller writes `worker-connection.json` there with owner-only permissions;
the adapter reads it for each call, so controller restarts require no token edit.
Do not publish this connection record. For a client on another trusted machine,
run the same adapter over an existing SSH connection to the hub.

## Delegate work

- `local_worker_models`: discover hosts, installed chat models, slots and limits.
- `local_worker_run`: submit a bounded task with an absolute `workingDir` on the
  hub. Optional `hostId` and `modelId` select an installed model.
- `local_worker_status`: list jobs, or inspect one `jobId`; `waitSeconds` waits up
  to twenty seconds for a result.
- `local_worker_result`: retrieve the result, tool statistics and worktree path.
- `local_worker_cancel`: cancel queued or active work, preserving existing edits.
- `local_worker_cleanup`: remove a finished job after integrating its changes.
- `local_memory_recall`: retrieve reviewed project findings from the hub's SQLite.
- `local_memory_store`: save a reviewed finding with its evidence.
- `local_memory_forget`: remove an obsolete project finding.

By default a coding job gets a detached git worktree from HEAD. Uncommitted source
changes are not copied. Use `isolate: false` for a separate directory prepared by
the orchestrator, such as a workspace containing an uncommitted patch to review.
Jobs in overlapping non-isolated directories serialize. Workers may write and
run commands in the supplied workspace through Atomic's scoped approvals; broader
actions are refused and returned to the orchestrator. This is not an OS sandbox.

Ask for one concrete change and its checks per job. Inspect the returned diff
and run the relevant tests before integrating. A successful reply alone does not
prove that the changes meet the task. Cleanup refuses a dirty worktree by default;
`discardChanges: true` explicitly discards its remaining edits. It never deletes
the original source workspace.

## Shared project memory

Memory tools take an absolute `projectDir` on the hub. A linked git worktree shares
its primary checkout's memory; a non-repository directory uses its canonical path.
Facts retain their evidence and project identity in the existing `memory.sqlite`.
Project scopes remain separate even when identical content is deduplicated.

Recall relevant notes before a task and pass up to five returned ids as
`memoryIds` to `local_worker_run`. The bridge checks the project and adds their
contents to the task as reference data. Workers still have temporary state and
cannot silently update the shared store. After reviewing actual files and tests,
the orchestrator can save a durable finding with the command, file or observation
that supports it. Avoid credentials, transcripts and unverified worker claims.

The store and recall tools do not start inference. Turning off Atomic notes
(`memory.notes.enabled`) also disables these reads, writes and worker attachments;
explicit removal remains available. Embeddings are optional and
remain disabled unless separately configured; bounded FTS5 search works without
an embedding model. The ordinary Atomic memory UI can also display these notes.

## Capacity and lifecycle

`local-workers.json` in the controller's state directory sets operator defaults:

```json
{"maxWorkers":4,"defaultHostId":"m5","defaultModelId":"qwen-large"}
```

Restart the controller after changing this file. The default without it is one
worker and the selected main gateway model. Per-model `metadata.parallelSlots`
must match the host runtime's `--parallel`. `metadata.contextSize` and
`capabilities.context` describe the context per slot, not the total pool.

A 64 GiB M5 Pro with SuperQwen 27B Q4_K_M was tested with two 262,144-token slots
and four 131,072-token slots. Both used roughly 50 GiB resident memory during short
requests, with 13–14% memory free reported by macOS. Two requests gave no aggregate
speedup in that workload; four improved aggregate throughput by about one third
while increasing individual latency. These are measured configurations, not a
full-window quality benchmark or a universal maximum for other models.

The optimized SuperQwen profile supports four workers at 256K with Q8 keys and
Turbo3 values. The host runtime is pinned to Atomic TurboQuant b10298-2.0.0;
Flash Attention is enabled and experimental TurboFlash is disabled.
[Measurements and constraints](../research/turboquant-m5.md) distinguish allocation,
throughput and correctness evidence. Additional jobs queue.
Atomic's model picker can use the main model as its worker on the same host;
separate models must fit their host and avoid conflicting exclusive groups.
Fusion's selected worker count follows the model's declared slots.

Stop all in Atomic cancels the shared worker queue before unloading reachable
models. Stopping one model cancels its jobs. Controller shutdown stops child
processes; unfinished jobs after an unexpected restart are marked interrupted.
Closing Codex or Claude disconnects that MCP client and leaves jobs with Atomic.
Keep models on-demand and let the gateway's idle policy unload them afterward.

Worker results retain the provider's reported `usage.cachedTokens` across steps.
Gateway workers explicitly request prompt caching; a host's model parameters can
override it. `local_worker_models` reports declared cache types and runtime when
the gateway supplies that metadata. Native agent calls retain Atomic's GBNF;
OpenAI-compatible workers use the server's tool-schema constraints.
