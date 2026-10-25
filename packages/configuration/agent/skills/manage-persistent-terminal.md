---
name: manage-persistent-terminal
description: Manage persistent terminal sessions using plain Bash. Must use before running these sessions, like start a dev server or blocking script.
---

## Pattern: nohup + log file

Two artifacts per session: stdout/stderr go to a log file, and the PID you just remember. The bash tool returns immediately; you poll the log for readiness and kill via the PID when done.

### Start

```bash
nohup <command> > /tmp/<name>.log 2>&1 < /dev/null &
echo $!   # remember this PID
```

Example — dev server:

```bash
nohup bun run dev > /tmp/dev.log 2>&1 < /dev/null &
echo $!
```

If you don't need logs, swap `/tmp/dev.log` with `/dev/null`.

For full detachment from the process group (survives wrapper signal propagation), prefix with `setsid` and add `disown`:

```bash
setsid nohup <command> > /tmp/<name>.log 2>&1 < /dev/null & disown
```

### Read output

```bash
tail -50 /tmp/<name>.log      # recent output
grep -i error /tmp/<name>.log # find failures
kill -0 <pid> 2>/dev/null && echo alive || echo dead
```

### Stop

```bash
kill <pid> 2>/dev/null || true
```

If the PID is lost, find by pattern:

```bash
pgrep -f "<command-substring>"   # find PID
pkill -f "<command-substring>"   # or kill directly
```

Use `kill -9` only as last resort (skips graceful shutdown).

## Important Notes

1. **Always redirect stdout/stderr to a file or /dev/null.** This is non-negotiable — bare `cmd &` hangs the bash tool via leaked pipes.
2. **One unique name per session** (`dev`, `test-watcher`...) for log files; reuse overwrites, which is fine for restart.
3. **Poll for readiness** via log grep or port check.
4. **A dead process doesn't clear its log** — check PID liveness (`kill -0 <pid>`) before trusting stale output as current state.
5. **Remember the PID right after starting** — it prints once. If lost, recover via `pgrep -f <pattern>`.
6. If the command needs interactivity (TUI, prompts, SSH), plain bash backgrounding is the wrong tool — those need a real PTY.
