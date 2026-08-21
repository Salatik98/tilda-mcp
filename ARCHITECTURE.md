# Architecture

## Scope

Tilda MCP is a local control plane, not a general Tilda API. The public
checkout contains the reusable implementation and synthetic tests. Account-
specific inventories, live receipts, raw editor payloads, and private traces
stay outside the public package.

## Runtime layers

```text
MCP stdio transport
        |
typed tool schemas + bounded result contract
        |
task authority + capability gates
        |
ChangeSet engine ---- publication controller
        |
same-session loopback browser authority
        |
typed adapters: Standard / T123 / Zero / page / lifecycle
        |
authenticated Tilda editor runtime
```

### MCP transport

`src/mcp/` owns tool names, strict input schemas, bounded result output, and the
stdio server. Fourteen tools are exposed as semantic operations rather than
button-level macros. The public smoke exercises only local status and
capability reads.

### Task authority

`src/core/task-authority*.ts` binds one short-lived task to a fresh account and
inventory digest, exact observe/write targets, allowed operations, and optional
publication actions. Discovery is read-only and cannot mint authority. Every
adapter call rechecks target scope and binding freshness.

### ChangeSets and recovery

`src/core/` stores content-free snapshots and append-only journal events under
ignored `.tilda-runtime/`. It validates canonical IDs, expected revision/hash,
idempotency, stale events, locks, path containment, and symlink boundaries.
Apply, verify, and rollback are distinct operations. Ambiguous writes are
quarantined; the engine never blindly retries them.

### Browser authority

`src/control/` keeps editor reads and mutations in one authenticated loopback
CDP session. It rejects remote debugging endpoints, wrong routes, stale account
bindings, unclassified projects, and targets outside the exact page/record
allowlist. Hover-only controls are revealed by semantic ownership proof and are
never activated by screen coordinates.

### Adapters

`src/adapters/` translates a small set of reproduced semantic requests into
authority-owned browser calls. Unknown fields are preserved. Standard editing
is limited to safe discovered top-level string fields; T123 edits are bounded
full/single/literal replacements; Zero edits are primitive/clone operations
with protected identity and type fields. Page-specific HEAD is separate from
site-wide HEAD and never publishes as a side effect.

### Discovery and learning

`src/research/` provides CDP discovery, inventory normalization, hashing, and
sanitized observability. Capability learning accepts only typed copy-test
objects and bounded trace/replay/restore evidence. It never accepts arbitrary
JavaScript, URLs, selectors, or request bodies. A missing, ambiguous, or
non-restorable capability remains blocked.

## Evidence promotion

An undocumented behavior moves through explicit states:

1. source-observed hypothesis;
2. live observation in an authorized session;
3. reproduced reversible lab operation;
4. restart/editor-drift verification;
5. narrowly named MCP capability.

The public repository does not promote a capability merely because a class or
schema exists. Users must build their own account-bound allowlist and repeat
the relevant reversible proof before enabling writes.

## Deliberate gaps

The v1 boundary excludes assets, catalog/forms, arbitrary nested models or raw
HTML, arbitrary Zero groups/molecules, cross-project moves, folders/trash
restore, generic deletion/blank-page creation, site-wide HEAD, arbitrary
custom-domain verification, full Advanced Mode compatibility, and automatic
publication. Editor drift must quarantine an adapter until a fresh lab proof is
available.
