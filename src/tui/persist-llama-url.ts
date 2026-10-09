import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { describeLlamaHealthFailure } from "../llm/describe-llama-health-failure.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { ChatOrchestrator } from "./chat-orchestrator.js";
import type { TuiAction } from "./tui-action.js";
import { persistUserLocalLlmUrl, pointsAtManagedDaemon } from "./persist-user-local-models-config.js";

export async function persistLlamaUrl(
  nextUrl: string,
  bus: { emit(action: TuiAction): void },
  orchestrator: ChatOrchestrator,
  runtime: AgentRuntime,
): Promise<boolean> {
  // Every verdict goes to BOTH channels: `runtime_info` keeps the feed
  // history, `providers_status` is the LLM panel's own status line — the
  // only line the operator can actually see while saving from the
  // External pane. Feed-only reporting is how a refused save looked like
  // "nothing happened" (stub-verified: the 404/steer verdicts never
  // rendered anywhere on the panel).
  const report = (line: string): void => {
    bus.emit({ type: "runtime_info", line });
    bus.emit({ type: "providers_status", line, source: "external" });
  };
  try {
    // Immediate feedback: the probe can take up to 8s against a dead
    // host, and a silent gap reads as a freeze (#65).
    report(`probing ${nextUrl}…`);
    const health = await checkLlamaServer({
      url: nextUrl,
      retries: 0,
      backoffMs: 0,
      timeoutMs: 8000,
      // Catch a --api-key server here, where the operator can act,
      // instead of on the first completion (llama.cpp exempts /health
      // from the key, so the plain probe passes).
      verifyAuth: true,
    });
    if (!health.reachable) {
      report(describeLlamaHealthFailure(health, nextUrl));
      // An openai-compat verdict has a real path forward — the same
      // server saved as a cloud provider — so beyond naming it, open
      // the steer prompt: `y` there deep-links into the provider
      // wizard prefilled with this URL (Ollama URLs land on the
      // Ollama preset) instead of leaving a dead-end refusal.
      if (health.kind === "openai-compat") {
        bus.emit({ type: "llm_external_compat_steer_opened", url: nextUrl });
      }
      return false;
    }
    persistUserLocalLlmUrl(nextUrl);
    // Rebuild the registered provider: its base URL was frozen at boot
    // (health/vision requests would keep hitting the old address until
    // a restart). The config write above already reset the cache.
    await runtime.reloadLlmProvider("local-llama");
    bus.emit({ type: "llama_url_changed", url: nextUrl });
    orchestrator.updateLlamaUrl(nextUrl);
    // The URL only takes effect if the chat route points at
    // llama-server; a cloud provider would otherwise stay active and
    // the saved URL would look inert. Done after the probe so a dead
    // address never steals a working route, and skipped when the route
    // is already local so editing a URL stays quiet. `refresh()`
    // re-reads `localModels.mode` so the LLM tab stops claiming managed.
    if (getConfig().llm?.activeTextProvider !== "local-llama") {
      await orchestrator.providers.setActiveText("local-llama");
    }
    // An external server replaces the managed chat daemon, which would
    // otherwise keep its VRAM for a route nothing uses. Unless the new
    // URL *is* the managed daemon — stopping it would kill the server
    // we just pointed at. Both branches refresh the LLM tab so it stops
    // reporting managed mode.
    if (
      pointsAtManagedDaemon(nextUrl, getConfig().localModels.managed.port)
    ) {
      await orchestrator.localModels.refresh();
    } else {
      await orchestrator.localModels.stopChatDaemonOnly();
    }
    report(`local-llm URL saved (${health.latencyMs}ms)`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report(`local-llm URL not saved: ${msg}`);
    return false;
  }
}
