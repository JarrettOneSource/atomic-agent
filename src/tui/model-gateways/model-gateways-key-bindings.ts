import type { Key } from "ink";
import type { LlmPanelKeyContext } from "../llm-panel/llm-panel-key-bindings.js";
import { modelGatewayRows, selectedGatewayRow } from "./model-gateway-rows.js";

export function handleModelGatewaysKey(input: string, key: Key, ctx: LlmPanelKeyContext): boolean | null {
  const { state, dispatch, callbacks } = ctx;
  if (state.llmPanel.mode !== "gateways") return null;
  if (key.upArrow || key.downArrow || input === "j" || input === "k") {
    const delta = key.upArrow || input === "k" ? -1 : 1;
    const cursor = Math.max(0, Math.min(modelGatewayRows(state).length - 1, state.llmPanel.gatewayCursor + delta));
    dispatch({ type: "llm_cursor_set", mode: "gateways", cursor });
    return true;
  }
  if (input === "r") { callbacks.onModelGatewaysRefresh?.(); return true; }
  if (input === "X") { callbacks.onModelGatewaysStopAll?.(); return true; }
  if (input === "f") { callbacks.onModelGatewaysToggleFusion?.(); return true; }
  const row = selectedGatewayRow(state);
  if (key.return || input === "s" || input === "w") {
    if (!row?.model || !row.host.online) return true;
    const args: [string, string] = [row.host.gateway.id, row.model.id];
    if (input === "s") callbacks.onModelGatewayStop?.(...args);
    else if (input === "w") callbacks.onModelGatewayWorker?.(...args);
    else callbacks.onModelGatewayUse?.(...args);
    return true;
  }
  return null;
}
