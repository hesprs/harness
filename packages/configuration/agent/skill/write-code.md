---
name: write-code
description: Defines code standards. Must use before writing any production code.
---

MUST follow when writing code (YAGNI):

- No unnecessary compatibility (migration, compat alias)
- No impossible branches
- No over-defensive guards, guard what is truly possible in this setup
- Only write absolutely necessary code that make things work
- Don't be afraid of broad refactor it that improves conciseness
- Remove everything no longer needed ruthlessly

Goals:

- Concise code
- Reduced entanglement
- Separation of concern
- When refactoring, less line count. When line count increases after refactor, revert immediately.
