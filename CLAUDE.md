# Lakeshore One

## gstack

This project vendors [gstack](https://github.com/garrytan/gstack) at `.claude/skills/gstack/` (project install — real files committed, no submodule).

- Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.
- Available skills: /plan-ceo-review, /plan-eng-review, /review, /ship, /browse, /qa, /qa-only, /setup-browser-cookies, /retro, /document-release.
- If gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the browse binary and register skills. The binary and node_modules are gitignored, so each machine builds once (requires Bun; `/browse` also handles this automatically on first use).
