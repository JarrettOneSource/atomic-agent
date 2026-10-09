import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TuiState } from "../tui-state.js";
import { theme } from "../theme/theme.js";
import { computeRowWindow } from "../row-window.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { plainKey, returnKey } from "../mouse/synthetic-key.js";
import { handleModelGatewaysKey } from "./model-gateways-key-bindings.js";
import { modelGatewayRows, selectedGatewayRow } from "./model-gateway-rows.js";
import { Osc8Link } from "../render/osc8-link.js";

const STATE_NAMES = {
  stopped: "Stopped", starting: "Loading", ready: "Ready", stopping: "Stopping", failed: "Failed",
} as const;

function Control({ input, label }: { input: string; label: string }): ReactElement {
  const mouse = useMouseCommands();
  const text = <Text color={theme.colors.accentSoft}>{label}</Text>;
  if (!mouse) return text;
  return <MouseTarget onMouse={(hit) => {
    if (!isPrimaryPress(hit.event)) return false;
    handleModelGatewaysKey(input, input === "" ? returnKey() : plainKey(), {
      state: mouse.getState(), dispatch: mouse.dispatch, callbacks: mouse.callbacks,
    });
    return true;
  }}>{text}</MouseTarget>;
}

export function ModelGatewaysPanel({ state, maxRows = 12 }: {
  state: TuiState;
  maxRows?: number;
}): ReactElement {
  const panel = state.llmPanel;
  const rows = modelGatewayRows(state);
  const selected = selectedGatewayRow(state);
  const workspace = maxRows >= 9 && selected?.model?.state === "ready" ? selected.model.workspacePath : null;
  const win = computeRowWindow(rows.length, panel.gatewayCursor, Math.max(1, maxRows - (workspace ? 8 : 7)));
  const fusion = state.providersPanel.runMode?.effective === "fusion";
  const workerId = state.providersPanel.runMode?.workerProviderId;
  const workerUrl = state.providersPanel.rows.find((provider) => provider.id === workerId)?.baseUrl;
  return <Box flexDirection="column" width="100%">
    <Text bold color={theme.colors.accentSoft} wrap="truncate-end">Model gateways · {fusion ? "Fusion" : "Solo"} · ←/→ other panes</Text>
    <Text wrap="truncate-end" color={theme.colors.muted}>
      {panel.gatewayStatus ?? "Choose a model to start it. Checking status loads nothing."}
    </Text>
    <Text wrap="truncate-end" color={theme.colors.muted}>
      {rows.length ? `${rows.length} models / hosts · ${win.hiddenBefore} above · ${win.hiddenAfter} below` : "No gateways configured in localModels.gateways"}
      {panel.gatewayBusy ? " · working…" : ""}
    </Text>
    {rows.slice(win.start, win.start + win.count).map(({ host, model }, offset) => {
      const index = win.start + offset;
      const active = !!model && state.session.llamaUrl === `${host.gateway.url}/upstream/${encodeURIComponent(model.id)}`;
      const worker = !!model && workerUrl === `${host.gateway.url}/upstream/${encodeURIComponent(model.id)}`;
      const status = !host.online ? "Offline" : model ? STATE_NAMES[model.state] : "No models";
      return <MouseListRow key={`${host.gateway.id}/${model?.id ?? "host"}`}
        selected={index === panel.gatewayCursor}
        onSelect={(mouse) => mouse.dispatch({ type: "llm_cursor_set", mode: "gateways", cursor: index })}
        onActivate={pressEnter(handleModelGatewaysKey)}>
        <Text wrap="truncate-end" color={index === panel.gatewayCursor ? theme.colors.accentSoft : undefined}>
          {index === panel.gatewayCursor ? ">" : " "} [{host.gateway.name}] {model?.name ?? "Host"} · {status}{active ? " · main" : ""}{worker ? fusion ? " · worker" : " · worker off" : ""}
        </Text>
      </MouseListRow>;
    })}
    <Text wrap="truncate-end" color={theme.colors.muted}>
      {selected?.host.error ?? (selected?.model
        ? `${selected.model.kind}${selected.model.sizeBytes ? ` · ${(selected.model.sizeBytes / 1024 ** 3).toFixed(1)} GiB weights` : ""}${selected.model.supportsVision ? " · vision" : ""}${selected.model.ttlSeconds ? ` · unload after ${Math.round(selected.model.ttlSeconds / 60)} idle minutes` : ""}`
        : "Add a gateway host to show its installed models.")}
    </Text>
    {workspace ? <Osc8Link url={workspace} label="Open model workspace" /> : null}
    <Box><Control input="" label="Enter Start" /><Text> · </Text><Control input="s" label="s Stop" /><Text> · </Text><Control input="w" label="w Worker" /></Box>
    <Box><Control input="f" label="f Solo/Fusion" /><Text> · </Text><Control input="X" label="X Stop all" /><Text> · </Text><Control input="r" label="r Refresh" /></Box>
    <Text color={theme.colors.muted} wrap="truncate-end">j/k move · ←/→ panes · / commands</Text>
  </Box>;
}
