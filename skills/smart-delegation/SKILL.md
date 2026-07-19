---
name: smart-delegation
description: Guidelines to help you write code smartly by using workers. Only use
---

## 1. Evaluation

Evaluate the optimal agent delegation strategy to achieve the goal, principles:

- depending on the size of the plan, if the plan only involves one to two files, code all by yourself. Otherwise try to use sub-agents.
- when using sub-agents, provide them with full context they need to complete the task via direct prompting
- each sub-agent focus on one atomic task and needs minimal extra context other than what you provided
- don't let one worker do all the work
- maximize speed by parallelizing agent execution
- resolve task dependency, never delegate agents to complete tasks whose dependencies are not done, like:
  - tests after implementation
  - install all deps before implementation
  - shared parts go first, then individual consumers
- each agent has clear scope and target function to achieve, each agent's scope doesn't overlap
- review the workers' work after one batch finish before delegating next batch.

After evaluation, save your detailed plan to the todo list.

## 2. Implement

Delegate agents in the correct order and wait them to finish.

After all agents finish, read the files that they are supposed to change. If the implementation is not complete, does not comply with the canonical plan, or obviously flawed, resume the corresponding session and tell it to finish. If the code is ugly (duplication, not needed compatibility, dead code), correct it directly.

## 3. Run Checks

Then run repository commands (lint, type check, tests), iterate until they all pass:

- Run format and lint autofix to fix format and auto-fixable lint issues.
- Directly patch the code yourself to fix them.
