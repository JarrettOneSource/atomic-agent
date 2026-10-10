# Local worker bridge

Status: current
Owner: src/local-workers/, src/http/, src/cli/, desktop/

Expose bounded local agent jobs to Codex and Claude Code through one MCP adapter.
The running Atomic HTTP controller owns the global queue, job records and child
processes. Each child reuses Fusion's worker runner, scoped approvals and tool
policy in its own state directory and workspace. Host gateways retain ownership
of model processes; model status does not start inference.

1. Measure SuperQwen 27B at two 256K slots and four 128K slots. Record allocation,
   observed simultaneous requests and throughput. Select a measured default.
2. Implement authenticated job submission/status/cancel/cleanup, durable results,
   bounded concurrency, workspace isolation and process shutdown. Stop all and
   model Stop also cancel matching worker jobs.
3. Add a stdio MCP adapter with a private connection record for the live
   controller. Register it in Codex and Claude Code and test both clients.
4. Replace the picker's different-host restriction with shared-model/exclusive
   group compatibility. Preserve other active model selections.
5. Verify real concurrent coding changes, checks, cancellations and restart
   recovery; run repository gates, publish, deploy and remove task worktrees.

No additional model downloads are part of this change. A full 256K prompt quality
benchmark is separate from allocation/concurrency measurements.

Measured acceptance: two 256K and four 128K SuperQwen slots served simultaneous
requests on the M5. Two independent coding jobs completed through the MCP SDK,
changed their assigned files and passed independently rerun tests. Cross-client
cancellation stopped the child; controller shutdown stopped its active child;
dirty worktree cleanup refused until explicitly authorized. The actual GUI
allowed the M5 main model as a worker, preserved it when switching to Solo,
and unloaded it through Stop all.
