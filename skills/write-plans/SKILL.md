---
name: write-plans
description: Mandatory workflow to transform vague ideas into validated designs and stepped implementation plans. Use only when user instructs or other skill references.
---

## Core Mandate

Every feature request / refactor plan, regardless of perceived simplicity, must pass through this workflow. Shortcuts cause unexamined assumptions and wasted work. Do not edit code.

## Delegation

- optional explore agents for context exploration
- don't delegate in other steps

## Sequential Workflow

### 1. Context Exploration

- Check the current project state: **read concrete files and docs until you have had enough context about this plan**.
- Identify the real code files that proposed changes maps to.
- Identify existing patterns, architecture conventions, and potential integration points.
- Reason how should they be changed according to the proposed changes.

### 2. Scope Assessment & Decomposition

- Evaluate scope immediately after initial context gathering.
- If the request spans multiple independent subsystems, decompose into sub-projects. Define clear boundaries. If the request is huge but belongs to a single vertical slice, you should only make one project.
- If the request contains small edits spanning multiple sites, isolate them into a standalone `chore` sub-project.
- Ensure all your plans combined cover all changes proposed.
- If you have more than one sub-project, present to user all your sub-projects, what they cover, order and you will proceed, and ask for approval. Then proceed. Only one plan proceed directly.
- Execute this workflow for only **one sub-project at a time** for each sub-project. Each sub-project gets its own design validation → plan cycle + the distinct plan Markdown saved in `plans/`.

### 3. Clarifying Dialogue

- Start a `interview` skill session with the user about the requested change.

### 4. Sectional Design & Validation

- After interview, present the design in logical sections (e.g., Architecture, Core Components, Data Flow, Error Handling, Testing Strategy). Do not present raw code or interface.
- Scale section depth to complexity (a few sentences for straightforward parts, more detail for nuanced logic).
- **Get explicit user approval after each section.** If the user requests changes, revise the section before proceeding.
- Design Principles:
  - **YAGNI ruthlessly:** Strip unnecessary features.
  - **Isolation & Boundaries:** Break systems into smaller units with single responsibilities and well-defined interfaces. Each unit must be independently testable and understandable.
  - **Interface Stability:** Ensure consumers can understand what a unit does without reading internals.
  - **Selective Testing:** Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.
- Keep the evolving design entirely in-context. Do not write or commit spec files.

### 5. Plan Generation

- Once the design is fully approved section-by-section, generate the implementation plan, you should formulate a plan for each sub-project.
- Format:

```md
# <!-- feature name --> Plan

## Context

**Source**: <!-- what mandates the change, e.g., change in blueprint, a bug, user's requirement -->

<!--
List touched blueprint documents and a detailed synthesis what change is proposed by it if source is blueprint:
- elaborate repro and root cause if source is a bug
- make your context reasonable for other sources
-->

## Current Implementation

<!-- current state -->

## Target Implementation

<!-- proposed changes -->

## Files and Changes in Public Interface

<!--
**you MUST inspect source files and point to specific file paths and what to change in detail**:

- for creating a new file, you must list the proposed exports in this file
- for modifying a file, if the modification is huge, you must list the proposed final state of the file's export interface; if only small changes, list changed exports
- for meta changes (adding / deleting a dep), include in `Meta` section
- explicitly list files to delete or move
- if proposed change includes classes, you must list all public methods / properties into interfaces

Example:
-->

All file changes specified below are module exports and public class methods / properties, add private helpers or import utils freely. <!-- include this sentence -->

### Meta

- Install `openai` as dev dependency.
- Remove `lodash-es` dependency.
- <!-- skip this section if no meta change -->

### Create `src/foo.ts`

`export type APIResponse = { status: string };`

- type definition for the API

`export function ping(url: string): boolean;`

- ping the URL and return connectivity
- <!-- detailed explanation if needed -->

`export function alert(severity: 'warn' | 'error', data: unknown): void;`

- <!-- explanation -->

### Modify `src/bar.ts`

> Below is the canonical final export interface for this file. Refactor the file to align with this shape and remove everything redundant. <!-- include this sentence in plan for large modification -->

`export function getUser()`

- <!-- explanation, if no change to this export, say "keep original" -->

`export function recoverPassword(user: string, method: RecoverMethods): void;`

- <!-- explanation -->

### Modify `src/abc.ts`

> Below are the public interface of this file that will be touched in implementation of the plan. <!-- include this for small modification -->

`export function shutdown(): void;`

- <!-- explanation -->

## Testing <!-- skip if no testing possible -->

<!--
Specify test files and test cases to add:

- use flat top-level `test()` inside test files instead of nested `describe()` and `it()`
- for each test case, specify what behavior of what export from which file are tested

Example:
-->

### `test/foo.test.ts`

Case `alert should be sent to the API`

- tested interface:
  - `src/foo.test.ts` - `export function alert`
  - `src/foo.test.ts` - `export function ping`
- expected behavior: simulated API ping success and alert sent.

Case `recoverPassword should reject when user does not exist`

(same format as above)
```

### 6. Self-Review

- Run immediately after generating the full plan.
- Perform the Self-Review Protocol (see below).
- Fix logical gaps, ambiguities, or inconsistencies inline. No need to re-present unless changes alter core functionality.

#### Self-Review Protocol

1. **Coverage Mapping**: Cross-reference every proposed changes against the plan tasks. Identify and add any missing tasks.
2. **Placeholder & Ambiguity Scan**: Remove any `TBD`, `TODO`, `handle later`, or vague instructions. Every change must explicitly state what to do, where to do it, and what the expected outcome is.
3. **Logical & Signature Consistency**: Verify that types, function names, data structures, and file references remain consistent across all tasks. A signature defined in Task 2 must match its usage in Task 5.
4. **Zero-Knowledge Readability**: Act as an engineer that does not know this at all, can you understand what the plan is describing and immediately find the correct files & make the desired changes? Have you given readers enough context? If not, include more context.
5. **Specificity**: Have you explicitly written specific files and what to change in detail in the plans?
6. **YAGNI & DRY**: Remove unnecessary features. Ensure shared logic is centralized, not duplicated across tasks. No need for backward compatibility or legacy support, remove everything redundant immediately during the refactor.
7. **No Hesitation**: the plan should be deterministic; don't use "prefer", "consider", "may ... later".
8. **Domain Split**: each generated plan contains only one highly coupled change. No independent module changes coexist in a single plan file.

### 7. Save to File

- Save your final plan(s) as `plan/<feature-name>.md` (create if not present).
