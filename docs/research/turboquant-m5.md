# Atomic TurboQuant for the M5 SuperQwen 27B benchmark

Status: current
Owner: Atomic gateway fork maintainers

Primary-source review, 2026-10-10. The compatibility review below preceded the
local benchmark. Measured results are recorded at the end.

## Pinned build

Use Atomic's **stable `b10298-2.0.0`**, published 2026-10-05, commit `cda0f9256665845cd9d6f3a0176880883f653a3d`. The project identifies `master` as stable and `dev-latest` as a rolling staging channel. This is a separate repository/channel from the older `atomic-llama-cpp-turboquant-nightly` used in some Atomic Agent documentation. [Release](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/b10298-2.0.0), [branch policy](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/TURBOQUANT.md#L9-L35).

- [macOS ARM64 tar.gz](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10298-2.0.0/llama-turboquant-macos-arm64.tar.gz): 25,690,806 bytes; SHA-256 `5795464b8e8dc2237662175d16a82e2f7cd24a62ce4cd72dfcd4b2db141f3371`.
- [macOS ARM64 zip](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10298-2.0.0/llama-turboquant-macos-arm64.zip): 25,704,576 bytes; SHA-256 `145202f0a25a03b3a73f36322f5bc613bfe5942ff31f15407b71ec52df479423`. Release describes the macOS distribution as signed and notarized.

