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

### 2. Implement

Delegate an `orchestrator` agent, point it to the plan, wait if to finish.

### 3. Review

Start a `review-implementation` skill session.

### 4. Report Back

Present a implementation summary to the user.
