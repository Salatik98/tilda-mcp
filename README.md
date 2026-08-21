# Tilda MCP

Tilda MCP is a local, lab-scoped MCP control plane for working with an
authenticated Tilda editor through bounded, machine-readable operations. It
keeps target identity, browser-session binding, snapshots, optimistic hashes,
post-write rereads, rollback, and publication approval separate.

**Release: 1.0.0 public pre-release.** This is not an official Tilda API, a
universal editor driver, or a production reliability guarantee. The public
checkout contains generic code, synthetic tests, and safety documentation; it
contains no account inventory, real project/page/record IDs, client content,
domains, browser state, credentials, or private live fixtures.

## What is included

- A local MCP stdio server with fourteen semantic tools: status, capabilities,
  one-task authorization, audit, bounded learning, discovery/query,
  ChangeSet plan/apply/verify/rollback, separate publish/unpublish, public
  verification, and a fixed page-lifecycle recipe.
- A short-lived `observe`, `copy-test`, or `production` task authority bound to
  exact targets and a fresh same-session account/inventory binding.
- Typed adapters for safe discovered Standard string fields, T123 literal/code
  edits, bounded Zero primitive/clone transitions, page SEO and page-specific
  HEAD code, same-project reference-page copy/cleanup, and hover-only record
  control revelation without coordinate clicks.
- Content-free local snapshots and append-only ChangeSet events with
  idempotency, stale-state, lock, path, and symlink guards.
- A public read-only MCP smoke that checks all fourteen tool registrations and
  performs no login, remote read, remote write, or publication.

The narrow editor contracts were privately reproduced in an isolated lab. A
private live receipt is evidence for that exact account/editor shape, not a
portable allowlist or a claim of universal Tilda coverage.

## Quick start

Requirements: Node.js 20+, pnpm 11+, and, only for authorized live research, a
dedicated Chrome/Chromium profile with loopback remote debugging.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:unit
pnpm build
pnpm smoke:mcp
```

The public smoke is intentionally read-only and works without account IDs or
an authenticated browser. For Codex, the project-scoped entrypoint is
`.codex/config.toml`; start the server manually with `pnpm mcp` when needed.
The server writes diagnostics to stderr and reserves stdout for MCP JSON-RPC.

## Safe live workflow

1. Sign in yourself in a dedicated browser profile and capture a fresh local
   inventory.
2. Keep existing projects read-only and create or identify a disposable lab
   target. Build a disjoint local allowlist of exact project/page/record
   tuples; the public checkout ships none.
3. Authorize one bounded task. Discovery does not grant write authority.
4. Read and audit the exact target, then plan a dry-run ChangeSet.
5. Apply one semantic mutation only with an explicit non-dry-run request,
   reread, compare, and restore or roll back when the requested outcome is not
   proven.
6. Treat publication and unpublication as separate approval-gated actions.

The MCP fails closed on missing identity, stale binding, target drift,
ambiguous writes, unsupported structures, missing restore proof, or unknown
editor contracts. It never accepts arbitrary JavaScript, URLs, selectors,
request bodies, or screen-coordinate macros as a capability definition.

## Scope limits

The v1 boundary does not claim asset upload, catalog bulk mutation, form
receivers/submissions, arbitrary nested Standard/raw HTML reconstruction,
arbitrary Zero groups or molecules, cross-project copy/move, folders or trash
restore, generic delete or blank-page creation, site-wide HEAD, arbitrary
custom-domain verification, full Advanced Interface Mode support, or
automatic publication.

See [`CAPABILITIES.md`](CAPABILITIES.md), [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`SECURITY.md`](SECURITY.md), [`docs/MCP_USAGE.md`](docs/MCP_USAGE.md), and
[`ROADMAP.md`](ROADMAP.md) for the detailed boundary.

## Contribution and license

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before proposing a change.
Never submit credentials, cookies, browser profiles, private fixtures, raw
traces, customer data, or real Tilda identifiers. The project is Apache-2.0
licensed. Tilda is a trademark of its respective owner; this independent
project is not affiliated with, endorsed by, or supported by Tilda.
