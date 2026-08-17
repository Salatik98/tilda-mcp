# Agent entrypoint

This repository is pre-alpha research. Do not claim a production MCP server or a capability that is not listed as verified in `CAPABILITIES.md`.

## Read first

1. `README.md`
2. `CAPABILITIES.md`
3. `ARCHITECTURE.md`
4. `SECURITY.md`
5. `CONTRIBUTING.md`

## Non-negotiable rules

- Use only accounts, projects, and pages for which the operator has authorization.
- Treat pre-existing projects as read-only; experimentation belongs in an isolated lab.
- Keep checked-in configuration fail-closed.
- Never commit `.env`, credentials, cookies, browser profiles, storage state, HAR files, traces, private fixtures, Leads, orders, PII, or proprietary content.
- Editing never implies publication. Publication requires a separate explicit approval and exact target.
- Undocumented behavior remains experimental until a reversible lab proof is published.
- Do not blind-retry an undocumented write after an ambiguous result.

## Evidence discipline

Label claims as implemented/tested, experimentally observed, under investigation, planned, or rejected. Every editor-write proof must include target validation, snapshot, dry-run, one semantic change, reread, exact diff, restore, and restoration reread.
