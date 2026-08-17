# Agent entrypoint

This repository is a `0.2.0-prealpha` Phase 2 vertical slice. It contains an
executable local MCP control plane, but it is not a production or universal
Tilda MCP. Do not claim a capability beyond `CAPABILITIES.md` or private lab
evidence explicitly described there.

## Read first

1. `README.md`
2. `CAPABILITIES.md`
3. `ARCHITECTURE.md`
4. `SECURITY.md`
5. `CONTRIBUTING.md`

For implementation work, also read `docs/MCP_USAGE.md` and the relevant source
and unit tests before changing a contract.

## Non-negotiable rules

- Use only accounts, projects, and pages for which the operator has authorization.
- Treat pre-existing projects as read-only; experimentation belongs in an isolated lab.
- Keep checked-in configuration fail-closed.
- Never commit `.env`, credentials, cookies, browser profiles, storage state, HAR files, traces, private fixtures, Leads, orders, PII, or proprietary content.
- Editing never implies publication. Publication requires a separate explicit approval and exact target.
- Undocumented behavior remains experimental until a reversible lab proof is
  completed; the public repository must not include the account-specific proof
  payloads.
- Do not blind-retry an undocumented write after an ambiguous result.

## Evidence discipline

Label claims as implemented/tested, experimentally observed, under investigation, planned, or rejected. Every editor-write proof must include target validation, snapshot, dry-run, one semantic change, reread, exact diff, restore, and restoration reread.
