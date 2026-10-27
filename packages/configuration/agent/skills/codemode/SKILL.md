---
name: codemode
description: Orchestrate tool calls with codemode. Read before using codemode.
---

The `codemode` tool lets the model write a TypeScript script that calls pi's other tools and runs non-LLM models, such as classifiers and image models. Only the script's output reaches the model, so a script can run calls in parallel and filter large results before the model sees them.

## Scripts

The tool input is raw JS/TS source, not JSON and not a markdown code fence. It runs as the body of an async function in a Bun worker thread, so top-level `await` and `return` work.

The script has the full Bun and Node API, `fetch`, timers, direct file system and network access, and it can `await import()` any package or file in the project (static import doesn't work). TypeScript syntax is available. Bare specifiers, relative paths, and absolute paths all resolve from the project directory. Prefer tools and `models` when they exist: a tool call is recorded in the session, cancellable, and visible to the model, while raw shell or file access from a script is not.

A script may start with an options line. It must be the first line; an options line anywhere else fails the call before the script runs:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens` (default 10000) limits the output. Longer output keeps its start and end, and the full text is written to a temp file whose path is included in the result. A script fails when its output passes 16777216 characters of text and base64 image data or 100000 `text()`, `image()`, and `console` calls; write large data to a file with a tool instead.
- `timeout_ms` is a hard deadline for the whole script. It is unset by default, so a script that waits forever waits forever; set a deadline for anything that could hang, such as a network call or a loop over untrusted input. Reaching it terminates the worker, so a script that has already called tools cannot undo them. Image generation can take minutes, so do not set a short deadline for scripts that generate images.

The result starts with `Script completed` or `Script failed`, the wall time, and the output. Text and image items appear in order, each on its own line. When the output has more than one text item (from `text()` or `return`), each starts with a `==> text N/M <==` line. `console` calls follow in one `<console_output>` block with one line per call. A failed script keeps its partial output, followed by `Script error:` and the error. Tool calls are real: calls made before a failure are not undone. Calls still running when the script ends are cancelled, and unawaited promises are discarded.

## Globals

| Global | Purpose |
| --- | --- |
| `tools.<name>(args)` | Call a tool. See [Call tools](#call-tools). |
| `text(value)` | Add a text item to the output. Strings are added as is, other values as JSON. |
| `image(value)` | Add an image to the output: a base64 `data:` URL, an `{ image_url }` object, or an image block `{ type: "image", data, mimeType }` such as those returned by MCP tools and `models.generateImages()`. Remote URLs are not supported. PNG, JPEG, GIF, and WebP are accepted. Each image is also saved to a temp file, and the result names the path before the image. |
| `console.log(...)` | Add a line to the `<console_output>` block after the other output. Arguments are joined with spaces; `info`, `warn`, `error`, and `debug` do the same. |
| `return value` | A top-level `return` adds the value like `text()`. |
| `exit()` | End the script successfully. |
| `store(key, value)` / `load(key)` | Keep small JSON values across `codemode` calls. See [Store values](./store-values.md). |
| `ALL_TOOLS` | Every callable tool as `{ name, description }`, including tools the description does not list. |
| `searchTools(query, { limit?, namespace? })` | Rank callable tools by relevance (BM25, default limit 8). Resolves to `{ name, description }[]`. |
| `describeTool(name)` | Resolves to a tool's description and TypeScript declaration, or `undefined`. |
| `describeNamespace(name)` | Resolves to `{ name, description?, instructions?, tools }` for a namespace such as an MCP server, or `undefined`. |
| `models` | List and run non-LLM models. See [Models](./models.md). |

## Call tools

Every tool the session can call is a method of `tools`, named by its identifier: characters that are not valid in a JavaScript identifier become `_`, so the MCP tool `mcp__dev-radius__search` is `tools.mcp__dev_radius__search`. Each method takes one object with the tool's arguments.

What a call resolves to depends on the tool:

- Tools with an output schema resolve to a structured value. `bash` resolves to `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, also for non-zero exit codes. Its `output` is not limited to the 2000 lines or 50KB the model sees: it holds up to 1 MiB, and longer output keeps its first and last 512 KiB around an omission marker, with `truncated` set and the full output in `full_output_path`.
- MCP tools resolve to their `CallToolResult`, including `isError` and `structuredContent`.
- `read` resolves to the file's text, or for an image to an image block `{ type: "image", data, mimeType, note }` that `image()` shows. `data` is the base64 image the model would see and `note` the text that goes with it, such as resize hints.
- Other tools, such as `edit` and `write`, resolve to their text output.

A call that fails, is blocked, or gets invalid arguments rejects with an `Error` that carries the tool's error text. Use `Promise.allSettled()` to keep the results of the calls that succeed.

The `codemode` description lists tools with their TypeScript declarations, grouped by namespace (for example one MCP server). Tools with `deferred` exposure, which includes MCP tools with the default `codemode` exposure, are not listed, so the description stays the same while MCP servers connect. Listed declarations share a budget of 3000 estimated tokens. Scripts find the other tools with `searchTools()`, `describeTool()`, `describeNamespace()`, or by filtering `ALL_TOOLS`.

Tool declarations in the `codemode` description, `describeTool()`, and `ALL_TOOLS` carry the tools' prompt guidelines, since the system prompt rules only cover declared tools.

## Limits

- At most two codemode workers may be alive across all sessions in one pi process; `PI_CODEMODE_MAX_WORKERS` changes the limit. A cancelled worker occupies its slot until it exits. At capacity, new scripts wait for a free worker in arrival order. A script that gets no worker within 60 seconds, or before its `timeout_ms`, fails without running.
- A script that awaits a promise that never settles runs until `timeout_ms`, or forever when it is unset.
- Scripts cannot start other `codemode` scripts.

## Extra

See `./classify.md` and `./generate-images.md` for batch text classification and text generation guides. Note that these can be unusable if not configured.
