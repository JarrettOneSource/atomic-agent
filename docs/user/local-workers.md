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

## Capacity and lifecycle

`local-workers.json` in the controller's state directory sets operator defaults:

```json
{"maxWorkers":2,"defaultHostId":"m5","defaultModelId":"qwen-large"}
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

The installed bridge defaults to two workers at 256K. Additional jobs queue.
Atomic's model picker can use the main model as its worker on the same host;
separate models must fit their host and avoid conflicting exclusive groups.
Fusion's selected worker count follows the model's declared slots.

Stop all in Atomic cancels the shared worker queue before unloading reachable
models. Stopping one model cancels its jobs. Controller shutdown stops child
processes; unfinished jobs after an unexpected restart are marked interrupted.
Closing Codex or Claude disconnects that MCP client and leaves jobs with Atomic.
Keep models on-demand and let the gateway's idle policy unload them afterward.
