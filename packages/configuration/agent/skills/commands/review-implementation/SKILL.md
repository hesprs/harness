---
name: review-implementation
description: Review code changes made in a session. Use only when user instructs or other skill references explicitly.
disable-model-invocation: true
---

# Review Implementation

Review the implementation, and optimize for maintainability.

## Workflow

### 1. Validate Completeness

Read code against the goal, verify that all planned file edits are present and compliant. And the code is able to run without obvious bugs. If found anything missing or wrong, stop and report the fact in detail.

### 2. Enforce Code Quality

If validation passes, reflect meticulously according to the [code quality gate](./code-quality.md). Report back with a comprehensive and ruthless simplification enforcement.
