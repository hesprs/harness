---
name: write-code
description: Defines code standards. Must use before writing any production code.
---

MUST follow when writing code (YAGNI):

- Only write absolutely necessary code that make things work
- No unnecessary compatibility (migration, compat alias)
- No impossible branches
- No abstractions for single-use code
- No defensive programming, guard what is truly possible in this setup
- Goal is structural coherence and overall simplicity, not band-aid
- Identify architectural boundaries of the codebase, write code at where it is supposed / most idiomatic to be
- Remove everything no longer needed ruthlessly

Goals:

- Concise code
- Reduced entanglement
- Separation of concern
- When refactoring, less line count. When line count increases after refactor, revert immediately.
