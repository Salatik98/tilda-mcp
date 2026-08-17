# Tilda Agent OS

**Status: Pre-alpha / active development**

Tilda Agent OS is an open-source agentic development layer for Tilda that aims to let AI coding agents inspect, edit, build, test, and maintain Tilda websites through semantic machine interfaces instead of fragile cursor-based UI automation.

This repository is currently a research harness, **not a production MCP server**. Core editor primitives are being empirically validated on isolated research targets before any capability is promoted to a stable interface.

## Why this project exists

Coding agents work well with source files, Git, CLIs, APIs, databases, and infrastructure. Visual SaaS development environments are harder: an agent often has to search the screen, click controls, enter text, and depend on layout, timing, and interface language.

Tilda's [documented public API](https://help-ru.tilda.cc/api) exposes project/page reads and exports. It does not document a comprehensive write interface for ordinary editor operations. Tilda Agent OS investigates a safer control layer composed from:

- official APIs where they apply;
- authenticated application operations only after empirical validation;
- editor runtime models;
- Chrome DevTools Protocol (CDP);
- semantic DOM fallbacks;
- structured change plans and exact target gates;
- post-operation verification and restore.

The broader research question is how coding agents can safely operate closed visual development environments without pretending that cursor automation is a stable API.

## What exists today

Implemented and locally tested:

- CDP discovery and exact Tilda-tab selection;
- read-only project inventory primitives;
- canonical hashing of machine-readable state;
- fail-closed project/page allowlist validation;
- account/inventory binding checks for write targets;
- a loopback-only Observatory that sanitizes captured metadata before persistence;
- a status CLI that reports browser and safety state;
- unit and security tests for the research harness.

Empirically observed but not yet a stable public capability:

- semantic project/page identity in an authenticated Tilda session;
- block identity for standard blocks, T123, and Zero Block;
- isolated semantic-UI project/page lifecycle operations.

Under investigation:

- standard-block settings reads and minimal field patches;
- T123 raw-code reads and reversible patches;
- Zero Block raw-model reads and raw-preserving patches;
- page settings, lifecycle, and publication contracts.

See [CAPABILITIES.md](CAPABILITIES.md) for the status ledger. No undocumented write or publish operation is claimed as reproduced in this public package.

## Architecture

The current implementation is a research control plane:

1. Discover a dedicated, authenticated Tilda browser target through CDP.
2. Read and normalize machine-visible state.
3. Bind any future write allowlist to an account fingerprint and complete inventory hash.
4. Require exact project/page identity before an operation.
5. Capture only sanitized observability metadata.
6. Promote an adapter only after snapshot, one-change, reread, exact-diff, restore, and restoration verification.

The intended MCP layer is downstream of this evidence pipeline. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Installation

Requirements: Node.js 20+, pnpm, and Chrome or Chromium with remote debugging enabled.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

On Windows PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Start a dedicated browser profile yourself and sign in manually. Never place browser credentials, cookies, storage state, or a real profile in this repository.

## Current commands

```bash
pnpm tilda status
pnpm tilda inventory
pnpm observatory
```

`status` and `inventory` are research commands, not MCP tools. With the checked-in fail-closed configuration, writes stay blocked.

## Codex integration

Codex can currently work with this repository as a normal codebase: run tests, inspect the status output, implement evidence-backed probes, and review sanitized artifacts. The planned MCP server and its tool schemas do not exist yet.

Proposed future interactions such as `tilda.page.inspect`, `tilda.block.patch`, or `tilda.page.publish` are design targets only. They must not be presented as callable until implementation and live evidence are published.

## Safety model

- Treat every pre-existing project as read-only source material.
- Use only a dedicated, explicitly allowlisted lab for experiments.
- Require exact `(projectId, pageId)` ownership for page-scoped operations.
- Keep editing and publication as separate operations and approval gates.
- Follow read -> snapshot -> dry-run -> one mutation -> reread -> diff -> restore -> reread.
- Never persist secrets, session material, Leads, orders, customer PII, or proprietary page content.
- Block on ambiguous identity, stale state, sanitizer failure, or adapter drift.

The public harness does not yet persist an immutable historical source-project ledger; maintainers must keep historical source IDs in their local read-only configuration. An executable encrypted/local ledger is on the roadmap.

> **Important:** because the public package has no private historical denylist, do not configure or attempt a write on an account that already contains non-lab projects. This limitation is acceptable for read-only research but blocks a safe public write workflow until the immutable local ledger is implemented.

## Examples

Only verified local research commands are shown above. Editor-write examples will be added one by one after their adapters pass the full reversible lab protocol. See [CAPABILITIES.md](CAPABILITIES.md) for planned examples and their gates.

## Roadmap and contributing

See [ROADMAP.md](ROADMAP.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Evidence, safety tests, sanitized fixtures, and compatibility canaries are especially welcome.

## License and disclaimer

Licensed under the [Apache License 2.0](LICENSE).

Tilda is a trademark of its respective owner. This independent project is not affiliated with, endorsed by, or supported by Tilda. The documented public API should be preferred. Any experimental editor integration may depend on undocumented behavior, may break without notice, and must be used only on accounts and projects you are authorized to operate.
