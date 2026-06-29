/**
 * Unit tests for pi-socket-bridge
 *
 * Tests cover:
 *   - JSON-RPC framing helpers (rpcOk, rpcErr, rpcNotify)
 *   - handleRequest router: every method group
 *   - Error paths: no ctx, unknown method, thrown error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleRequest,
  rpcOk,
  rpcErr,
  rpcNotify,
} from "../src/extension.ts";
import type { JsonRpcRequest, Connection } from "../src/extension.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(line: string) {
  return JSON.parse(line.trimEnd());
}

function makeReq(method: string, params: Record<string, unknown> = {}, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function makeConn(): Connection {
  return {
    socket: {} as any,
    subscriptions: new Set(),
    write: vi.fn(),
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/home/user/project",
    mode: "tui",
    isIdle: vi.fn().mockReturnValue(true),
    abort: vi.fn(),
    shutdown: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockReturnValue({ tokens: 1000, maxTokens: 200000 }),
    getSystemPrompt: vi.fn().mockReturnValue("You are a helpful assistant."),
    compact: vi.fn(),
    navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue("/home/user/.pi/sessions/abc.jsonl"),
      getEntries: vi.fn().mockReturnValue([{ id: "e1", type: "message" }]),
      getBranch: vi.fn().mockReturnValue([{ id: "e1", type: "message" }]),
    },
    modelRegistry: {
      find: vi.fn().mockReturnValue({ id: "claude-opus-4-5", provider: "anthropic" }),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setEditorText: vi.fn(),
      setTitle: vi.fn(),
    },
    ...overrides,
  };
}

function makePi(overrides: Record<string, unknown> = {}) {
  return {
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue(["read", "bash"]),
    getAllTools: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
    setActiveTools: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("medium"),
    setThinkingLevel: vi.fn(),
    setLabel: vi.fn(),
    appendEntry: vi.fn(),
    ...overrides,
  };
}

// ── Framing ───────────────────────────────────────────────────────────────────

describe("rpcOk", () => {
  it("serialises result with correct jsonrpc version", () => {
    const line = rpcOk(1, { ok: true });
    const msg = parse(line);
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(1);
    expect(msg.result).toEqual({ ok: true });
    expect("error" in msg).toBe(false);
  });

  it("ends with newline", () => {
    expect(rpcOk(1, {}).endsWith("\n")).toBe(true);
  });

  it("uses null for undefined id", () => {
    expect(parse(rpcOk(undefined, {})).id).toBeNull();
  });
});

describe("rpcErr", () => {
  it("serialises error with code and message", () => {
    const msg = parse(rpcErr(2, -32601, "Method not found"));
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(2);
    expect(msg.error).toEqual({ code: -32601, message: "Method not found" });
    expect("result" in msg).toBe(false);
  });

  it("ends with newline", () => {
    expect(rpcErr(1, -32600, "err").endsWith("\n")).toBe(true);
  });
});

describe("rpcNotify", () => {
  it("serialises notification with no id", () => {
    const msg = parse(rpcNotify("agent_end", { sessionId: "abc" }));
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.method).toBe("agent_end");
    expect(msg.params).toEqual({ sessionId: "abc" });
    expect("id" in msg).toBe(false);
  });

  it("ends with newline", () => {
    expect(rpcNotify("ping", {}).endsWith("\n")).toBe(true);
  });
});

// ── Router: messaging ─────────────────────────────────────────────────────────

describe("handleRequest — messaging", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;
  let conn: Connection;

  beforeEach(() => {
    pi = makePi();
    ctx = makeCtx();
    conn = makeConn();
  });

  it("follow_up calls sendUserMessage with deliverAs followUp", async () => {
    const res = parse(await handleRequest(
      makeReq("follow_up", { text: "Job done" }), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Job done", { deliverAs: "followUp" });
    expect(res.result.ok).toBe(true);
    expect(res.result.sessionId).toBe("sess1");
  });

  it("steer calls sendUserMessage with deliverAs steer", async () => {
    const res = parse(await handleRequest(
      makeReq("steer", { text: "Stop now" }), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Stop now", { deliverAs: "steer" });
    expect(res.result.ok).toBe(true);
  });

  it("send_user_message passes deliverAs through", async () => {
    await handleRequest(
      makeReq("send_user_message", { text: "Hi", deliverAs: "nextTurn" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Hi", { deliverAs: "nextTurn" });
  });

  it("send_user_message omits deliverAs when not provided", async () => {
    await handleRequest(
      makeReq("send_user_message", { text: "Hi" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Hi", undefined);
  });

  it("send_message delegates to pi.sendMessage", async () => {
    const res = parse(await handleRequest(
      makeReq("send_message", { customType: "my-type", content: "hello", triggerTurn: true }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "my-type", content: "hello", display: true },
      { triggerTurn: true, deliverAs: undefined }
    );
    expect(res.result.ok).toBe(true);
  });
});

// ── Router: UI ────────────────────────────────────────────────────────────────

describe("handleRequest — UI", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;
  let conn: Connection;

  beforeEach(() => {
    pi = makePi();
    ctx = makeCtx();
    conn = makeConn();
  });

  it("notify calls ctx.ui.notify with level", async () => {
    const res = parse(await handleRequest(
      makeReq("notify", { text: "Hello", level: "warning" }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Hello", "warning");
    expect(res.result.ok).toBe(true);
  });

  it("notify defaults level to info", async () => {
    await handleRequest(
      makeReq("notify", { text: "Hello" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Hello", "info");
  });

  it("set_status calls ctx.ui.setStatus", async () => {
    await handleRequest(
      makeReq("set_status", { key: "mykey", text: "processing" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("mykey", "processing");
  });

  it("set_widget calls ctx.ui.setWidget", async () => {
    await handleRequest(
      makeReq("set_widget", { key: "w1", lines: ["line1", "line2"] }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("w1", ["line1", "line2"]);
  });

  it("set_editor_text calls ctx.ui.setEditorText", async () => {
    await handleRequest(
      makeReq("set_editor_text", { text: "draft" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("draft");
  });

  it("set_title calls ctx.ui.setTitle", async () => {
    await handleRequest(
      makeReq("set_title", { title: "My Session" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(ctx.ui.setTitle).toHaveBeenCalledWith("My Session");
  });

  it("notify returns error when no ctx", async () => {
    const res = parse(await handleRequest(
      makeReq("notify", { text: "Hi" }),
      conn, pi as any, () => undefined, "sess1"
    ));
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toMatch(/No session context/);
  });
});

// ── Router: session info ──────────────────────────────────────────────────────

describe("handleRequest — session info", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;
  let conn: Connection;

  beforeEach(() => {
    pi = makePi();
    ctx = makeCtx();
    conn = makeConn();
  });

  it("ping returns session metadata", async () => {
    const res = parse(await handleRequest(
      makeReq("ping"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result.sessionId).toBe("sess1");
    expect(res.result.cwd).toBe("/home/user/project");
    expect(res.result.mode).toBe("tui");
    expect(res.result.isStreaming).toBe(false); // isIdle returns true
    expect(res.result.hasPendingMessages).toBe(false);
  });

  it("get_state includes messageCount, thinkingLevel, activeTools", async () => {
    const res = parse(await handleRequest(
      makeReq("get_state"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result.messageCount).toBe(1);
    expect(res.result.thinkingLevel).toBe("medium");
    expect(res.result.activeTools).toEqual(["read", "bash"]);
  });

  it("get_context_usage returns usage object", async () => {
    const res = parse(await handleRequest(
      makeReq("get_context_usage"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result).toEqual({ tokens: 1000, maxTokens: 200000 });
  });

  it("get_system_prompt returns prompt string", async () => {
    const res = parse(await handleRequest(
      makeReq("get_system_prompt"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result.prompt).toBe("You are a helpful assistant.");
  });

  it("get_active_tools returns tool names", async () => {
    const res = parse(await handleRequest(
      makeReq("get_active_tools"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result).toEqual(["read", "bash"]);
  });

  it("get_all_tools returns tool metadata", async () => {
    const res = parse(await handleRequest(
      makeReq("get_all_tools"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result).toEqual([{ name: "read" }, { name: "bash" }]);
  });

  it("get_entries returns session entries", async () => {
    const res = parse(await handleRequest(
      makeReq("get_entries"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result).toEqual([{ id: "e1", type: "message" }]);
  });

  it("get_branch returns branch entries", async () => {
    const res = parse(await handleRequest(
      makeReq("get_branch"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result).toEqual([{ id: "e1", type: "message" }]);
  });
});

// ── Router: session control ───────────────────────────────────────────────────

describe("handleRequest — session control", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;
  let conn: Connection;

  beforeEach(() => {
    pi = makePi();
    ctx = makeCtx();
    conn = makeConn();
  });

  it("abort calls ctx.abort", async () => {
    const res = parse(await handleRequest(
      makeReq("abort"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.abort).toHaveBeenCalledOnce();
    expect(res.result.ok).toBe(true);
  });

  it("shutdown calls ctx.shutdown", async () => {
    const res = parse(await handleRequest(
      makeReq("shutdown"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    expect(res.result.ok).toBe(true);
  });

  it("set_active_tools calls pi.setActiveTools", async () => {
    const res = parse(await handleRequest(
      makeReq("set_active_tools", { names: ["read"] }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(res.result.ok).toBe(true);
  });

  it("set_thinking_level calls pi.setThinkingLevel", async () => {
    await handleRequest(
      makeReq("set_thinking_level", { level: "high" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("get_thinking_level returns current level", async () => {
    const res = parse(await handleRequest(
      makeReq("get_thinking_level"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.result.level).toBe("medium");
  });

  it("set_label calls pi.setLabel", async () => {
    await handleRequest(
      makeReq("set_label", { entryId: "e1", label: "checkpoint" }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(pi.setLabel).toHaveBeenCalledWith("e1", "checkpoint");
  });

  it("append_entry calls pi.appendEntry", async () => {
    await handleRequest(
      makeReq("append_entry", { customType: "my-state", data: { count: 1 } }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(pi.appendEntry).toHaveBeenCalledWith("my-state", { count: 1 });
  });

  it("set_model calls pi.setModel with resolved model", async () => {
    const res = parse(await handleRequest(
      makeReq("set_model", { provider: "anthropic", modelId: "claude-opus-4-5" }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-opus-4-5");
    expect(pi.setModel).toHaveBeenCalled();
    expect(res.result.ok).toBe(true);
  });

  it("set_model returns error when model not found", async () => {
    ctx.modelRegistry.find = vi.fn().mockReturnValue(null);
    const res = parse(await handleRequest(
      makeReq("set_model", { provider: "anthropic", modelId: "unknown" }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toMatch(/Model not found/);
  });

  it("compact calls waitForIdle then ctx.compact", async () => {
    const res = parse(await handleRequest(
      makeReq("compact", { customInstructions: "focus on changes" }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.waitForIdle).toHaveBeenCalledOnce();
    expect(ctx.compact).toHaveBeenCalledWith({ customInstructions: "focus on changes" });
    expect(res.result.ok).toBe(true);
  });

  it("wait_for_idle resolves when agent is idle", async () => {
    const res = parse(await handleRequest(
      makeReq("wait_for_idle"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.waitForIdle).toHaveBeenCalledOnce();
    expect(res.result.idle).toBe(true);
  });

  it("navigate_tree calls waitForIdle then ctx.navigateTree", async () => {
    const res = parse(await handleRequest(
      makeReq("navigate_tree", { targetId: "e1" }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(ctx.waitForIdle).toHaveBeenCalledOnce();
    expect(ctx.navigateTree).toHaveBeenCalledWith("e1", undefined);
    expect(res.result).toEqual({ cancelled: false });
  });
});

// ── Router: subscriptions ─────────────────────────────────────────────────────

describe("handleRequest — subscriptions", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;
  let conn: Connection;

  beforeEach(() => {
    pi = makePi();
    ctx = makeCtx();
    conn = makeConn();
  });

  it("subscribe adds events to connection subscriptions", async () => {
    const res = parse(await handleRequest(
      makeReq("subscribe", { events: ["agent_end", "turn_start"] }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(conn.subscriptions.has("agent_end")).toBe(true);
    expect(conn.subscriptions.has("turn_start")).toBe(true);
    expect(res.result.subscribed).toContain("agent_end");
    expect(res.result.subscribed).toContain("turn_start");
  });

  it("subscribe accumulates across calls", async () => {
    await handleRequest(
      makeReq("subscribe", { events: ["agent_end"] }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    await handleRequest(
      makeReq("subscribe", { events: ["turn_start"] }),
      conn, pi as any, () => ctx as any, "sess1"
    );
    expect(conn.subscriptions.size).toBe(2);
  });

  it("unsubscribe removes events from connection subscriptions", async () => {
    conn.subscriptions.add("agent_end");
    conn.subscriptions.add("turn_start");
    const res = parse(await handleRequest(
      makeReq("unsubscribe", { events: ["agent_end"] }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(conn.subscriptions.has("agent_end")).toBe(false);
    expect(conn.subscriptions.has("turn_start")).toBe(true);
    expect(res.result.subscribed).not.toContain("agent_end");
  });
});

// ── Router: error paths ───────────────────────────────────────────────────────

describe("handleRequest — error paths", () => {
  let pi: ReturnType<typeof makePi>;
  let conn: Connection;

  beforeEach(() => {
    pi = makePi();
    conn = makeConn();
  });

  it("unknown method returns -32601", async () => {
    const res = parse(await handleRequest(
      makeReq("does_not_exist"), conn, pi as any, () => undefined, "sess1"
    ));
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toMatch(/Method not found/);
  });

  it("ctx-requiring method with no ctx returns -32603", async () => {
    const methods = ["ping", "get_state", "abort", "shutdown", "notify",
      "set_status", "set_widget", "set_editor_text", "set_title",
      "get_context_usage", "get_system_prompt", "get_entries", "get_branch"];

    for (const method of methods) {
      const res = parse(await handleRequest(
        makeReq(method, { text: "x", key: "k", lines: [], title: "t" }),
        conn, pi as any, () => undefined, "sess1"
      ));
      expect(res.error.code, `${method} should return -32603`).toBe(-32603);
    }
  });

  it("preserves request id in error response", async () => {
    const res = parse(await handleRequest(
      makeReq("does_not_exist", {}, 42), conn, pi as any, () => undefined, "sess1"
    ));
    expect(res.id).toBe(42);
  });

  it("caught exception returns -32603 with message", async () => {
    const ctx = makeCtx({
      abort: vi.fn().mockImplementation(() => { throw new Error("abort failed"); }),
    });
    const res = parse(await handleRequest(
      makeReq("abort"), conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toBe("abort failed");
  });

  it("wait_for_idle times out and returns error", async () => {
    const ctx = makeCtx({
      waitForIdle: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const res = parse(await handleRequest(
      makeReq("wait_for_idle", { timeoutMs: 10 }),
      conn, pi as any, () => ctx as any, "sess1"
    ));
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toMatch(/timeout/i);
  }, 2000);
});
