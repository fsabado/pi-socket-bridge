#!/usr/bin/env tsx
/**
 * pi-socket-client
 *
 * CLI companion for pi-socket-bridge. Connects to a running pi session's
 * Unix socket and sends JSON-RPC 2.0 requests.
 *
 * Usage:
 *   pi-socket-client list
 *   pi-socket-client ping
 *   pi-socket-client follow-up "Job done"
 *   pi-socket-client steer "Stop — exception in prod"
 *   pi-socket-client notify "Build finished" --level info
 *   pi-socket-client call <method> [params-json]
 *   pi-socket-client subscribe agent_end turn_start
 *   pi-socket-client wait agent_end
 *   pi-socket-client --session <id|latest> <command>
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

// ── Config ────────────────────────────────────────────────────────────────────

const REGISTRY_DIR = path.join(os.homedir(), ".pi", "bridge");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "registry.json");
const SOCK_DIR = "/tmp/pi-bridge";
const LATEST_SOCK = path.join(SOCK_DIR, "latest.sock");
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface RegistryEntry {
  socket: string;
  name?: string;
  cwd?: string;
  started?: string;
}

interface Registry {
  [sessionId: string]: RegistryEntry;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string; // notification
  params?: unknown; // notification
}

// ── Registry helpers ──────────────────────────────────────────────────────────

function loadRegistry(): Registry {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function resolveSocket(session: string): string {
  if (session === "latest") {
    // Follow symlink
    try {
      return fs.realpathSync(LATEST_SOCK);
    } catch {
      die("No active pi session (latest.sock missing). Is pi running with pi-socket-bridge loaded?");
    }
  }
  // Full path
  if (session.startsWith("/")) return session;
  // SessionId (full or prefix)
  const reg = loadRegistry();
  const match = Object.entries(reg).find(([id]) => id.startsWith(session));
  if (match) return match[1].socket;
  // Direct .sock path in sock dir
  const candidate = path.join(SOCK_DIR, session.endsWith(".sock") ? session : `${session}.sock`);
  if (fs.existsSync(candidate)) return candidate;
  die(`Session not found: ${session}`);
}

// ── Socket I/O ────────────────────────────────────────────────────────────────

function rpcCall(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params };
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const res: JsonRpcResponse = JSON.parse(buf.slice(0, nl));
        if (res.error) reject(new Error(`[${res.error.code}] ${res.error.message}`));
        else resolve(res.result);
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Open a persistent connection, subscribe to events, stream to stdout. */
function rpcSubscribe(
  socketPath: string,
  events: string[],
  onEvent: (notification: JsonRpcResponse) => void,
  onError: (e: Error) => void,
): net.Socket {
  const sock = net.createConnection(socketPath);
  const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "subscribe", params: { events } };
  let buf = "";

  sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
  });
  sock.on("error", onError);
  sock.on("close", () => onError(new Error("Connection closed")));
  return sock;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg: string, code = 2): never {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(code);
}

