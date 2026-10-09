# Remote model gateways

Status: current
Owner: src/local-llm/gateways/

`ModelGatewayClient` talks to a configured llama-swap host. The host owns model
processes, launch commands, GPU allocation and idle unloading. Atomic does not
download or supervise those processes through its managed-local daemon path.

Catalog and status use `/v1/models` and `/running`. They never probe an upstream
model. Explicit start uses `/upstream/{model}/` and then verifies `ready`; an
upstream root returning 404 does not imply load failure. Stop waits for the unload
operation and verifies the process is absent. A failed host remains unavailable,
not an empty list of stopped models.

Metadata under `meta.llamaswap` supplies kind, native alias, context, vision,
weight size, workspace link, idle policy and exclusive group. Atomic requires
Stop before starting another model in that group. See
[operator configuration](../../../docs/user/model-gateways.md).

`GatewayTaskManager` owns task leases. The shared runtime prepares providers for
each actual turn, including scheduled turns and pinned Fusion workers. Leases
keep models warm during long tools, honor cancellation, and end with the turn.
Status polling never acquires a lease. Health lease requests must be configured
as non-autoloading paths so they cannot undo an operator's Stop.

`gateway-target.ts` recognizes only configured gateway URLs. Other external and
cloud providers retain their existing lifecycle.

Checks: adjacent client/task-manager tests, runtime turn-service tests, TUI gateway
and health tests, production/test typechecks and `npm run imports:check`.
