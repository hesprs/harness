---
name: implement-plan
description: Standard workflow to implement a plan.
disable-model-invocation: true
---

## Core Mandate

You will be responsible for the entire implementation of a specific plan. Every implementation based on a plan in `plan/` should go through the audit - implement - review workflow as follows. Maximize rigorousness and future maintainability.

## Delegation

- Use a single Orchestrator subagent for the core implementation.
- All other tasks are handled by yourself.

## Sequential Workflow

### 1. Audit

Start a `audit-plan` session yourself about the plan.

### 2. Plan Delegation

Evaluate the optimal agent delegation strategy to achieve the goal, principles:

- provide them with full context they need to complete the task via direct prompting, you must include:
  - path to the canonical plan
  - file scope of their tasks
  - definitive and canonical goal to achieve
  - when they finish, they should return clear summary of the task implementation detail they have done
- each agent focus on one atomic task and needs minimal extra context other than what you provided
- each agent's scope doesn't overlap
- maximize speed by parallelizing agent execution
- resolve task dependency, never delegate agents to complete tasks whose dependency tasks are not done (e.g., always write tests after the implementation)
- each agent has clear scope and target function to achieve.

### 4. Implement

Delegate agents in the correct order and wait them to finish.

After all agents finish, read the files that they are supposed to change. If the implementation is not complete, does not comply with the canonical plan, or obviously flawed, resume the corresponding session and tell it to finish.

### 5. Run Checks

Then run repository commands (lint, type check, tests), iterate until they all pass:

- Run format and lint autofix to fix format and auto-fixable lint issues.
- Resume the corresponding agent session and ask it to fix type or logic errors if they are within a single agent's scope.
- When the error crosses many scopes or an agent cannot fix an issue after multiple iterations, directly patch yourself.

### 6. Review

Resume the same Oracle session with the following prompt:

```markdown
The implementation of the plan has finished. Now review the implementation by using `review-changes` skill.
```

The Oracle may reject the change or pass with some comments. When it rejects, return to the iteration and finish the parts that the Oracle points out, until it passes. Do not parallelize review loop. Implementation - review flow should stay sequential.

When the review passes, present a implementation summary to the user including the Oracle comment.
