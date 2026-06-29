# pi-socket-client Reference

CLI companion for `pi-socket-bridge`. Connects to a running pi session over a Unix domain socket and sends JSON-RPC 2.0 requests.

## Synopsis

```
pi-socket-client [--session <id|latest>] <command> [args] [flags]
```

## Global Flags

| Flag | Default | Description |
|---|---|---|
| `--session <id>` | `latest` | Target session. Accepts full session ID, prefix, or `latest` |

Session resolution order:
1. `latest` → follows `/tmp/pi-bridge/latest.sock` symlink
2. Full session ID → looks up `~/.pi/bridge/registry.json`
3. Prefix match → first registry entry whose ID starts with the value
4. Absolute path → used directly
5. Bare string → checks `/tmp/pi-bridge/<string>.sock`

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Method error (JSON-RPC error response from pi) |
| `2` | Connection error (session not found, socket gone, timeout) |

---

## Commands

### Discovery

#### `list` / `ls`

Show all sessions registered in `~/.pi/bridge/registry.json`. Marks stale entries (socket file missing) in red.

```bash
pi-socket-client list
```

Output columns: `SESSION ID` (12-char prefix) · `NAME` · `CWD` · `STARTED`

---

### Session Info

#### `ping`

Returns session metadata. Does not trigger an LLM turn.

```bash
pi-socket-client ping
```

Response fields: `sessionId` · `sessionFile` · `isStreaming` · `hasPendingMessages` · `cwd` · `mode`

#### `get-state` / `state`

Full session snapshot including tool list and thinking level.

```bash
pi-socket-client get-state
```

Response fields: everything from `ping` plus `messageCount` · `thinkingLevel` · `activeTools`

---

### Messaging

#### `follow-up <text>`

Inject a user message that is delivered **after the agent finishes its current turn**. Safe default for callbacks from background jobs.

```bash
pi-socket-client follow-up "Backfill done: 42 rows written"
pi-socket-client follow-up "DAG failed on task extract_raw — check logs"
```

Aliases: `followup`

#### `steer <text>`

Inject a user message **mid-turn** — delivered after the current tool calls finish, before the next LLM call. Use to redirect the agent without waiting.

```bash
pi-socket-client steer "Stop — exception in prod, fix auth.py first"
```

#### `notify <text>`

TUI toast notification only. **Does not trigger an LLM turn.**

```bash
pi-socket-client notify "Build finished"
pi-socket-client notify "Warning: partition missing" --level warning
pi-socket-client notify "Deploy failed" --level error
```

Flags:
- `--level info|warning|error|success` (default: `info`)

---

### Session Control

#### `abort`

Abort the agent's current operation immediately.

```bash
pi-socket-client abort
```

#### `compact [instructions]`

Trigger session compaction. Waits for the agent to be idle first (30s timeout).

```bash
pi-socket-client compact
pi-socket-client compact "Focus on the DAG changes we made"
```

#### `wait-idle`

Block until the agent is idle. Returns when the agent has no running turns or pending messages. Timeout: 120s.

```bash
pi-socket-client wait-idle
echo "Agent is idle, proceeding..."
```

#### `get-active-tools`

List currently active tool names.

```bash
pi-socket-client get-active-tools
```

#### `set-active-tools <names...>`

Replace the active tool set.

```bash
pi-socket-client set-active-tools read bash
pi-socket-client set-active-tools read write edit bash
```

#### `get-all-tools`

List all available tools with full metadata (name, description, parameters, source).

```bash
pi-socket-client get-all-tools
```

---

### Raw JSON-RPC

#### `call <method> [params-json]`

Send any JSON-RPC method directly. `params-json` is a JSON object string.

```bash
pi-socket-client call ping
pi-socket-client call follow_up '{"text":"Done"}'
pi-socket-client call set_model '{"provider":"anthropic","modelId":"claude-opus-4-5"}'
pi-socket-client call set_thinking_level '{"level":"high"}'
pi-socket-client call get_thinking_level
pi-socket-client call notify '{"text":"hello","level":"success"}'
pi-socket-client call set_status '{"key":"mykey","text":"processing..."}'
pi-socket-client call set_widget '{"key":"mykey","lines":["line 1","line 2"]}'
pi-socket-client call set_editor_text '{"text":"draft prompt here"}'
pi-socket-client call set_title '{"title":"my session"}'
pi-socket-client call set_label '{"entryId":"abc123","label":"checkpoint"}'
pi-socket-client call append_entry '{"customType":"my-state","data":{"count":42}}'
pi-socket-client call get_context_usage
pi-socket-client call get_system_prompt
pi-socket-client call get_entries
pi-socket-client call get_branch
pi-socket-client call list_sessions
pi-socket-client call navigate_tree '{"targetId":"entry-id-123"}'
pi-socket-client call wait_for_idle '{"timeoutMs":60000}'
pi-socket-client call shutdown
```

---

### Event Streaming (Persistent Connections)

#### `subscribe <events...>`

Open a persistent connection and stream matching events to stdout as JSON lines. Press Ctrl-C to exit.