Digests/sizes are GitHub asset metadata, not locally recomputed hashes. [Release API](https://api.github.com/repos/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tags/b10298-2.0.0).

For completeness, the legacy nightly repository's newest publication is `turboquant-9ca222f` (2026-10-06, prerelease). Its tar.gz is 29,823,466 bytes, SHA-256 `6a1bfc56c7e1af25fe1ed3bcb0facf944ccb6be8c953d0d941e76af88e71c15a`. Its GitHub `/latest` points instead to older non-prerelease `turboquant-6df272c`; therefore do not use an unqualified latest URL for reproducibility. [Nightly release](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant-nightly/releases/tag/turboquant-9ca222f).

## Compatibility and comparison arms

The stable fork implements `qwen35`, including the 64-layer 27B layout and Gated DeltaNet recurrent layers. It has Metal mixed **Q8 K / Turbo3 V** kernels for the model's 256-dimensional attention heads. The existing SuperQwen3.8 file uses this architecture, so retaining its Q4_K_M weights is appropriate; changing KV precision does not require re-quantizing weights or obtaining an MTP head. Exact file/template execution still requires the parent's load and behavior tests. [Model implementation](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/src/models/qwen35.cpp#L5-L35), [Metal prefill kernel](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/ggml/src/ggml-metal/ggml-metal.metal#L8606-L8615), [decode kernel](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/ggml/src/ggml-metal/ggml-metal.metal#L9444-L9453).

Recommended sequence:

1. Existing upstream b11149, Q8 K / Q8 V: current-runtime control.
2. Pinned Atomic stable, Q8 K / Q8 V: isolates differences introduced by changing runtime.
3. Same Atomic stable, Q8 K / Turbo3 V: preferred TurboQuant candidate.

Keep weights, prompt, generation budget, sampling, batch/ubatch, projector, slots and context identical. Use explicit `-fa on`. Do not add speculative decoding during the KV comparison. The publisher's own dense-Qwen short-context table has Turbo3 slower than f16; compressed KV is a memory benefit to measure, not a guaranteed speed improvement. [Publisher measurements](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/README.md#L257-L272).

### Why not label `turbo3/turbo3` literally

The fork automatically upgrades Turbo K to Q8 when symmetric Turbo K/V is requested with GQA ratio >=6. SuperQwen27B has 24 query heads and 4 KV heads, exactly6:1. Consequently `-ctk turbo3 -ctv turbo3` normally becomes **Q8 K / Turbo3 V**, not two Turbo3 caches. `TURBO_AUTO_ASYMMETRIC=0` disables the protection, but that should only be a separately labelled exploratory quality test. Record actual cache types/allocations, not merely requested flags. [Auto-asymmetric rule](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/src/llama-kv-cache.cpp#L106-L125), [warning](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/src/llama-kv-cache.cpp#L218-L237).

## Four 256K slots and memory

For four independent 262,144-token slots, use total `-c 1048576 -np 4 --no-kv-unified`. Non-unified context is divided by sequence count; unified mode changes that accounting. Verify actual per-slot context and slot count after launch. This does not extend the model beyond its native262144 per sequence. [Context accounting](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/src/llama-context.cpp#L323-L339).

Analytical attention-cache storage, assuming the known 16 full-attention layers ×4KV heads ×256head dimension:

| Effective K / V | Attention KV at 4×256K |
|---|---:|
| f16 / f16 | 64GiB |
| q8_0 / q8_0 | 34GiB |
| q8_0 / turbo3 | 23.25GiB |
| true turbo3 / turbo3 | 12.5GiB |

These are calculations, not runtime measurements. Q8 blocks are34 bytes/32 values; Turbo3 blocks are50 bytes/128 values in this release (nearby comments incorrectly retain old block-size numbers). Add existing~15.4GiB weights, projector, compute buffers, operating-system use, and recurrent state. The Qwen hybrid's recurrent R/S buffers remain **F32** regardless of KV flags. Four-slot recurrent and checkpoint storage therefore does not inherit the attention-cache compression ratio. [Block layouts](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/ggml/src/ggml-common.h#L250-L321), [hybrid state types](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/src/llama-model.cpp#L2509-L2522).

The server also has an independent host prompt-cache budget (`--cache-ram`, default8192MiB). Keep it controlled across arms, preferably zero for an isolated allocation benchmark, so additional prompt-state copies do not obscure KV savings. [Default](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/common/common.h#L664-L665).

## Correctness constraints

- Turbo cache types require Flash Attention; the fork auto-enables it if explicitly disabled. Use `-fa on` for a clear benchmark contract. [Enforcement](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/src/llama-context.cpp#L4536-L4543).
- **TurboFlash is not synonymous with Flash Attention.** Its special two-pass Metal decoder defaults off because of corrupted output on Apple10/M5-class hardware. It also only accepts head dimensions64/96/128, so Qwen's256-dimensional heads use ordinary Metal FA kernels. Leave `TURBO_FLASH` unset or0. [Dispatch guard](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/ggml/src/ggml-metal/ggml-metal-ops.cpp#L3045-L3078).
- **Turbo K cannot be RoPE-shifted correctly.** Context shift and shifted `--cache-reuse` skip Turbo K layers and can degrade output. Q8 K shift is fixed in this release, making Q8 K/Turbo V the safer choice. For any true Turbo K arm, use `--no-context-shift`, avoid shifted cache reuse, and reject/truncate deliberately at capacity rather than silently sliding it. Prefix reuse without shifting is a different operation. [Known constraint](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/TURBOQUANT.md#L177-L185).
- GDN/SSM state and partial rollback remain distinct from attention KV. Do not add NextN/MTP as an incidental optimization; its documentation warns that Metal/Vulkan GDN rollback quality may be upstream-limited. [Speculative caveat](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/NEXTN.md#L94-L100).
- Native `/completion` still supports GBNF `grammar` and `json_schema`; chat completions support schema output and tool calling with the model's Jinja template. Qwen tool calls have generated grammar; `tool_choice:required` requires a call, while `auto` applies the grammar lazily after a tool marker. KV precision is independent of these output constraints. Valid structure does not prove correct tool choice or successful writes. [Native grammar API](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/tools/server/README.md#L524-L526), [Qwen grammar construction](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/blob/b10298-2.0.0/common/chat.cpp#L1188-L1277).

Acceptance should include real prompt/decode timing at meaningful context depth, four concurrent isolated requests, memory pressure, valid constrained output, actual tool effects, and a long-context retrieval check. Startup allocation or a tiny completion alone does not establish 256K×4 quality or speed. No primary-source benchmark was found for this exact SuperQwen checkpoint on M5 Pro at that capacity.


## Measured on the M5 Pro (64 GiB)

Same SuperQwen 27B Q4_K_M weights and projector. Short cache/inference checks used
about 1,417 prompt tokens and a 32-token output budget; the concurrent arm used
1,421 prompt tokens per request. Flash Attention was enabled. These checks
allocate the stated context and exercise serving, not full-window quality.

| Runtime / K / V | Slots × context | RSS after checks | OS memory free | Concurrent batch |
| --- | --- | ---: | ---: | ---: |
| upstream b11149 / F16 / F16 | 2 × 256K | 50.88 GiB | 13% | 10.10 s for 2 |
| upstream b11149 / Q8 / Q8 | 4 × 256K | 50.89 GiB at load | 14% | Metal out-of-memory on decode |
| Atomic b10298-2.0.0 / Q8 / Q8 | 4 × 256K | 53.01 GiB | 13% | 21.14 s for 4 |
| Atomic b10298-2.0.0 / Q8 / Turbo3 | 4 × 256K | 42.25 GiB | 30% | 22.49 s for 4 |

The upstream Q8 arm used its default unified cache setting; the Atomic arms used
`--no-kv-unified`. Its failure therefore does not isolate a runtime regression.
The same-runtime Q8 versus mixed comparison does isolate cache precision: mixed
saved about 10.8 GiB while taking slightly longer in this short batch.

A repeated prompt reused 1,413 of 1,417 tokens. Mixed-cache prompt evaluation
fell from about 4.34 seconds to 0.11 seconds. The archive hash was independently
checked on the download host and inference host. Existing weights were preserved.

Four actual MCP coding jobs then completed in parallel. They changed only their
assigned source files; their tests remained byte-identical to the fixture, and
independent reruns passed all four. Completion times were 312.5–511.6 seconds,
with roughly 77–80% of reported prompt tokens served from cache. Resident memory
during the coding run was about 42.5 GiB, with 30% memory free.

Native GBNF forced the allowed JSON despite a prompt asking for invalid output.
A required function call respected an enum and disallowed extra properties;
repeating that chat request reported cached prompt tokens. A retrieval request
correctly returned a unique value from 40,789 input tokens (40,801 including chat
framing), taking about 235 seconds. This is one retrieval case, not a full 256K
accuracy evaluation.

The selected profile is the pinned Atomic runtime with Q8 keys/Turbo3 values,
four 256K slots, Flash Attention on and TurboFlash off. Runtime/model performance
remains workload dependent; four slots do not imply four times the speed.
