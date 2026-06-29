# pi-socket-bridge

Pi extension that exposes the full [pi](https://pi.dev) `ExtensionAPI` and `ExtensionContext` over a per-session Unix domain socket using **JSON-RPC 2.0**.

External processes — shell scripts, Python functions, background jobs, other agents — can send messages into a running pi session, control it, and subscribe to its events. No shared process, no imports, no build step.

## Install

```bash
pi install git:git@git-personal:fsabado/pi-socket-bridge
/reload
```

Each pi session creates a socket at `/tmp/pi-bridge/<sessionId>.sock`. A `latest.sock` symlink always points to the most recently started session.

## Quick start

```bash
# report back from a background task
pi-socket-client follow-up "Backfill done: 1,204 rows written"

# redirect the agent mid-task
pi-socket-client steer "Stop — exception in prod, fix auth.py first"

# TUI toast with no LLM turn
pi-socket-client notify "Disk at 87%" --level warning

# wait for the agent to finish, then continue
pi-socket-client follow-up "Run the tests"
pi-socket-client wait agent_end
pi-socket-client follow-up "Now open a PR"

# show all live sessions
pi-socket-client list

# raw JSON-RPC (works from any language)
echo '{"jsonrpc":"2.0","id":1,"method":"follow_up","params":{"text":"Done"}}' \
  | nc -U /tmp/pi-bridge/latest.sock
```

## Socket layout

```
/tmp/pi-bridge/
  <sessionId>.sock      per-session Unix socket (mode 0600, auto-cleaned on reboot)
  latest.sock           symlink → most recently started session

~/.pi/bridge/
  registry.json         session metadata: id, cwd, started
```

## Documentation

- **[Guide](docs/guide.md)** — use cases, patterns, Python examples, delivery modes
- **[CLI Reference](docs/cli-reference.md)** — every command, flag, method, and parameter
