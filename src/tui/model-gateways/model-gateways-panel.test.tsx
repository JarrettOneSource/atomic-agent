import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { ModelGatewaysPanel } from "./model-gateways-panel.js";
import { reduceLlmPanelAction } from "../llm-panel/llm-panel-reducer.js";

function state(): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    llmPanel: {
      ...base.llmPanel, mode: "gateways", gatewayHosts: [
        { gateway: { id: "m5", name: "M5", url: "http://localhost:8990", apiKeyEnv: null }, online: true, error: null,
          models: [{ id: "muse", name: "Muse", description: "", kind: "llm", group: "large", nativeModel: "Muse", state: "stopped",
            contextSize: 32768, supportsVision: true, sizeBytes: 20000000000, workspacePath: null, ttlSeconds: 600 }] },
        { gateway: { id: "pc", name: "PC", url: "http://localhost:8991", apiKeyEnv: null }, online: false, error: "Host unreachable", models: [] },
      ],
    },
  };
}

describe("Atomic gateway model panel", () => {
  it("starts on the configured main model and preserves selection when the catalog changes", () => {
    const snapshot = state();
    const host = snapshot.llmPanel.gatewayHosts[0]!;
    const model = host.models[0]!;
    const base = createInitialTuiState({ ...fakeSession(), llamaUrl: "http://localhost:8990/upstream/muse" });
    const hosts = [{ ...host, models: [{ ...model, id: "alpha", name: "Alpha" }, model] }];
    const loaded = reduceLlmPanelAction(base, { type: "llm_gateways_refreshed", hosts })!;
    expect(loaded.llmPanel.gatewayCursor).toBe(1);
    const refreshed = reduceLlmPanelAction(loaded, { type: "llm_gateways_refreshed", hosts: [{ ...host, models: [model] }] })!;
    expect(refreshed.llmPanel.gatewayCursor).toBe(0);
  });
  it("distinguishes an unloaded model from an offline host and exposes lifecycle controls", () => {
    const { lastFrame } = render(<ModelGatewaysPanel state={state()} maxRows={15} />);
    expect(lastFrame()).toContain("Muse");
    expect(lastFrame()).toContain("Stopped");
    expect(lastFrame()).toContain("Offline");
    expect(lastFrame()).toContain("Stop all");
  });

  it("keeps a large remote catalog within the terminal's row budget", () => {
    const initial = state();
    const host = initial.llmPanel.gatewayHosts[0]!;
    const model = host.models[0]!;
    initial.llmPanel.gatewayHosts = [{ ...host,
      models: Array.from({ length: 40 }, (_, i) => ({ ...model, id: `m${i}`, name: `Model ${i}` })),
    }];
    initial.llmPanel.gatewayCursor = 30;
    const { lastFrame } = render(<ModelGatewaysPanel state={initial} maxRows={10} />);
    expect(lastFrame()).toContain("Model 30");
    expect(lastFrame()!.split("\n").length).toBeLessThanOrEqual(10);
  });
});
