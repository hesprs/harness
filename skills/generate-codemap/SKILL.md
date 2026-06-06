---
name: codemap
description: Generate comprehensive hierarchical codemaps.
disable-model-invocation: true
---

# Codemap Skill

You help users understand and map repositories by creating hierarchical codemaps.

## Delegation

- Explore agent for non-root codemap generation.
- Do others yourself.

## Workflow

### Step 1: Check for Existing State

**First, check if `blueprint/codemap.json` exists in the repo root.** If exists, skip to Step 3 (Detect Changes) - no need to re-initialize.

### Step 2: Initialize (Only if no state exists)

1. **Analyze the repository structure** - List files, understand directories
2. **Infer patterns** for **core code/config files ONLY** to include:
   - **Include**: `src/**/*.ts`, `package.json`, etc.
   - **Exclude (MANDATORY)**: Do NOT include tests, documentation, or translations.
     - Tests: `**/*.test.ts`, `**/*.spec.ts`, `tests/**`, `__tests__/**`
     - Docs: `docs/**`, `*.md` (except root `README.md` if needed), `LICENSE`
     - Build/Deps: `node_modules/**`, `dist/**`, `build/**`, `*.min.js`
   - Respect `.gitignore` automatically
3. **Run codemap.mjs init**:

```sh
node <directory of this skill>/codemap.mjs init \
  --root ./ \
  --include "src/**/*.ts" \
  --exclude "**/*.test.ts" --exclude "dist/**" --exclude "node_modules/**" <all other files you need to exclude>
```

This creates:

- `blueprint/codemap.json` - File and folder hashes for change detection
- Empty `codemap.md` files in all relevant subdirectories

4. **Delegate codemap writing to worker agents** - Spawn one worker per folder to read code and create or update its specific `codemap.md` file.

### Step 3: Detect Changes (If state already exists)

1. **Run codemap.mjs changes** to see what changed:

```sh
node <directory of this skill>/codemap.mjs changes \
  --root ./
```

2. **Review the output** - It shows:
   - Added files
   - Removed files
   - Modified files
   - Affected folders

3. **Only update affected codemaps** - Spawn one worker agent per affected folder to update its `codemap.md`. You must:
   - Not assign duplicated tasks to agents.
   - Delegate agents in turns according to depth, from the deepest level to the atlas (atlas should be done by yourself), each turn only delegate worker agent in folders that have the same depth. Do not delegate all agents all at once.
   - Prompt for each agent, copy paste as-is with the placeholder filled:

````markdown
You are responsible for writing `codemap.md` file in directory `<placeholder directory>` during this workflow. Explore the code and related integrations. Use precise technical terminology to document the implementation:

- **Responsibility** - Define the specific role of this directory using standard software engineering terms (e.g., "Service Layer", "Data Access Object", "Middleware").
- **Design Patterns** - Identify and name specific patterns used (e.g., "Observer", "Singleton", "Factory", "Strategy"). Detail the abstractions and interfaces.
- **Data & Control Flow** - Explicitly trace how data enters and leaves the module. Mention specific function call sequences and state transitions.
- **Integration Points** - List dependencies and consumer modules. Use technical names for hooks, events, or API endpoints.

Example codemap:

```markdown
# src/agents/

## Responsibility

Defines agent personalities and manages their configuration lifecycle.

## Design

Each agent is a prompt + permission set. Config system uses:

- Default prompts (orchestrator.ts, explorer.ts, etc.)
- User overrides from ~/.config/opencode/oh-my-opencode-slim.json
- Permission wildcards for skill/MCP access control

## Flow

1. Plugin loads → calls getAgentConfigs()
2. Reads user config preset
3. Merges defaults with overrides
4. Applies permission rules (wildcard expansion)
5. Returns agent configs to OpenCode

## Integration

- Consumed by: Main plugin (src/index.ts)
- Depends on: Config loader, skills registry
```

You must write `codemap.md`, overwrite if existing, create if missing. Do not ask why.
````

4. **Run update** to save new state:

```bash
node ~/.config/opencode/skills/codemap/scripts/codemap.mjs update \
  --root ./
```

### Step 4: Finalize Repository Atlas (Root Codemap)

Once all specific directories are mapped, the you must create or update the root `codemap.md`. This file serves as the **Master Entry Point** for any agent or human entering the repository.

1.  **Map Root Assets**: Document the root-level files (e.g., `package.json`, `index.ts`, `plugin.json`) and the project's overall purpose.
2.  **Aggregate Sub-Maps**: Create a "Repository Directory Map" section. For every folder that has a `codemap.md`, extract its **Responsibility** summary and include it in a table or list in the root map.
3.  **Cross-Reference**: Ensure that the root map contains the absolute or relative paths to the sub-maps so agents can jump directly to the relevant details.

Example **Root Codemap (Atlas)**:

```markdown
# Repository Atlas: oh-my-opencode-slim

## Project Responsibility

A high-performance, low-latency agent orchestration plugin for OpenCode, focusing on specialized sub-agent delegation and multiplexer-assisted child sessions.

## System Entry Points

- `src/index.ts`: Plugin initialization and OpenCode integration.
- `package.json`: Dependency manifest and build scripts.
- `oh-my-opencode-slim.json`: User configuration schema.

## Directory Map (Aggregated)

| Directory       | Responsibility Summary                                                            | Detailed Map                        |
| --------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| `src/agents/`   | Defines agent personalities (Orchestrator, Explorer) and manages model routing.   | [View Map](src/agents/codemap.md)   |
| `src/features/` | Core logic for tmux integration and session state.                                | [View Map](src/features/codemap.md) |
| `src/config/`   | Implements the configuration loading pipeline and environment variable injection. | [View Map](src/config/codemap.md)   |
```

### Step 5: Register Codemap in AGENTS.md

To ensure agents automatically discover and use the codemap, update (or create) `AGENTS.md` at the repo root:

1. If `AGENTS.md` already exists and already contains a `## Repository Map` section, **skip this step** — the reference is already set up.
2. If `AGENTS.md` exists but has no `## Repository Map` section, **append** the section below.
3. If `AGENTS.md` doesn't exist, **create** it with the section below.

```markdown
## Repository Map

A full codemap is available at `codemap.md` in the project root. Before working on any task, read `codemap.md` to understand the project. For deep work on a specific folder, also read that folder's `codemap.md`.
```

This is idempotent — repeated codemap runs will detect the existing section and skip. No duplication.
