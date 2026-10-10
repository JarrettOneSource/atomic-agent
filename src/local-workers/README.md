# Local worker bridge

Status: current
Owner: src/local-workers/

The Atomic HTTP controller owns one `LocalWorkerJobs` queue across MCP clients.
The queue bounds concurrency by its configured maximum and each model's declared
slots. Jobs sharing a non-isolated directory, overlapping directory trees, or
competing models in one host's exclusive group serialize. Host gateways own
inference processes; the bridge owns only agent child processes.

`worker-executor.ts` starts each job with a private state directory and reuses
Fusion's existing worker runner, approval scopes and builder tools. The worker
uses its chosen gateway through the OpenAI-compatible adapter so independent
processes do not each claim native slot zero. The parent holds a gateway lease;
model Stop, Stop all and controller shutdown cancel the owned children. Workers
also watch their parent and stop on orphaning. A controller restart marks
unfinished records interrupted and never replays file changes.

`worker-request.ts` validates task input and saved records. `worker-settings.ts`
reads operator defaults from the state directory. `worker-connection.ts` publishes
the authenticated loopback address privately. `worker-mcp.ts` adapts the same job
HTTP routes for stdio MCP; disconnecting one client leaves its submitted jobs
with the controller.

Isolated jobs create detached git worktrees from the source repository's HEAD.
Directory jobs use the caller's existing workspace. Completed worktrees remain
for review and integration; cleanup refuses dirty worktrees unless the caller
explicitly chooses to discard changes. This is workspace separation and Atomic
approval policy, not an operating-system sandbox.

See [operator usage](../../docs/user/local-workers.md). Checks cover queue limits,
workspace conflicts, cancellation, durable results, authenticated routes and the
MCP adapter. Live acceptance additionally runs coding jobs through the SDK client
and checks their actual files and tests.

`ProjectMemory` exposes reviewed project notes through the central runtime's
MemoryStore. Canonical project identity is also a dedup tag, and selection/deletion
check both scope and provenance tags. The MCP caller selects note ids explicitly;
worker briefs receive bounded copies as reference data, while the SQLite owner
remains the hub. Memory tools never start inference.
