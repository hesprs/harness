---
name: simplify
description: Simplifies code for clarity without changing behavior. Use for readability, maintainability, and complexity reduction after behavior is understood.
---

# Code Simplification

Simplify code by reducing complexity while preserving exact behavior.

## Principles

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

### 5. When Not Simplify

- Code is already clean and readable
- You don't understand what the code does yet
- The code is performance-critical and the "simpler" version would be measurably slower
- You're about to rewrite the module entirely
- Code is about frontend UI

## Process

1. Look for simplification opportunities, signals:
   - Deep nesting
   - Long functions with mixed responsibilities
   - Nested ternaries
   - Boolean flag arguments
   - Repeated conditionals
   - Generic, misleading, ot too long names
   - Duplicated logic
   - Over-defensive guard or normalization that you can ensure it has been check before
   - Dead code
   - Wrappers or abstractions that add no value
   - Unused exports or public methods shat should be kept local
   - Nested `describe()`, `it()` tests -> flatten to top level `test()`

2. Apply changes

3. Verify:
   - [ ] Existing tests pass without modification
   - [ ] Build/typecheck/lint still pass
   - [ ] No unrelated files were refactored
   - [ ] No behavior, error handling, or side effects changed
   - [ ] No error handling was weakened or removed
   - [ ] The result is simpler to review than the original
