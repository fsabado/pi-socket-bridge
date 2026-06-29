# pi-socket-bridge

Pi extension that exposes the full `ExtensionAPI` / `ExtensionContext` over a per-session Unix domain socket using **JSON-RPC 2.0**.

External processes — shell scripts, Python DAGs, background agents — can call into a running pi session without any shared process or imports.

## Install

```bash
pi install git:git@git-personal:fsabado/pi-socket-bridge
```

After `/reload`, each pi session creates a socket at `/tmp/pi-bridge/<sessionId>.sock`.

## Socket layout

```
/tmp/pi-bridge/
  <sessionId>.sock      per-session Unix socket (mode 0600)
  latest.sock           symlink → most recently started session

~/.pi/bridge/
  registry.json         session metadata (id, name, cwd, started)
```

## CLI

```bash
# Discovery
pi-socket-client list

# One-shot (defaults to latest session)
pi-socket-client ping
pi-socket-client follow-up "Backfill done ✓"
pi-socket-client steer "Stop — exception in prod"
pi-socket-client notify "Build finished" --level info
pi-socket-client abort
pi-socket-client compact
pi-socket-client wait-idle

# Session selection
pi-socket-client --session <id|prefix> ping

# Raw JSON-RPC
pi-socket-client call set_model '{"provider":"anthropic","modelId":"claude-opus-4-5"}'

# Event streaming (persistent connection)
pi-socket-client subscribe agent_end turn_start
pi-socket-client wait agent_end    # blocks until one event fires, exit 0
```

## Protocol: JSON-RPC 2.0 over JSONL

One JSON object per `\n`. Works from any language.

**Request:**
```json
{"jsonrpc":"2.0","id":1,"method":"follow_up","params":{"text":"Job done"}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":1,"result":{"ok":true,"sessionId":"abc123..."}}
```

**Notification (server push):**
```json
{"jsonrpc":"2.0","method":"agent_end","params":{"sessionId":"abc123..."}}
```

## Methods

### Messaging
| Method | Params | Notes |
|---|---|---|
| `follow_up` | `text` | Delivers after agent finishes — safe default for callbacks |
| `steer` | `text` | Interrupts mid-turn |
| `send_user_message` | `text`, `deliverAs?` | `steer`\|`followUp`\|`nextTurn` |
| `send_message` | `customType`, `content`, `display?`, `triggerTurn?`, `deliverAs?` | Custom message |

### UI
| Method | Params |
|---|---|
| `notify` | `text`, `level?` (`info`\|`warning`\|`error`\|`success`) |
| `set_status` | `key`, `text` |
| `set_widget` | `key`, `lines[]` |
| `set_editor_text` | `text` |
| `set_title` | `title` |

### Session info
| Method | Returns |
|---|---|
| `ping` | sessionId, sessionFile, isStreaming, cwd, mode |
| `get_state` | Full snapshot inc. messageCount, thinkingLevel, activeTools |
| `get_context_usage` | tokens, maxTokens |
| `get_system_prompt` | Current system prompt string |
| `get_active_tools` | `string[]` |
| `get_all_tools` | Full tool metadata |
| `get_entries` | All session entries |
| `get_branch` | Current branch entries |
| `list_sessions` | Registry contents |

### Session control
| Method | Params | Notes |
|---|---|---|
| `abort` | — | Abort current operation |
| `compact` | `customInstructions?` | Waits for idle first |
| `set_active_tools` | `names[]` | |
| `set_model` | `provider`, `modelId` | |
| `set_thinking_level` | `level` | `off`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh` |
| `get_thinking_level` | — | |
| `set_label` | `entryId`, `label?` | |
| `append_entry` | `customType`, `data?` | |
| `shutdown` | — | Graceful pi exit |
| `wait_for_idle` | `timeoutMs?` | Block until agent idle (default 30s) |
| `navigate_tree` | `targetId`, `options?` | Waits for idle first |

### Subscriptions
| Method | Params |
|---|---|
| `subscribe` | `events[]` |
| `unsubscribe` | `events[]` |

**Subscribable events:** `agent_start` `agent_end` `turn_start` `turn_end` `message_start` `message_update` `message_end` `tool_call` `tool_execution_start` `tool_execution_end` `tool_result` `model_select` `thinking_level_select` `session_start` `session_shutdown` `before_agent_start`

## Shell examples

```bash
# Fire and forget via nc
echo '{"jsonrpc":"2.0","id":1,"method":"follow_up","params":{"text":"Done"}}' \
  | nc -U /tmp/pi-bridge/latest.sock

# Wait for agent to finish responding
pi-socket-client steer "Stop — fix the import error"
pi-socket-client wait agent_end

# In a Python DAG task
python3 -c "
import socket, json, pathlib
s = socket.socket(socket.AF_UNIX)
s.connect('/tmp/pi-bridge/latest.sock')
s.sendall(json.dumps({'jsonrpc':'2.0','id':1,'method':'follow_up',
  'params':{'text':'DAG complete: 42 rows written'}}).encode() + b'\n')
print(json.loads(s.recv(4096)))
"
```
