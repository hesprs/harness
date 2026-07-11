---
name: implement-plan
description: Standard workflow to implement a plan.
disable-model-invocation: true
---

## Core Mandate

You will be responsible for the entire implementation of a specific plan. Every implementation based on a plan in `plans/` should go through the audit - implement - review workflow as follows. Maximize rigorousness and future maintainability.

## Delegation

- Use a single Oracle subagent for audit and review.
- Delegate other agents freely.

## Sequential Workflow

### 1. Audit

Without reading the plan, delegate an Oracle agent with exact prompt (no need to follow format): `Use "audit-plan" skill to audit <plan-file-path>`.

## 2. Plan Delegation

Evaluate the optimal agent delegation strategy to achieve the goal, principles:

- depending on the size of the plan, if the plan only involves one to two files, code all by yourself. Otherwise try to use sub-agents.
- when using sub-agents, provide them with full context they need to complete the task via direct prompting
- each sub-agent focus on one atomic task and needs minimal extra context other than what you provided
- don't let one worker do all the work
- maximize speed by parallelizing agent execution
- resolve task dependency, never delegate agents to complete tasks whose dependencies are not done, like:
  - tests after implementation
  - install all deps before implementation
  - shared helpers go first, then individual modules
- each agent has clear scope and target function to achieve, each agent's scope doesn't overlap
- review the workers' work after one batch finish before delegating next batch.

After evaluation, save your detailed plan to your todo list.

## 3. Implement

Delegate agents in the correct order and wait them to finish.

After all agents finish, read the files that they are supposed to change. If the implementation is not complete, does not comply with the canonical plan, or obviously flawed, resume the corresponding session and tell it to finish.

## 4. Run Checks

Then run repository commands (lint, type check, tests), iterate until they all pass:

- Run format and lint autofix to fix format and auto-fixable lint issues.
- Directly patch the code yourself to fix them.

### 5. Review

Resume the same Oracle session as in step 1: `Now the implementation is finished, review using "review-implementation" skill.`

If the Oracle rejects, fix the raised issue, and request review again: `All raised issues are addressed, restart review`.

When the Oracle says the review passes but asks for simplification. You must simplify all the points it raises. When simplification is done, proceed to next step, no need to review again.

### 6. Report Back

Present a implementation summary to the user.
