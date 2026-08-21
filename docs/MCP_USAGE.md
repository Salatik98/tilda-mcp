# Tilda MCP usage

## Connection

The repository contains the `tilda-agent-os` **1.0.0** MCP control plane. A
trusted Codex project can load `.codex/config.toml`; use `/mcp` to confirm the
connection. The server can also be started manually:

```powershell
pnpm mcp
```

The project configuration asks for one approval on
`tilda_authorize_task`. The MCP then enforces its own exact task scopes, fresh
binding, operation list, TTL, and publication gate; it does not ask once per
block inside the same bounded task. Stdout is reserved for JSON-RPC and
diagnostics go to stderr.

## Fourteen semantic tools

| Tool | Purpose | Default |
|---|---|---|
| `tilda_status` | Read browser, account, and safety status | read |
| `tilda_capabilities` | Report executable capabilities and evidence gates | read |
| `tilda_authorize_task` | Grant one bounded task authority | approval |
| `tilda_audit` | Read identity, structure, and capability gates | read |
| `tilda_learn_capability` | Plan or run typed copy-test learning | dry-run |
| `tilda_query` | Read inventory, exact targets, or local journal state | read |
| `tilda_plan_changeset` | Snapshot and plan one typed mutation | dry-run |
| `tilda_apply_changeset` | Apply one planned ChangeSet | dry-run |
| `tilda_verify_changeset` | Reread and compare the planned state | read |
| `tilda_rollback_changeset` | Restore the stored snapshot | dry-run |
| `tilda_publish` | Separate exact-page publication | dry-run |
| `tilda_unpublish` | Separate exact-page unpublication | dry-run |
| `tilda_verify_live` | Cache-busted public read and bounded checks | read |
| `tilda_page_lifecycle` | Fixed copy/template/lifecycle/cleanup recipes | dry-run |

## One task authority

Call `tilda_authorize_task` once at the beginning of a bounded task. It binds
the user intent digest, fresh account/inventory digests, exact observe and
write targets, allowed semantic operations, optional publication actions, a
task ID, and a short TTL.

- `observe`: inventory, exact queries, and audits only;
- `copy-test`: protected source reads plus writes to an exact disposable copy
  or lab target; learning is restricted to this mode;
- `production`: an exact user-authorized writable target with the same
  snapshot, hash, reread, rollback, and publication gates.

The grant is not wildcard account permission. Account switch, browser restart,
expiry, revocation, target mismatch, or operation mismatch fails closed.

## Discovery and exact reads

Use `tilda_query` with:

- `inventory` for the bounded account/project inventory;
- `page_inventory` with an exact project ID;
- `project`, `page`, `record`, or `element` for exact targets;
- `page_head_code` for the page-specific HEAD read;
- `record_control` with `controlKey: "contentButton"` for a hover-only record
  control.

The public package ships no account-specific IDs. A deployment must build and
review its own ignored inventory and exact allowlist first. Payloads are omitted
by default and bounded when explicitly requested.

## Supported ChangeSets

| Operation | v1 boundary |
|---|---|
| `standard.field.patch` | Existing discovered top-level string field; identity, routing, ordering, and control fields rejected |
| `t123.code.replace` | Full replacement, one replacement, or bounded literal batch with expected-match counts |
| `zero.property.patch` | One existing primitive property on an exact supported element |
| `zero.element.clone` | Clone one valid exact element with a bounded offset |
| `zero.leaf.patch`, `zero.responsive.patch`, `zero.shape.clone` | Narrow reproduced Zero transitions |
| `page.seo.patch` | Exact `meta_descr` page-setting field |
| `page.head.code.replace` | Exact page-specific HEAD contract; site-wide HEAD excluded |
| `standard.template.add` | Only the reproduced template recipe set |
| `page.reference.clone`, `page.reference.cleanup` | Same-project copy and adapter-owned cleanup |
| `page.lifecycle` | Fixed duplicate/parity/reorder/restore/cleanup transaction |

Unknown fields are preserved. T123 and Zero requests are typed and bounded;
arbitrary raw HTML, groups, molecules, identity fields, or undocumented
requests are rejected.

## Safe lifecycle

```text
authorize task → query/audit → plan (dry-run)
→ apply (explicit dryRun=false) → verify reread
→ rollback (explicit dryRun=false) → verify restored
```

The engine records a content-free snapshot and ChangeSet journal, checks the
expected state hash/revision, and requires an idempotency key for apply and
rollback. A failed or ambiguous write is quarantined; do not blindly retry.

Publication and unpublication never happen as an edit side effect. They use a
separate exact page grant and idempotency journal. `tilda_verify_live` is only
available when a local page-to-public-domain binding is configured.

## Public smoke and scope limits

```powershell
pnpm smoke:mcp
```

The smoke is read-only, requires no login, uses no live target IDs, and checks
the fourteen registered tools. The package does not claim assets, catalog/form
operations, arbitrary nested Standard/raw HTML, arbitrary Zero groups,
cross-project moves, folders/trash restore, generic delete/blank-page creation,
site-wide HEAD, arbitrary custom-domain checks, full Advanced Mode support, or
automatic publication.
