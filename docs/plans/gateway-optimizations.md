# Gateway cache and shared project memory

Status: current
Owner: src/local-workers/, src/http/, src/memory/, host gateway profiles

Benchmark the installed SuperQwen model with its current F16 cache, Q8 KV, and a
pinned Atomic TurboQuant runtime. Record effective cache types, memory, throughput,
prompt-cache hits, grammar behavior and coding checks before choosing a profile.
Keep existing weights and model lifecycle ownership with the host gateway.

Expose bounded project-memory recall/store/forget through the existing MCP bridge
and central MemoryStore. Canonical project paths and project tags keep identical
facts in different projects separate. Store only caller-reviewed findings with
provenance; workers can receive selected recalled notes in their task brief.
SQLite remains on the M2 and worker sessions remain temporary.

Acceptance: compare measured cache profiles, verify concurrent 256K slots and real
coding tasks, prove cache hits and schema constraints, test project isolation and
persistence, deploy the passing profile and MCP tools, run repository checks and
CI, then remove task worktrees. Unsupported runtime/model combinations retain
their working profile and are reported explicitly.

Verified: four 256K slots on Q8/Turbo3 at about 42.5 GiB RSS, four real coding
jobs with independent passing tests, prompt-cache hits in native and tool-call
requests, native GBNF and tool-schema constraints, and exact retrieval from a
40,789-token input. Scoped project-memory tests cover isolation, linked worktrees,
SQLite reopening, provenance bounds and the existing memory enable setting.
