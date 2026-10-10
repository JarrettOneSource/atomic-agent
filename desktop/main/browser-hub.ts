import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { Socket } from "node:net";

type CallKind = "invoke" | "send";
interface Channels { invoke: string[]; send: string[]; sendSync: string[]; events: string[] }
export interface BrowserHubOptions {
  port: number;
  origin: string;
  rendererDir: string;
  platform: string;
  freshAtBoot: boolean;
  stopVersion?(): number;
  call(kind: CallKind, channel: string, args: unknown[]): unknown | Promise<unknown>;
  queues(): unknown;
  downloadRoots(): string[];
}

const BODY_LIMIT = 4 * 1024 * 1024;
class RequestTooLarge extends Error {}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const actual = Buffer.from(candidate), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > BODY_LIMIT) throw new RequestTooLarge("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Private browser transport for the same handlers used by the desktop GUI. */
export class BrowserHub {
  private readonly token = randomBytes(32).toString("hex");
  private readonly subscribers = new Set<ServerResponse>();
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((req, res) => {
    void this.dispatch(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof RequestTooLarge ? 413 : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      json(res, status, { error: error instanceof Error ? error.message : "Hub request failed" });
    });
  });
  private channels: Channels = { invoke: [], send: [], sendSync: [], events: [] };
  private rendererRoot = "";
  private index = "";
  private scripts: string[] = [];
  private boundPort = 0;

  constructor(private readonly options: BrowserHubOptions) {
    this.server.on("connection", socket => {
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    });
  }

  get port(): number { return this.boundPort; }

  async start(): Promise<void> {
    this.rendererRoot = await realpath(this.options.rendererDir);
    this.channels = JSON.parse(await readFile(join(this.rendererRoot, "browser-channels.json"), "utf8")) as Channels;
    const source = await readFile(join(this.rendererRoot, "index.html"), "utf8");
    this.index = source.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_tag, url: string) => {
      this.scripts.push(url); return "";
    }).replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i, "");
    if (!this.scripts.includes("renderer.js")) throw new Error("The GUI renderer script is missing");
    await new Promise<void>((resolveReady, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") { reject(new Error("Hub has no TCP address")); return; }
        this.boundPort = address.port; resolveReady();
      });
    });
  }

  broadcast(channel: string, payload: unknown): void {
    if (!this.channels.events.includes(channel)) return;
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const response of this.subscribers) {
      if (response.writableLength > 1024 * 1024) response.destroy();
      else response.write(frame);
    }
  }

  async close(): Promise<void> {
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done, reject) => this.server.close(error => error ? reject(error) : done()));
  }

  private authenticated(req: IncomingMessage): boolean {
    const cookie = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("atomic_hub="));
    return sameSecret(cookie?.slice("atomic_hub=".length), this.token);
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return !origin || origin === this.options.origin || origin === `http://127.0.0.1:${this.boundPort}`;
  }

  private setSession(res: ServerResponse): void {
    res.setHeader("Set-Cookie", `atomic_hub=${this.token}; HttpOnly; SameSite=Strict; Path=/${this.options.origin.startsWith("https:") ? "; Secure" : ""}`);
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowedHosts = [new URL(this.options.origin).host, `127.0.0.1:${this.boundPort}`];
    if (!req.headers.host || !allowedHosts.includes(req.headers.host)) {
      json(res, 403, { error: "This host cannot access the hub" }); return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const bootstrap = JSON.stringify({
        token: this.token, platform: this.options.platform, freshAtBoot: this.options.freshAtBoot,
        queues: this.options.queues(), scripts: this.scripts, stopVersion: this.options.stopVersion?.() ?? 0,
      }).replace(/</g, "\\u003c");
      const document = this.index.replace("</head>", '<link rel="stylesheet" href="browser.css"></head>')
        .replace("</body>", `<script id="atomic-hub-bootstrap" type="application/json">${bootstrap}</script><script type="module" src="browser-bridge.js"></script></body>`);
      this.setSession(res);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP,
        "Cache-Control": "no-store",
      });
      res.end(document); return;
    }
    if (url.pathname.startsWith("/hub/")) {
      if (!this.originAllowed(req)) { json(res, 403, { error: "This origin cannot access the hub" }); return; }
      if (req.method === "GET" && url.pathname === "/hub/connect") {
        this.setSession(res); json(res, 200, { token: this.token, stopVersion: this.options.stopVersion?.() ?? 0 }); return;
      }
      if (!this.authenticated(req)) { json(res, 403, { code: "session_expired", error: "Open the hub page to connect" }); return; }
      if (req.method === "GET" && url.pathname === "/hub/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.write(": connected\n\n"); this.subscribers.add(res);
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000); heartbeat.unref();
        res.once("close", () => { clearInterval(heartbeat); this.subscribers.delete(res); }); return;
      }
      if (req.method === "POST" && url.pathname === "/hub/rpc") {
        const header = req.headers["x-atomic-hub-token"];
        if (!sameSecret(typeof header === "string" ? header : undefined, this.token)) { json(res, 403, { code: "session_expired", error: "Invalid hub session" }); return; }
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) { json(res, 415, { error: "Expected JSON" }); return; }
        const value = await body(req);
        if (!value || typeof value !== "object" || Array.isArray(value)) { json(res, 400, { error: "Invalid application request" }); return; }
        const { kind, channel, args } = value as Record<string, unknown>;
        if ((kind !== "invoke" && kind !== "send") || typeof channel !== "string" || !Array.isArray(args)) { json(res, 400, { error: "Invalid application request" }); return; }
        if (!this.channels[kind].includes(channel)) { json(res, 403, { error: "Application method is not exposed to the GUI" }); return; }
        json(res, 200, { value: await this.options.call(kind, channel, args) ?? null }); return;
      }
      if (req.method === "GET" && url.pathname === "/hub/file") {
        const path = url.searchParams.get("path");
        if (!path || !isAbsolute(path)) { json(res, 400, { error: "An absolute file path is required" }); return; }
        const target = await realpath(path);
        const roots = await Promise.all(this.options.downloadRoots().map(root => realpath(root)));
        if (!roots.some(root => inside(target, root))) { json(res, 403, { error: "Choose a file in your home or workspace" }); return; }
        const info = await stat(target);
        if (!info.isFile()) { json(res, 400, { error: "Only files can be downloaded" }); return; }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
        });
        createReadStream(target).once("error", () => res.destroy()).pipe(res); return;
      }
      json(res, 404, { error: "Unknown hub route" }); return;
    }
    if (req.method !== "GET") { json(res, 405, { error: "Method not allowed" }); return; }
    const file = resolve(this.rendererRoot, "." + decodeURIComponent(url.pathname));
    if (!inside(file, this.rendererRoot) || !MIME[extname(file)]) { json(res, 404, { error: "Not found" }); return; }
    try {
      const canonical = await realpath(file);
      if (!inside(canonical, this.rendererRoot)) { json(res, 404, { error: "Not found" }); return; }
      const bytes = await readFile(canonical);
      res.writeHead(200, { "Content-Type": MIME[extname(file)]!, "Cache-Control": "no-cache" }); res.end(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { json(res, 404, { error: "Not found" }); return; }
      throw error;
    }
  }
}
