# The Ideal Harness

Agent harness plays a crucial rule in AI agents' performance. A good harness should be easily extensible, not functionally constraint to coding purpose, and without opaque pre-defined garbage.

Based on this principle, we've ruled out several major agents: Claude Code, Codex, OpenCode, Cursor, which are all coding-centric with lengthy and opaque system instructions. [Pi Coding Agent](https://pi.dev) is the right corner stone for an ideal agent: minimal, doesn't bias toward coding (although named "Coding Agent"), with well-documented extension APIs.

This document outlines the blueprint of the ideal agent that will be built upon Pi Coding Agent as an extension. Focusing on baseline capabilities and the programmatic extension model.

The harness uses Bun entirely, prefer Bun's native API and avoid Node's compatibility API when possible. Pi is also configured to run under bun.

## Single Process Paradigm

Everything happens in one process.

- The **viewed agent session runs on the controller's own interactive session**. The human types, Pi prompts natively: token streaming, message waterfall, and the working indicator are all Pi-native.
- **Background agent sessions** are in-process SDK sessions (`createAgentSession`). They run concurrently, persist to their own record files, and stream events through a session registry.

The harness will be built with two parts:

- The framework: entry point `./index.ts`, a Pi extension loaded by the controller process.
- The package: entry point `./src/package/index.ts`, need to be packaged, potentially publish on npm registry, loaded by `harness.config.ts`.

## Blank Agent

A blank agent owns nothing, no skills, no custom instructions at all. Even Pi's built-in tools are removed. The only left is the base instruction:

- Current date to seconds
- Time since last invocation (omit if the agent is new)
- Concise system prompt (the identity, the harness, the working style, the communication rules)
- The path to this application session.
- Session ID and an empty personal note.
- Only one `talk` tool and related injections, which will be expanded in detail in later sections.

The personal note is to assign a markdown file and tell the agent to use the note with file operation tools (if the agent has any of the `write`, `edit` or `apply_patch` tool). The content in that file will be appended to the agent's instruction each turn. The agent can use it to create TODOs, handoff notes, and so on. This is implemented as a implicit base extension.

## Agent Definition

The harness builds an importable package. The package exports runtime functions:

```TypeScript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This is the universal typing of a Pi extension (not only the harness's)
type Extension = (pi: ExtensionAPI) => MaybePromise<void>;

// Define extensions that all agents share
export function defineBaseAgent(args: {
    model?: string;
    thinking?: string;
    prompt?: string;
    extensions?: Array<Extension>;
}): void;

// Define a standalone agent, returns the agent name
export function defineAgent(args: {
    name: string;
    description: string;
    model?: string;
    thinking?: string;
    prompt?: string;
    extensions?: Array<Extension>;
}): string;

// Extension factory that adds a skill to the agent
export function skill(path: string): Extension;

// Extension to give the agent read tool: read local files, extract PDF to markdown with https://github.com/firecrawl/pdf-inspector. When reading a directory, it returns a list of files with line counts for files with countable lines.
export const toolRead: Extension;
// Extension to give the agent write tool: create or overwrite a file.
export const toolWrite: Extension;
// Extension to give the agent edit tool: edit a file based on string match.
export const toolEdit: Extension;
// Extension to give the agent delete tool: delete a file.
export const toolDelete: Extension;
// Extension to give the agent fetch tool: standard JS `fetch`, single URL initiates `GET`, optional output format `extract` (default, use https://github.com/kepano/defuddle + https://github.com/WebReflection/linkedom, refer to Obsidian WebClipper implementation, when the fetched content is a PDF, extract using https://github.com/firecrawl/pdf-inspector) | `raw`, optional fetch params, optional save to file (temporary path) instead of dumping to model context.
export const toolFetch: Extension;
// Extension to give the agent search tool: sematic search based on Exa API.
export const toolSearch: Extension;
// Extension to give the agent bash tool: run bash commands.
export const toolBash: Extension;
// Extension to give the agent find tool: search for files by glob pattern, respecting .gitignore.
export const toolFind: Extension;
// Extension to give the agent grep tool: search file contents for a pattern, respecting .gitignore.
export const toolGrep: Extension;
// Extension to give the agent apply_patch tool: refer to https://github.com/code-yeongyu/pi-apply-patch
export const toolApplyPatch: Extension;
// Extension factory to give the agent spawn tool: spawn a new colleague or children among the defined available agent names.
export function toolSpawn(agents: Array<string>): Extension;
```

## Configuration File

The configuration file is named `harness.config.ts` that calls the package exports at top level. The harness detects the file in `~/.pi/agent/` (user) and current cwd. When found, the harness simply imports that file and it will declare agents.

Each agent's config follows a fixed priority `cwd named > user named > cwd base > user base`, with special handling:

- `model`, `thinking`: override
- `prompt`, `extensions`: accumulate

## Collaboration System

In the ideal harness, the human is no longer the privileged admin that need special treatment, but the same agent abstraction with the permission to spawn all types of agent.

Multiple agent threads can be running simultaneously, taking to each other, or create new agent threads. Such a thread is called a **session**. Parallel sessions are in-process SDK sessions.

### Topic

A topic is a natural organization of agent sessions. All spawned agent sessions can be categorized by topics. A topic, in essence, is a shared context file. The content of the file is included in the prompt of the agent each turn, and update when the file is edited.

