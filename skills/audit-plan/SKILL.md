---
name: audit-plan
description: Review a plan before implementation. Use only when user instructs or other skill references.
---

# Audit Plan

## Core Mandate

Review the plan against its purpose, and optimize the plan for maintainability.

## Workflow

### 1. Read & Understand Plan

1. Read the whole plan file.
2. If the `source` of this plan is from the blueprint, start a `get-blueprint-changes` skill session to understand what are changed.
3. For other sources, read the description.
4. Inspect real files in the codebase that are touched until you have enough context about the concrete implementation proposed. Making blind instructions ruins the plan.

### 2. Validate Plan

1. Reason about the plan with your context:
   - Does the plan cover everything the source wants to do?
   - Are all changes and wiring needed included in the plan?
   - Any logic inconsistencies or flaws?
   - Is the plan likely to break other parts due to public interface shift?
2. For huge logic flaw or incomplete plan, stop immediately and report back "Audit failed, huge flaw found: (explanation)".
3. If small inconsistency, patch directly.

### 3. Review Plan

1. Check the whole plan for the design and narrative principles in the `Design` section.
2. Think about optimization.
3. Patch the plan directly with your optimization.
4. Optionally add hint for individual files if you think the non-public part in the file worth emphasize.

### 4. Report Back

After all steps, report back:

- not what you changed, but a general summary of the whole plan
- recommended logical sequence of implementation (whatever your sequence is, tests are always after impl)

## Design

### Tests

What should the public interface look like? Which behaviors are most important to test?

**You can't test everything.** Focus testing effort on critical paths and complex logic, not every possible edge case.

### Public Interface

- **Accept dependencies, don't create them.**
- **Return results, don't produce side effects.**
- **Small surface area.** Fewer methods = fewer tests needed. Fewer params = simpler test setup.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test _past_ the interface, the module is probably the wrong shape.
- **Cut off redundancy.** Detect and remove unused public interface, too trivial tests, redundant arguments, and over-defensive guards.
- **Reusability.** Find similar logic in the plan and shared helpers in the codebase, and optimize for reuse.

### Narrative

- Everything plan should be deterministic; "prefer", "consider", "may ... later" forbidden.
- Can the plan be understood by a engineer with no context? File referenced with clear paths, no jargon, integration background explained in the context.
