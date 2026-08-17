# MCP usage

## Connection

This repository contains the `0.2.0-prealpha` MCP control plane. The project
configuration is [`.codex/config.toml`](../.codex/config.toml). Start it from
the repository root with:

```powershell
pnpm mcp
```

Stdout is reserved for MCP JSON-RPC. Diagnostics go to stderr. The public
checkout has no account-specific allowlist, so all live operations remain
blocked until an operator supplies and reviews a local authorized lab setup.

## Eleven tools

| Tool | Purpose | Default |
|---|---|---|
| `tilda_status` | Read local browser, account, and safety status | read |
| `tilda_capabilities` | Read capability/transport status | read |
| `tilda_query` | Read an exact target or local ChangeSet/snapshot | read |
| `tilda_plan_changeset` | Snapshot and plan one typed mutation | dry-run |
| `tilda_apply_changeset` | Apply one reviewed ChangeSet | dry-run |
| `tilda_verify_changeset` | Reread and compare a ChangeSet | read |
| `tilda_rollback_changeset` | Restore a stored snapshot | dry-run |
| `tilda_publish` | Request separate exact-page publication | dry-run |
| `tilda_unpublish` | Request separate exact-page unpublication | dry-run |
| `tilda_verify_live` | Cache-busted public verification | read |
| `tilda_page_lifecycle` | Fixed duplicate/parity/reorder/restore/cleanup transaction | dry-run |

The names are stable protocol contracts; availability still requires a fresh
same-session authority, exact local project/page/record ownership, and the
adapter's evidence gate.

## Typed mutation scope

The Phase 2 vertical slice contains narrow contracts for:

- `standard.field.patch`;
- `t123.code.replace`;
- `zero.leaf.patch`, `zero.responsive.patch`, and `zero.shape.clone`;
- `page.seo.patch`;
- `page.head.code.replace` — full page-specific HEAD replacement with
  publication state included in the intended hash.

Use `tilda_query` with `kind: "page_head_code"` and an exact page target for
the companion read. The raw code is omitted by default; `includePayload: true`
is bounded and should be used only for an exact authorized operation. Neither
the read nor the replacement publishes the page.

Unknown fields are preserved. Payloads are omitted from MCP results by default
and are bounded when explicitly requested. These operations do not represent a
universal Tilda schema.

## Safe lifecycle

```text
query → plan (dry-run) → apply (explicit dryRun=false)
      → verify reread → rollback (explicit dryRun=false)
      → verify restored
```

The engine records a content-free snapshot and append-only journal, checks the
expected revision/hash, and requires idempotency keys for remote mutation
steps. A failed or ambiguous write is quarantined and must not be blindly
retried. For HEAD writes, two unstable rereads are explicitly
non-reconcilable: the engine records `APPLY_AMBIGUOUS` or
`ROLLBACK_AMBIGUOUS`, performs no automatic restore/retry, and requires a new
bounded diagnosis. Source projects are rejected before snapshot or dispatch.

Publication and unpublication are never edit side effects. They have separate
approval, idempotency, exact-page, editor-reread, and public-verification gates.

## Public read-only smoke

```powershell
pnpm smoke:mcp
```

This smoke checks the MCP handshake, all eleven tool registrations, structured
capabilities, and structured status. It uses no live target IDs, no private
fixtures, no account credentials, and no remote writes. Maintainer-only live
lab smoke procedures are intentionally kept outside this public package.

## Current scope

This is a verified lab vertical slice, not production automation. It does not
claim arbitrary records/elements, all Zero families, every page setting,
cross-project moves, trash recovery, assets, catalog/forms, custom domains, or
an official editor-write API. Page-specific HEAD is in scope; site-wide HEAD
and Advanced Interface Mode compatibility remain Phase 3. See
[`../CAPABILITIES.md`](../CAPABILITIES.md) and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md).
