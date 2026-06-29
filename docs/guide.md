# Guide

`pi-socket-bridge` lets any external process — a shell script, a Python function, a background job — send messages into a running [pi](https://pi.dev) session over a Unix domain socket.

## How it works

When pi starts with this extension loaded, it creates a Unix socket at `/tmp/pi-bridge/<sessionId>.sock`. A symlink at `/tmp/pi-bridge/latest.sock` always points to the most recently started session. Session metadata (ID, cwd, start time) is written to `~/.pi/bridge/registry.json`.

The socket speaks [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over newline-delimited JSON. One request per line, one response per line. Any process that can write to a Unix socket can use it — `nc`, Python's `socket` module, Node.js `net`, anything.

### Connection modes

**One-shot** — connect, send one request, read one response, close. Use for fire-and-forget callbacks.

**Persistent** — keep the connection open after sending a `subscribe` request. The bridge streams matching pi events back as JSON-RPC notifications. Use when you need to wait for the agent to finish before taking the next step.

---

## Use cases

### 1. Background job callback

A long-running task notifies pi when it finishes.

```bash
# at the end of any script
pi-socket-client follow-up "Build finished: 3 targets compiled, 0 errors"
```

`follow-up` queues the message and delivers it only after the agent finishes its current turn. Safe to call at any time — pi will not interrupt itself.

If the job fails and you want pi to stop what it's doing and respond immediately:

```bash
pi-socket-client steer "Job failed: exit code 1 — check logs at /tmp/job.log"
```

### 2. Python task callback

```python
import socket, json, os

def pi_notify(text: str, method: str = "follow_up") -> None:
    sock_path = os.readlink("/tmp/pi-bridge/latest.sock")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(sock_path)
        s.sendall(json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "method": method,
            "params": {"text": text}
        }).encode() + b"\n")
        s.recv(4096)  # drain response

# call at the end of a DAG task, notebook cell, or script
pi_notify("Backfill complete: 1,204 rows written to hive.media.impressions")
```

### 3. Wait for pi to finish, then continue

Useful when orchestrating multi-step work from a second terminal or a herdr pane.

```bash
# send a task and block until pi finishes responding
pi-socket-client follow-up "Run the regression tests and summarise failures"
pi-socket-client wait agent_end

# pi has finished — now send the next task
pi-socket-client follow-up "Now open a PR with those fixes"
```

`wait agent_end` opens a persistent connection, subscribes to `agent_end`, and exits `0` when the event fires.

### 4. TUI notifications (no LLM turn)

Show a toast in pi's UI without triggering any model response. Useful for status updates from monitoring scripts.

```bash
pi-socket-client notify "Disk usage at 87%" --level warning
pi-socket-client notify "Deployment complete" --level success
```

---

## Multi-session

When multiple pi sessions are running, target a specific one with `--session`:

```bash
# list all live sessions
pi-socket-client list

# target by session ID prefix
pi-socket-client --session abc123 follow-up "Done"
```

The registry at `~/.pi/bridge/registry.json` maps session IDs to socket paths and cwds, so you can pick the right session by project directory.

---

## Raw JSON-RPC

For languages or tools where `pi-socket-client` is not available, speak the protocol directly.

**Request format:**
```json
{"jsonrpc":"2.0","id":1,"method":"follow_up","params":{"text":"Done"}}
```

**Response format:**
```json
{"jsonrpc":"2.0","id":1,"result":{"ok":true,"sessionId":"abc123..."}}
```

**Via `nc`:**
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"follow_up","params":{"text":"Done"}}' \
  | nc -U /tmp/pi-bridge/latest.sock
```

**Event subscription** (persistent connection):
```bash
# subscribe request
{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{"events":["agent_end","turn_start"]}}

# server streams back notifications as they fire
{"jsonrpc":"2.0","method":"agent_end","params":{"sessionId":"abc123..."}}
```

---

## Delivery modes

When injecting messages, the `deliverAs` parameter controls timing:

| Mode | Behaviour | Use when |
|---|---|---|
| `followUp` (default) | Queued — delivered after agent finishes all tool calls | Background job callbacks |
| `steer` | Delivered after current tool calls, before next LLM call | Redirecting the agent mid-task |
| `nextTurn` | Held until the user sends the next prompt | Pre-loading context |

`follow-up` and `steer` commands use `followUp` and `steer` respectively. Use `call send_user_message` with an explicit `deliverAs` for full control.

---

## Full method list

See [cli-reference.md](./cli-reference.md) for the complete method reference, all parameters, and additional examples.
