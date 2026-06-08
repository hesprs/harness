---
name: review-implementation
description: Review code changes made in a session. Use only when user instructs or other skill references.
---

# Audit Plan

## Core Mandate

Review the implementation against its effect, and optimize for maintainability.

## Workflow

### 1. Validate Completeness

Read code against the plan, verify that all planned file edits are present. And the code is able to run without obvious bugs. If found anything missing or wrong, stop and report the fact in detail.

### 2. Tighten Code Quality

If validation passes, simplify the code covered by this plan according to `./simplify.md`, patch directly.

### 3. Final Test

Run checks and test and ensure they all pass.
