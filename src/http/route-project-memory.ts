import { ProjectMemory } from "../local-workers/project-memory.js";
import { getConfig } from "../config/index.js";
import { record } from "../local-workers/worker-request.js";
import { readJsonBody, sendJson, type HttpHandler } from "./request-context.js";

export function createProjectMemoryHandler(action: "recall" | "store" | "forget"): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.apiKey) { sendJson(res, 403, { error: { message: "Project memory requires bearer authentication" } }); return; }
    if (action !== "forget" && !getConfig().memory.notes.enabled) {
      sendJson(res, 403, { error: { message: "Project memory is disabled in Atomic settings" } }); return;
    }
    const raw = await readJsonBody<unknown>(req);
    const memory = new ProjectMemory(ctx.runtime.notesStore);
    try {
      if (action === "recall") sendJson(res, 200, { entries: await memory.recall(raw) });
      else if (action === "store") sendJson(res, 200, { entry: await memory.store(raw) });
      else {
        if (!record(raw) || typeof raw.projectDir !== "string" || typeof raw.id !== "number") throw new Error("projectDir and memory id are required");
        sendJson(res, 200, { removed: await memory.forget(raw.projectDir, raw.id) });
      }
    } catch (error) {
      sendJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  };
}
