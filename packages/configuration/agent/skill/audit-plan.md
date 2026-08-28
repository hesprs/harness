---
name: audit-plan
description: Review a plan before implementation. Use only when the leader instructs or other skill references explicitly.
---

# Audit Plan

Review the plan against its purpose, and optimize the plan for maintainability.

## Workflow

### 1. Read & Understand Plan

1. Read the whole plan file.
2. Inspect real files in the codebase that are touched until you have enough context about the concrete implementation proposed. Making blind instructions ruins the plan.

### 2. Validate Plan

1. Reason about the plan with your context:
   - Does the plan effectively achieves what the source want to do?
   - Are all changes and wiring needed included in the plan?
   - Any logic inconsistencies or flaws?
   - Is the plan likely to break other parts due to public interface shift?
   - Does the plan introduce unnecessary complexity?
2. For huge logic flaw or incomplete plan, stop immediately and use the `talk` tool: "Audit failed, flaw found: (explanation). Fix options (possible fix paths)?". If the leader answers yes, patch the plan with the changes.

### 3. Review Plan

1. Check the whole plan for the design and narrative principles in the `Design` section.
2. Think about add / trim tests, optimize interface.
3. Optionally add hint for individual files if you think the non-public part in the file worth emphasize.

### 4. Patch

1. If you find optimizations or small inconsistencies, you can patch the plan directly.
2. Before patching, use the `ask` tool with a summary of the changes you will make, then patch the plan according to the user's response.
3. Do not make any changes without leader approval.

### 5. Report Back

After all steps, report back only:

- a general summary of the whole plan, not what you changed
- recommended logical sequence of implementation (note tests are always after implementation)

You must not present the problems found or patches made in your final response, all problems should be addressed in step 2, 3, and 4.

## Design

### Public Interface

- **Accept only necessary dependencies, don't create them.**
- **Return results, don't produce side effects.**
- **Small surface area.** Fewer methods = fewer tests needed. Fewer params = simpler test setup.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test _past_ the interface, the module is probably the wrong shape.
- **Cut off redundancy.** Detect and remove unused public interface, too trivial tests, redundant arguments, and over-defensive guards.
- **Reusability.** Find similar logic in the plan and shared helpers in the codebase, and optimize for reuse.
- **The simpler, the better**.

### Narrative

- Everything in the plan should be deterministic; Forbid "prefer", "consider", "may ... later".
- Can the plan be understood by a engineer with no context? File referenced with clear paths, no jargon, integration background explained in the context.
