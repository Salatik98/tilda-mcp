# Tilda Agent OS / Tilda MCP

**Status: 0.2.0-prealpha — Phase 2 vertical slice complete in an isolated
authorized lab; active development continues.**

Tilda Agent OS is an open-source control plane that lets coding agents work
with a visual Tilda editor through bounded, machine-readable operations. It
combines same-session browser authority, typed ChangeSets, exact target gates,
post-operation rereads, rollback, and separate publication controls.

This repository is a pre-alpha candidate, not a production or universal Tilda
MCP. The public package intentionally contains no real account/project/page/
record IDs, client content, domains, browser state, raw traces, or private live
fixtures. The narrow live vertical slice was verified privately in an isolated
lab; the public checkout is the reproducible code and unit-test surface, not a
replayable copy of that account.

## What is here

- A local MCP stdio server with eleven bounded tools: status, capabilities,
  exact reads, ChangeSet plan/apply/verify/rollback, separate publish and
  unpublish requests, public verification, and one fixed page-lifecycle
  transaction.
- Typed ChangeSet and snapshot storage with stale-state checks, idempotency,
  append-only journal events, fail-closed recovery, and symlink/path guards.
- Adapter contracts for the narrow, evidence-backed `standard.field.patch`,
  `t123.code.replace`, Zero Block leaf/responsive/clone transitions, and
  `page.seo.patch` operations, plus a full page-specific HEAD read and
  `page.head.code.replace` lifecycle that never publishes as a side effect.
- A loopback CDP browser authority that rebinds to the current authenticated
  session and keeps editor reads, writes, and publication in one explicit
  target-gated workflow.
- Sanitized observability and a public read-only MCP smoke that uses no live
  target IDs and performs no remote writes.

The private Phase 2 evidence covered reversible Standard and T123 changes,
narrow Zero and SEO changes, page-specific HEAD replacement, page lifecycle,
separate publication/public verification, a source-project rejection, and a
dedicated-browser restart/rebind followed by a read-only MCP smoke. Those
claims are deliberately scoped to the exact tested lab/editor/runtime shapes;
they do not imply support for every Tilda block, field, breakpoint, account,
or editor release.

## Quick start

Requirements: Node.js 20+, pnpm 11+, and (only for local authenticated research)
a dedicated Chrome/Chromium profile with remote debugging enabled.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:mcp
```

The public smoke checks the local MCP protocol, eleven tool registrations,
structured capability output, and structured status output. It does not log in,
open a live target, mutate Tilda, publish anything, or require account IDs.

For Codex, the project-scoped configuration is in
[`.codex/config.toml`](.codex/config.toml). Start the server manually with
`pnpm mcp`; stdout is reserved for MCP JSON-RPC and diagnostics go to stderr.

## Safety boundary

- Use only accounts and projects the operator is authorized to operate.
- Treat every pre-existing project as read-only; use a dedicated isolated lab
  for experiments.
- Build a local ignored read-only inventory and exact lab allowlist before any
  write. The public package ships no account-specific ledger, so an unconfigured
  checkout remains fail-closed.
- Every edit follows read → snapshot → dry-run → one semantic mutation →
  reread → exact diff → restore → reread restore.
- Editing never publishes. Publication and unpublication are separate,
  approval-gated operations.
- Never commit credentials, cookies, auth/CSRF data, browser profiles, HAR or
  raw traces, Leads, orders, PII, proprietary content, or real Tilda IDs.
- An ambiguous or failed undocumented write is quarantined. Do not blindly
  retry it.

See [`SECURITY.md`](SECURITY.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), and
[`CAPABILITIES.md`](CAPABILITIES.md) for the claim and evidence boundaries.

## Why this matters

Coding agents already have reliable machine interfaces for source files, Git,
CLIs, APIs, and databases. Visual SaaS editors are different: cursor-based
automation is fragile, while undocumented runtime requests can be unsafe. This
project explores a portable pattern for operating such environments with
explicit identity, reversible transactions, evidence labels, and human approval
at consequential gates.

## Scope and roadmap

The current release is a narrow pre-alpha vertical slice. It does not claim a
general editor-write API, arbitrary page/record access, all Zero families,
assets, catalog/forms, cross-project moves, trash recovery, site-wide HEAD,
Advanced Interface Mode compatibility, or production reliability. See
[`ROADMAP.md`](ROADMAP.md) for the next evidence gates.

## License

Apache-2.0. Tilda is a trademark of its respective owner. This independent
project is not affiliated with, endorsed by, or supported by Tilda.
