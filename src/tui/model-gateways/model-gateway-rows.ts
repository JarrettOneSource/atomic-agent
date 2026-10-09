import type { GatewayModel, ModelGatewaySnapshot } from "../../local-llm/gateways/model-gateway-types.js";
import type { TuiState } from "../tui-state.js";

export interface ModelGatewayRow {
  host: ModelGatewaySnapshot;
  model: GatewayModel | null;
}

export function modelGatewayRows(state: TuiState): ModelGatewayRow[] {
  return state.llmPanel.gatewayHosts.flatMap<ModelGatewayRow>((host) => host.models.length
    ? host.models.map((model) => ({ host, model }))
    : [{ host, model: null }]);
}

export function selectedGatewayRow(state: TuiState): ModelGatewayRow | null {
  const rows = modelGatewayRows(state);
  return rows[Math.min(state.llmPanel.gatewayCursor, rows.length - 1)] ?? null;
}
