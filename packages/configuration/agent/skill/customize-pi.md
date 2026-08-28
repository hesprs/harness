---
name: customize-pi
description: Learn how to customize Pi harness. Use only when the leader explicitly asks about Pi itself, its SDK, extensions, themes, skills, or TUI.
---

Use the following command to find Pi root:

```sh
echo $(dirname $(dirname $(readlink -f $(command -v pi))))/lib/node_modules/pi-monorepo
```

Pi documentation (read only):

- Main documentation: `<pi root>/README.md`
- Additional docs: `<pi root>/docs/`
- Examples: `<pi root>/examples/` (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve `docs/...` under Additional `docs` and `examples/...` under `Examples`, not the current working directory
- When asked about: extensions (`docs/extensions.md`, `examples/extensions/`), themes (`docs/themes.md`), skills (`docs/skills.md`), prompt templates (`docs/prompt-templates.md`), TUI components (`docs/tui.md`), keybindings (`docs/keybindings.md`), SDK integrations (`docs/sdk.md`), custom providers (`docs/custom-provider.md`), adding models (`docs/models.md`), pi packages (`docs/packages.md`), environment variables (`docs/environment-variables.md`)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., `tui.md` for TUI API details)