function ok(data: unknown) {
  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function parseParams(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    die(`Invalid JSON params: ${raw}`);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdList() {
  const reg = loadRegistry();
  const entries = Object.entries(reg);
  if (entries.length === 0) {
    console.log("No active pi sessions.");
    return;
  }
  console.log(`${"SESSION ID".padEnd(12)} ${"NAME".padEnd(24)} ${"CWD".padEnd(40)} STARTED`);
  console.log("─".repeat(100));
  for (const [id, entry] of entries) {
    const live = fs.existsSync(entry.socket) ? "" : " \x1b[31m[stale]\x1b[0m";
    const name = (entry.name ?? "—").padEnd(24);
    const cwd = (entry.cwd ?? "—").padEnd(40);
    const started = entry.started ? new Date(entry.started).toLocaleTimeString() : "—";
    console.log(`${id.slice(0, 12).padEnd(12)} ${name} ${cwd} ${started}${live}`);
  }
}

async function cmdCall(socketPath: string, method: string, paramsRaw?: string) {
  const params = parseParams(paramsRaw);
  try {
    const result = await rpcCall(socketPath, method, params);
    ok(result);
  } catch (e: any) {
    die(e.message, 1);
  }
}

async function cmdSubscribe(socketPath: string, events: string[]) {
  if (events.length === 0) die("Specify at least one event to subscribe to.");
  console.error(`Subscribing to: ${events.join(", ")} (Ctrl-C to exit)`);

  const sock = rpcSubscribe(
    socketPath,
    events,
    (notification) => {
      // Print subscription ack quietly, print events loudly
      if (notification.id === 1 && notification.result) return; // subscribe ack
      console.log(JSON.stringify(notification));
    },
    (e) => {
      console.error(`\x1b[31mDisconnected:\x1b[0m ${e.message}`);
      process.exit(2);
    },
  );

  process.on("SIGINT", () => { sock.destroy(); process.exit(0); });
  // Keep alive
  await new Promise(() => {});
}

async function cmdWait(socketPath: string, event: string) {
  console.error(`Waiting for: ${event}`);
  await new Promise<void>((resolve, reject) => {
    const sock = rpcSubscribe(
      socketPath,
      [event],
      (notification) => {
        if (notification.method === event) {
          sock.destroy();
          resolve();
        }
      },
      reject,
    );
  });
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function shift(): string | undefined { return args.shift(); }
function peek(): string | undefined { return args[0]; }
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  args.splice(i, 1);
  return args.splice(i, 1)[0];
}

const session = flag("--session") ?? "latest";
const socketPath = resolveSocket(session);

const command = shift();

switch (command) {
  case "list":
  case "ls":
    await cmdList();
    break;

  case "ping":
    await cmdCall(socketPath, "ping");
    break;

  case "get-state":
  case "state":
    await cmdCall(socketPath, "get_state");
    break;

  case "follow-up":
  case "followup": {
    const text = shift() ?? die("Usage: pi-socket-client follow-up <text>");
    await cmdCall(socketPath, "follow_up", JSON.stringify({ text }));
    break;
  }

  case "steer": {
    const text = shift() ?? die("Usage: pi-socket-client steer <text>");
    await cmdCall(socketPath, "steer", JSON.stringify({ text }));
    break;
  }

  case "notify": {
    const text = shift() ?? die("Usage: pi-socket-client notify <text> [--level info|warning|error|success]");
    const level = flag("--level") ?? "info";
    await cmdCall(socketPath, "notify", JSON.stringify({ text, level }));
    break;
  }

  case "abort":
    await cmdCall(socketPath, "abort");
    break;

  case "compact": {
    const customInstructions = shift();
    await cmdCall(socketPath, "compact", customInstructions ? JSON.stringify({ customInstructions }) : undefined);
    break;
  }

  case "wait-idle":
    await cmdCall(socketPath, "wait_for_idle", undefined, 120_000);
    console.log("Agent is idle.");
    break;

  case "call": {
    const method = shift() ?? die("Usage: pi-socket-client call <method> [params-json]");
    const paramsRaw = shift();
    await cmdCall(socketPath, method, paramsRaw);
    break;
  }

  case "subscribe":
    await cmdSubscribe(socketPath, args.splice(0));
    break;

  case "wait": {
    const event = shift() ?? die("Usage: pi-socket-client wait <event>");
    await cmdWait(socketPath, event);
    break;
  }

  case "set-active-tools": {
    const names = args.splice(0);
    if (names.length === 0) die("Usage: pi-socket-client set-active-tools read bash ...");
    await cmdCall(socketPath, "set_active_tools", JSON.stringify({ names }));
    break;
  }

  case "get-active-tools":
    await cmdCall(socketPath, "get_active_tools");
    break;

  case "get-all-tools":
    await cmdCall(socketPath, "get_all_tools");
    break;

  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(`
pi-socket-client — control a running pi session over Unix socket (JSON-RPC 2.0)

USAGE
  pi-socket-client [--session <id|latest>] <command> [args]

SESSION SELECTION
  --session latest       (default) most recently started session
  --session <id>         full or prefix-matched session ID
  --session <id>.sock    direct socket path

COMMANDS
  list                   show all active sessions
  ping                   session info (id, model, isStreaming, messageCount)
  get-state              full session state snapshot
  follow-up <text>       inject message after agent finishes current turn
  steer <text>           inject message mid-turn (interrupts)
  notify <text>          TUI toast notification (no LLM turn)
    --level info|warning|error|success
  abort                  abort current operation
  compact [instructions] trigger compaction
  wait-idle              block until agent is idle (120s timeout)
  call <method> [json]   raw JSON-RPC call
  subscribe <events...>  stream events to stdout (persistent)
  wait <event>           block until one event fires, then exit 0
  set-active-tools <names...>  enable tools by name
  get-active-tools       list currently active tool names
  get-all-tools          list all available tools with metadata

EXAMPLES
  pi-socket-client follow-up "Backfill done ✓"
  pi-socket-client steer "Stop — exception in prod"
  pi-socket-client notify "Build finished" --level info
  pi-socket-client wait agent_end
  pi-socket-client subscribe agent_start agent_end turn_start
  pi-socket-client --session abc123 ping
  pi-socket-client call set_model '{"provider":"anthropic","modelId":"claude-opus-4-5"}'
`.trim());
    break;

  default:
    die(`Unknown command: ${command}. Run 'pi-socket-client help' for usage.`);
}
