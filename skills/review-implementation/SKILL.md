---
name: review-implementation
description: Review code changes made in a session. Use only when user instructs or other skill references.
---

# Audit Plan

## Core Mandate

Review the implementation against its effect, and optimize for maintainability.

## Workflow

### 1. Validate Completeness

Read code against the plan, verify that all planned file edits are present and compliant. And the code is able to run without obvious bugs. If found anything missing or wrong, stop and report the fact in detail.

### 2. Tighten Code Quality

If validation passes, according to `Code Simplification` section, report back with a comprehensive simplification suggestion.

## Code Simplification

Simplify code by reducing complexity while preserving exact behavior.

### 1. Preserve Behavior Exactly

Don't change what the code does — only how it expresses it. Before every change, ask:

- Does this produce the same output for every input?
- Does this maintain the same error behavior?
- Does this preserve the same side effects and ordering?
- Do all existing tests still pass without modification?

### 2. Follow Project Conventions

Simplification means making code more consistent with the codebase, not imposing external preferences.

Before simplifying:

1. Study how neighboring code handles similar patterns
2. Match the project's style for imports, naming, function style, error handling, and type annotations

Simplification that breaks project consistency is not simplification — it's churn.

### 3. Prefer Clarity Over Cleverness

Explicit code is better than compact code when the compact version requires a mental pause to parse.

- Replace nested ternaries with readable control flow
- Replace dense inline transforms with named intermediate steps when they clarify intent
- Keep helpful names even if they cost a few extra lines

### 4. Maintain Balance

Watch for over-simplification:

- Don't inline away names that carry meaning
- Don't merge unrelated logic into one larger function
- Don't remove abstractions that serve testability or extensibility

### 5. Simplification Signals

- Deep nesting
- Long functions with mixed responsibilities
- Nested ternaries
- Boolean flag arguments
- Repeated conditionals
- Generic, misleading, or too long names
- Duplicated logic
- Over-defensive guard or normalization that you can ensure it has been check before
- Dead code
- Wrappers or abstractions that add no value
- Unused exports or public methods shat should be kept local
- Nested `describe()`, `it()` tests -> flatten to top level `test()`

### 6. When Not Simplify

- Code is already clean and readable
- You don't understand what the code does yet
- The code is performance-critical and the "simpler" version would be measurably slower
- You're about to rewrite the module entirely
- Code is about frontend UI
