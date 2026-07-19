---
name: manage-pty
description: Manage interactive or persistent terminal sessions. Must use before running these sessions, like start a dev server, SSH, REPL, ...
---

## Commands

```sh
pty-bridge [--timeout <ms>] <command> [options]

pty-bridge start <command> [args...]                # Start a PTY session
pty-bridge read <id> [--full] [--buffer <type>]     # Read new output (incremental by default, --full for all)
pty-bridge write <id> <input>                       # Send input (or pipe via stdin)
pty-bridge exec <id> <command> [--wait <ms>] [--wait-for-idle <ms>] # Execute command and return new output (default wait: 200ms)
pty-bridge sendkey <id> <key>                       # Send special key
pty-bridge wait-for <id> <pattern> [--timeout <s>]  # Block until pattern appears (default: 30s)
pty-bridge snapshot <id>                            # Capture current visible screen content
pty-bridge list                                     # List active sessions with uptime, buffer type, and details
pty-bridge kill <id>                                # Terminate a session
pty-bridge resize <id> <cols> <rows>                # Resize terminal
pty-bridge status                                   # Show daemon status (PID, memory, sessions)
```

### Global Options

```bash
pty-bridge --timeout 60000 exec <id> "slow-command"   # Override client socket timeout (default: 30000ms)
```

### Start Options

```bash
pty-bridge start ssh user@host --keepalive 30    # Send keepalive every 30s (prevents SSH timeout)
pty-bridge start pnpm dev --wait 1000                 # Wait 1000ms before returning initial output (default: 500ms)
pty-bridge start cmd --cols 200 --rows 50        # Custom terminal dimensions (default: 120x40)
```

### Read Options

```bash
pty-bridge read <id> --buffer normal      # Read from normal buffer (even if alternate is active)
pty-bridge read <id> --buffer alternate   # Read from alternate buffer
pty-bridge read <id> --buffer active      # Read from whichever buffer is active (default)
```

### Exec Options

```bash
pty-bridge exec <id> "make build" --wait-for-idle 500          # Poll every 500ms, return when output stabilizes (max 5s)
pty-bridge exec <id> "make build" --wait-for-idle 500 --wait 10000  # Same but max wait 10s
```

## Special Keys

enter, tab, escape, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl-a through ctrl-z, ctrl-\\, ctrl-]

## Output Format Convention

- **stdout**: command output (the actual PTY content)
- **stderr**: metadata line in `[key=value ...]` format, e.g. `[lines=42 alive=true buffer=normal exitCode=0]`
- `read` returns output on stdout, session metadata on stderr — parse stderr for session state
- `exec` returns command output on stdout — check `isAlive` and `exitCode` in the stderr line or JSON response
- `snapshot` prints a header line `[buffer=... cursor=... size=...]` then the screen content
- `status` output is human-readable text (parse with regex if needed)

## Important Notes

1. **Prefer `exec` over `write` + `sendkey enter`** — `exec` combines write, enter, wait, and read into one call, returning only the new output.
2. **`read` is incremental by default** — it returns only output since the last read. Use `read <id> --full` to get the entire buffer.
3. **`exec` does NOT advance the `read` cursor** — if you call `exec` then `read`, the `read` will include the same output that `exec` already returned. This is by design: `exec` is a self-contained operation that doesn't interfere with incremental `read` state.
4. **Use `wait-for` for long operations** — instead of `sleep N && read`, use `wait-for <id> "pattern" --timeout N` to block until specific output appears.
5. `write` sends text as-is — use `sendkey enter` afterward to submit (or just use `exec`).
6. For secrets, pipe via stdin: `echo -n "password" | pty-bridge write <id> --stdin`
7. Always `kill` sessions when done to free resources.
8. The daemon auto-exits after 5 minutes when no alive sessions remain.
9. Use `ctrl-c` via sendkey to interrupt stuck commands.
10. Terminal defaults to 120x40. Use `--cols`/`--rows` on `start` or `resize` for TUI apps that need specific dimensions.
11. Use `--timeout <ms>` (global flag, before the command) to override the default 30s client socket timeout for slow operations.