```bash
pi-socket-client subscribe agent_end
pi-socket-client subscribe agent_start agent_end turn_start turn_end
pi-socket-client subscribe tool_call tool_execution_end
```

Each event arrives as a JSON-RPC notification:
```json
{"jsonrpc":"2.0","method":"agent_end","params":{"sessionId":"abc...","type":"agent_end"}}
```

#### `wait <event>`

Block until one instance of `event` fires, then exit `0`. Useful in scripts that need to synchronise with agent state.

```bash
pi-socket-client wait agent_end
pi-socket-client wait turn_end
```

---

## Full Method Reference

Methods available via `call`. All use JSON-RPC 2.0 over JSONL.

### Messaging

| Method | Params | Notes |
|---|---|---|
| `follow_up` | `text: string` | Deliver after agent is idle |
| `steer` | `text: string` | Deliver mid-turn |
| `send_user_message` | `text: string`, `deliverAs?: "steer"\|"followUp"\|"nextTurn"` | Full control |
| `send_message` | `customType: string`, `content: string`, `display?: bool`, `triggerTurn?: bool`, `deliverAs?: string` | Custom message (not user role) |

### UI

| Method | Params | Notes |
|---|---|---|
| `notify` | `text: string`, `level?: string` | Toast — no LLM turn |
| `set_status` | `key: string`, `text: string` | Footer status line |
| `set_widget` | `key: string`, `lines: string[]` | Widget above editor |
| `set_editor_text` | `text: string` | Prefill input box |
| `set_title` | `title: string` | Window/pane title |

### Session Info

| Method | Params | Returns |
|---|---|---|
| `ping` | — | sessionId, sessionFile, isStreaming, hasPendingMessages, cwd, mode |
| `get_state` | — | ping fields + messageCount, thinkingLevel, activeTools |
| `get_context_usage` | — | tokens, maxTokens (null if unavailable) |
| `get_system_prompt` | — | `{ prompt: string }` |
| `get_active_tools` | — | `string[]` |
| `get_all_tools` | — | Tool metadata array |
| `get_entries` | — | All session entries |
| `get_branch` | — | Current branch entries |
| `list_sessions` | — | Registry contents |

### Session Control

| Method | Params | Notes |
|---|---|---|
| `abort` | — | Abort current operation |
| `compact` | `customInstructions?: string`, `waitTimeoutMs?: number` | Waits for idle first |
| `set_active_tools` | `names: string[]` | Replace active tool set |
| `set_model` | `provider: string`, `modelId: string` | Switch model |
| `get_thinking_level` | — | Returns `{ level: string }` |
| `set_thinking_level` | `level: string` | `off`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh` |
| `set_label` | `entryId: string`, `label?: string` | Set or clear entry label |
| `append_entry` | `customType: string`, `data?: unknown` | Persist extension state |
| `shutdown` | — | Graceful pi exit |
| `wait_for_idle` | `timeoutMs?: number` | Default 30s |
| `navigate_tree` | `targetId: string`, `options?: object` | Waits for idle first |

### Subscriptions

| Method | Params | Notes |
|---|---|---|
| `subscribe` | `events: string[]` | Add to this connection's subscription set |
| `unsubscribe` | `events: string[]` | Remove from subscription set |

### Subscribable Events

```
agent_start          agent_end
turn_start           turn_end
message_start        message_update        message_end
tool_call            tool_execution_start  tool_execution_end  tool_result
model_select         thinking_level_select
session_start        session_shutdown
session_before_switch  session_before_compact
before_agent_start
```

---

## Socket Locations

```
/tmp/pi-bridge/<sessionId>.sock    per-session socket (auto-cleaned on reboot)
/tmp/pi-bridge/latest.sock         symlink → most recently started session
~/.pi/bridge/registry.json         session metadata (persists across reboots)
```

---

## Raw Usage Examples

### Shell — one-liner via `nc`

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"follow_up","params":{"text":"Done"}}' \
  | nc -U /tmp/pi-bridge/latest.sock
```

### Shell — wait for idle then inject

```bash
pi-socket-client steer "Stop and fix the import error"
pi-socket-client wait agent_end
pi-socket-client follow-up "Now run the tests"
```

### Python — in a DAG task

```python
import socket, json

def pi_follow_up(text: str, session: str = "latest") -> dict:
    if session == "latest":
        import os
        sock_path = os.readlink("/tmp/pi-bridge/latest.sock")
    else:
        sock_path = f"/tmp/pi-bridge/{session}.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(sock_path)
        s.sendall(json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "method": "follow_up",
            "params": {"text": text}
        }).encode() + b"\n")
        return json.loads(s.recv(4096))

pi_follow_up("Backfill complete: 3/3 tasks succeeded")
```

### Bash script — background job callback

```bash
#!/usr/bin/env bash
# Run long job, report result back to pi when done

run_my_job() { sleep 10 && echo "success"; }

result=$(run_my_job)
if [ "$result" = "success" ]; then
    pi-socket-client follow-up "Job finished successfully ✓"
else
    pi-socket-client steer "Job failed: $result — please investigate"
fi
```
