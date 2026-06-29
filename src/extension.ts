/**
 * pi-socket-bridge
 *
 * Exposes the full ExtensionAPI/ExtensionContext over a per-session Unix
 * domain socket using JSON-RPC 2.0. External processes (shell scripts,
 * Python DAGs, background agents) can call into a running pi session.
 *
 * Socket:   ~/.pi/bridge/<sessionId>.sock
 * Registry: ~/.pi/bridge/registry.json
 * Latest:   ~/.pi/bridge/latest.sock (symlink → most recent session)
 *
 * See: https://git-personal/fsabado/pi-socket-bridge
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Constants ─────────────────────────────────────────────────────────────────

const REGISTRY_DIR = path.join(os.homedir(), ".pi", "bridge");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "registry.json");
const SOCK_DIR = path.join("/tmp", "pi-bridge");
const LATEST_SOCK = path.join(SOCK_DIR, "latest.sock");
const WAIT_IDLE_TIMEOUT_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface RegistryEntry {
  socket: string;
  name?: string;
  cwd?: string;
  started: string;
}

interface Registry {
  [sessionId: string]: RegistryEntry;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ── Process-level singleton (survives /reload) ────────────────────────────────

const BRIDGE_KEY = "__pi_socket_bridge__";

interface BridgeState {
  generation: number;
  server?: net.Server;
  sessionId?: string;
  socketPath?: string;
}

function getState(): BridgeState {
  if (!(process as any)[BRIDGE_KEY]) {
    (process as any)[BRIDGE_KEY] = { generation: 0 };
  }
  return (process as any)[BRIDGE_KEY];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safe<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: any[]) => {
    try {
      const r = fn(...args);
      if (r instanceof Promise) return r.catch((e) => console.error("[pi-socket-bridge]", e));
      return r;
    } catch (e) {
      console.error("[pi-socket-bridge]", e);
    }
  }) as T;
}

function rpcOk(id: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }) + "\n";
}

function rpcErr(id: number | string | null | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) + "\n";
}

function rpcNotify(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

// ── Registry ──────────────────────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
}

function loadRegistry(): Registry {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeRegistry(reg: Registry) {
  const tmp = REGISTRY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}

function registerSession(sessionId: string, socketPath: string, ctx: ExtensionContext) {
  const reg = loadRegistry();
  // Clean stale entries
  for (const [id, entry] of Object.entries(reg)) {
    if (!fs.existsSync(entry.socket)) delete reg[id];
  }
  reg[sessionId] = {
    socket: socketPath,
    cwd: ctx.cwd,
    started: new Date().toISOString(),
  };
  writeRegistry(reg);
  // Update latest symlink
  try { fs.unlinkSync(LATEST_SOCK); } catch {}
  fs.symlinkSync(socketPath, LATEST_SOCK);
}

function unregisterSession(sessionId: string) {
  const reg = loadRegistry();
  delete reg[sessionId];
  writeRegistry(reg);
}

// ── Connection set (per session, multiple clients) ────────────────────────────

interface Connection {
  socket: net.Socket;
  subscriptions: Set<string>;
  write(data: string): void;
}

// ── JSON-RPC router ───────────────────────────────────────────────────────────

async function handleRequest(
  req: JsonRpcRequest,
  conn: Connection,
  pi: ExtensionAPI,
  getCachedCtx: () => ExtensionContext | undefined,
  sessionId: string,
): Promise<string> {
  const { id, method, params = {} } = req;
  const ctx = getCachedCtx();

  // waitForIdle helper — used by methods that need idle state
  const waitIdle = async (timeoutMs = WAIT_IDLE_TIMEOUT_MS) => {
    if (!ctx) throw new Error("No session context");
    await Promise.race([
      ctx.waitForIdle(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("waitForIdle timeout")), timeoutMs)
      ),
    ]);
  };

  try {
    switch (method) {

      // ── Messaging ──────────────────────────────────────────────────────────

      case "send_user_message": {
        const { text, deliverAs } = params as { text: string; deliverAs?: string };
        pi.sendUserMessage(text, deliverAs ? { deliverAs: deliverAs as any } : undefined);
        return rpcOk(id, { ok: true, sessionId });
      }

      case "send_message": {
        const { customType, content, display, triggerTurn, deliverAs } = params as any;
        pi.sendMessage({ customType, content, display: display ?? true }, { triggerTurn, deliverAs });
        return rpcOk(id, { ok: true, sessionId });
      }

      case "follow_up": {
        const { text } = params as { text: string };
        pi.sendUserMessage(text, { deliverAs: "followUp" });
        return rpcOk(id, { ok: true, sessionId });
      }

      case "steer": {
        const { text } = params as { text: string };
        pi.sendUserMessage(text, { deliverAs: "steer" });
        return rpcOk(id, { ok: true, sessionId });
      }

      // ── UI ─────────────────────────────────────────────────────────────────

      case "notify": {
        if (!ctx) throw new Error("No session context");
        const { text, level } = params as { text: string; level?: string };
        ctx.ui.notify(text, (level as any) ?? "info");
        return rpcOk(id, { ok: true });
      }

      case "set_status": {
        if (!ctx) throw new Error("No session context");
        const { key, text } = params as { key: string; text: string };
        ctx.ui.setStatus(key, text);
        return rpcOk(id, { ok: true });
      }

      case "set_widget": {
        if (!ctx) throw new Error("No session context");
        const { key, lines } = params as { key: string; lines: string[] };
        ctx.ui.setWidget(key, lines);
        return rpcOk(id, { ok: true });
      }

      case "set_editor_text": {
        if (!ctx) throw new Error("No session context");
        const { text } = params as { text: string };
        ctx.ui.setEditorText(text);
        return rpcOk(id, { ok: true });
      }

      case "set_title": {
        if (!ctx) throw new Error("No session context");
        const { title } = params as { title: string };
        ctx.ui.setTitle(title);
        return rpcOk(id, { ok: true });
      }

      // ── Session info ───────────────────────────────────────────────────────

      case "ping": {
        if (!ctx) throw new Error("No session context");
        return rpcOk(id, {
          sessionId,
          sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
          isStreaming: !ctx.isIdle(),
          hasPendingMessages: ctx.hasPendingMessages(),
          cwd: ctx.cwd,
          mode: ctx.mode,
        });
      }

      case "get_state": {
        if (!ctx) throw new Error("No session context");
        return rpcOk(id, {
          sessionId,
          sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
          isStreaming: !ctx.isIdle(),
          hasPendingMessages: ctx.hasPendingMessages(),
          cwd: ctx.cwd,
          mode: ctx.mode,
          messageCount: ctx.sessionManager.getEntries().length,
          thinkingLevel: pi.getThinkingLevel(),
          activeTools: pi.getActiveTools(),
        });
      }

      case "get_context_usage": {
        if (!ctx) throw new Error("No session context");
        return rpcOk(id, ctx.getContextUsage() ?? null);
      }

      case "get_system_prompt": {
        if (!ctx) throw new Error("No session context");
        return rpcOk(id, { prompt: ctx.getSystemPrompt() });
      }

      case "get_active_tools":
        return rpcOk(id, pi.getActiveTools());

      case "get_all_tools":
        return rpcOk(id, pi.getAllTools());

      case "get_entries": {
        if (!ctx) throw new Error("No session context");
        return rpcOk(id, ctx.sessionManager.getEntries());
      }

      case "get_branch": {
        if (!ctx) throw new Error("No session context");
        return rpcOk(id, ctx.sessionManager.getBranch());
      }

      case "list_sessions":
        return rpcOk(id, loadRegistry());

      // ── Session control ────────────────────────────────────────────────────

      case "abort": {
        if (!ctx) throw new Error("No session context");
        ctx.abort();
        return rpcOk(id, { ok: true });
      }

      case "compact": {
        if (!ctx) throw new Error("No session context");
        await waitIdle(params.waitTimeoutMs as number | undefined);
        const { customInstructions } = params as { customInstructions?: string };
        ctx.compact({ customInstructions });
        return rpcOk(id, { ok: true });
      }

      case "set_active_tools": {
        const { names } = params as { names: string[] };
        pi.setActiveTools(names);
        return rpcOk(id, { ok: true });
      }

      case "set_model": {
        if (!ctx) throw new Error("No session context");
        const { provider, modelId } = params as { provider: string; modelId: string };
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        const ok2 = await (pi as any).setModel(model);
        return rpcOk(id, { ok: ok2 ?? true });
      }

      case "set_thinking_level": {
        const { level } = params as { level: string };
        (pi as any).setThinkingLevel(level);
        return rpcOk(id, { ok: true });
      }

      case "get_thinking_level":
        return rpcOk(id, { level: (pi as any).getThinkingLevel() });

      case "set_label": {
        const { entryId, label } = params as { entryId: string; label?: string };
        pi.setLabel(entryId, label);
        return rpcOk(id, { ok: true });
      }

      case "append_entry": {
        const { customType, data } = params as { customType: string; data?: unknown };
        pi.appendEntry(customType, data);
        return rpcOk(id, { ok: true });
      }

      case "shutdown": {
        if (!ctx) throw new Error("No session context");
        ctx.shutdown();
        return rpcOk(id, { ok: true });
      }

      case "wait_for_idle": {
        const timeoutMs = (params.timeoutMs as number | undefined) ?? WAIT_IDLE_TIMEOUT_MS;
        await waitIdle(timeoutMs);
        return rpcOk(id, { ok: true, idle: true });
      }

      case "navigate_tree": {
        if (!ctx) throw new Error("No session context");
        await waitIdle(params.waitTimeoutMs as number | undefined);
        const { targetId, options } = params as { targetId: string; options?: any };
        const result = await ctx.navigateTree(targetId, options);
        return rpcOk(id, result);
      }

      // ── Subscriptions ──────────────────────────────────────────────────────

      case "subscribe": {
        const { events } = params as { events: string[] };
        for (const e of events) conn.subscriptions.add(e);
        return rpcOk(id, { ok: true, subscribed: [...conn.subscriptions] });
      }

      case "unsubscribe": {
        const { events } = params as { events: string[] };
        for (const e of events) conn.subscriptions.delete(e);
        return rpcOk(id, { ok: true, subscribed: [...conn.subscriptions] });
      }

      default:
        return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return rpcErr(id, -32603, e?.message ?? String(e));
  }
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const state = getState();

  // Tear down previous server (survives /reload)
  state.server?.close();
  state.server = undefined;

  const generation = ++state.generation;
  const isActive = () => getState().generation === generation;

  let cachedCtx: ExtensionContext | undefined;
  let sessionReady = false;
  let sessionId = "";

  // Active connections for this session — fan-out notifications
  const connections = new Set<Connection>();

  function broadcast(eventType: string, data: unknown) {
    if (!sessionReady) return;
    const msg = rpcNotify(eventType, { sessionId, ...(data as object ?? {}) });
    for (const conn of connections) {
      if (conn.subscriptions.has(eventType)) conn.write(msg);
    }
  }

  // ── Socket server ────────────────────────────────────────────────────────

  function startServer(sid: string) {
    ensureDirs();
    const sockPath = path.join(SOCK_DIR, `${sid}.sock`);

    // Remove stale socket file if present
    try { fs.unlinkSync(sockPath); } catch {}

    const server = net.createServer((sock) => {
      const conn: Connection = {
        socket: sock,
        subscriptions: new Set(),
        write: (data) => { try { sock.write(data); } catch {} },
      };
      connections.add(conn);

      let buf = "";
      sock.on("data", safe(async (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let req: JsonRpcRequest;
          try {
            req = JSON.parse(line);
          } catch {
            conn.write(rpcErr(null, -32700, "Parse error"));
            continue;
          }
          if (!sessionReady) {
            conn.write(rpcErr(req.id, -32603, "Session not ready"));
            continue;
          }
          const response = await handleRequest(req, conn, pi, () => cachedCtx, sessionId);
          conn.write(response);
        }
      }));

      sock.on("close", () => connections.delete(conn));
      sock.on("error", () => connections.delete(conn));
    });

    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch {}
    });

    server.on("error", (e) => console.error("[pi-socket-bridge] server error:", e));

    state.server = server;
    state.sessionId = sid;
    state.socketPath = sockPath;

    return sockPath;
  }

  function stopServer() {
    state.server?.close();
    state.server = undefined;
    if (state.socketPath) {
      try { fs.unlinkSync(state.socketPath); } catch {}
    }
  }

  // ── Event forwarding ─────────────────────────────────────────────────────

  const forwardEvents = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_call", "tool_execution_start", "tool_execution_end", "tool_result",
    "model_select", "thinking_level_select",
    "session_start", "session_shutdown",
    "session_before_switch", "session_before_compact",
    "before_agent_start",
  ] as const;

  for (const eventType of forwardEvents) {
    pi.on(eventType as any, safe(async (event: any, ctx: any) => {
      if (!isActive()) return;
      cachedCtx = ctx;
      broadcast(eventType, event ?? {});
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pi.on("session_start", safe(async (event: any, ctx: any) => {
    if (!isActive()) return;
    cachedCtx = ctx;

    sessionId = ctx.sessionManager.getSessionId?.() ?? crypto.randomUUID();

    // Stop old server if session changed (new/fork/resume)
    stopServer();
    connections.clear();

    const sockPath = startServer(sessionId);
    registerSession(sessionId, sockPath, ctx);
    sessionReady = true;

    ctx.ui.setStatus("pi-socket-bridge", `bridge: ${sockPath.replace(os.homedir(), "~")}`);
  }));

  pi.on("session_shutdown", safe(async () => {
    if (!isActive()) return;
    sessionReady = false;
    stopServer();
    if (sessionId) unregisterSession(sessionId);
    // Close all connections
    for (const conn of connections) conn.socket.destroy();
    connections.clear();
  }));
}