An agent is the **leader** of a topic when it spawns the first agent under a topic. Agents are **colleagues** when they belong to the same context. An agent is another agent's **children** when the latter agent is the leader agent of the topic that the former belongs to.

When an agent doesn't specify a topic when spawning a child agent. That agent becomes topic-less, classified as a child of the spawner agent with colleagues of all that agent's topic-less children.

### Context Interleaving

Context interleaving the the core mechanism to ensure agents can receive external notifications (not generated by tools) without losing track on its existing task. The Pi Coding Agent initiates a new turn of agent (an API call) when an agent calls a tool and the tool returns a result. When a notification (a talk, or a notice) hits the agent mid-generation, the content of the notification is included in the instruction of next turn, parallel with the tool result. If the notification arrives when the model is idle, the notification activates (resumes) the session.

### Tools

The human-agent or inter-agent collaboration between agents is achieved via `spawn` and `talk` tools. In the ideal harness, agents no longer communicate via plain output, human to agent, agent to agent, agent to human, all talk asynchronously through the `talk` abstraction. The human starting a new session with a prompt, it is tantamount to spawning a topic-less child. When the user continue to message in this session, it is equal to `talk` with this agent. When an agent `talks` with the user, the content is recorded in `meta.json` and a notice (`ctx.ui.notify`) is sent in the TUI.

`spawn` tool allows an agent to create a new agent session. It can choose any markdown file as the topic context file or no context file at all. And the leader - colleague - child hierarchy naturally divides. The tool result shows the newly spawned agent session ID and record file.

`talk` tool is a single-direction messaging tool works via context interleaving. Each agent has this tool by default. Each agent can talk to its leader, colleagues, or children. The talking target receives a notice showing the talker ID, the relationship relative to it (leader, colleague, child), and the actual message. The tool is asynchronous, it doesn't the block the execution of either the talk initiator or receiver. Also injects into instruction the all talkable agent sessions with session ID, agent name and description, personal note of this agent in the session, and record file path.

Talk delivery routes through an in-process **session registry**: a map from session ID to a delivery handle. Targets are SDK sessions (`session.steer()` when generating, `session.prompt()` when idle) or the controller session (`pi.sendMessage` with `deliverAs: "steer"`). No sockets, no serialization, direct calls.

The harness registers a command to print all talks received by `commander-00001` to the message waterfall.

The human has no difference against a leader agent in agents' eyes, and has a fixed "session ID" of `commander-00001`, "agent" name `leader`, description `Leader that proposes ideas and coordinates works.`, personal note empty, no record file.

### Persistence

Each session is tracked in `meta.json` inside the application session folder. The `spawn` tool returns with the path of the record to the spawner when creating a new session. Agents are told the path of the record file, so they can inspect what others are doing by reading or processing the file.

Agents can also delete a record file: the harness watches every session record file (registered when the session is created or brought back live), and deleting one immediately stops and removes that session. Topic files are watched the same way — deleting a topic file cascade-removes the topic's sessions and their children. The `delete` tool itself is a plain file removal and knows nothing about sessions; all reaction logic lives in the harness.

An **application session** (to distinguish from an "agent session") is the union of a user-initiated session and sessions spawned in that session. It takes up a **folder** `~/.pi/agent/sessions/--<cwd>--/<timestamp-hash>/`. Inside the folder, `meta.json` stores the application session info: user current viewing agent session, agent relationships, topics, agent personal note paths, `commander-00001` received talks, and record file paths. Agent session footage lives in Pi-native session JSONL files wherever Pi puts them (the controller session's own file for the viewed agent, files created by the SDK in the application folder for background agents), referenced from `meta.json` by absolute path. Agents' personal notes are created in the application folder by default as `<agent session ID>.md`.

## UI

The human acts just like a agent with global `talk` and `spawn` access. The TUI integrates current session ID into Pi's footer. The harness registers a command to shift between all existing agent sessions **inside an application session**. The user can also shift to a `new` session, then the interactive TUI shows a menu to let the user to choose the agent name among all defined agents. The footer session ID displays `new <agent name>` before the user sends the first message and the actual session is spawned. New session spawned in this way belong to the same application session. `/apps` browses historical application sessions (plus a `new` entry that starts a fresh one) — the command is named `/apps` because `/new` and `/resume` are Pi built-ins that extension commands cannot override. Records opened through Pi's native `resume` (or `pi -r`) still bind: `session_start` scans the app-sessions root for the owning app session.

By default (user starts `pi` or user uses Pi's built-in `new` command, so there's no existing application session), the last new agent profile spawned manually by the user wins. If the user has never spawned any agent, the first defined agent wins.

Shifting to an existing session points the controller session at that session's record: the message waterfall is cleaned and repopulated with that session's messages, then native streaming continues from there. Shifting to a `new` agent clears the message waterfall immediately, ready for the new agent's footage. Because the viewed session runs on the controller session itself, streaming, the waterfall and the working loader are all Pi-native.

The user sending a message in a viewed session is `commander-00001` `talking` to that session: the input is intercepted and re-delivered as a user-role message framed like any other talk notice (`[talk from your commander-00001 (leader)] …`) via `pi.sendUserMessage`, so the turn itself — streaming, waterfall, working loader — stays Pi-native.
