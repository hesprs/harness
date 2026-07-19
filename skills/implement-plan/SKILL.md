---
name: implement-plan
description: Standard workflow to implement a plan. Use only when user instructs or other skill references.
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

### 2. Implement

You must use `smart-delegation` skill, following the guideline to complete the work with maximum quality and quality.

### 3. Review

Resume the same Oracle session as in step 1: `Now the implementation is finished, review using "review-implementation" skill.`

If the Oracle rejects, fix the raised issue, and request review again: `All raised issues are addressed, restart review`.

When the Oracle says the review passes but asks for simplification. You must simplify all the points it raises. When simplification is done, proceed to next step, no need to review again.

### 4. Report Back

Present a implementation summary to the user.
