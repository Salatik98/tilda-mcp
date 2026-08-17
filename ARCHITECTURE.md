# Architecture

## Scope

The repository is a `0.2.0-prealpha` control plane, not a production or
universal Tilda integration. Phase 2 has a privately verified isolated-lab
vertical slice. The public checkout contains the generic implementation,
sanitized tests, and safety documentation; private live identifiers and raw
editor payloads are intentionally omitted.

## Runtime layers

```text
MCP stdio transport
        |
tool schemas + bounded result contract
        |
control engine + policy/capability gates
        |
ChangeSet engine ---- publication journal/controller
        |
same-session browser authority (loopback CDP)
        |
typed adapters: Standard / T123 / Zero / page settings / page HEAD / lifecycle
        |
Tilda authenticated editor runtime
```

### MCP surface

`src/mcp/` owns the protocol-independent tool names, input/output schemas,
bounded payload policy, and stdio server. Every result is structured and carries
an explicit code, state-change flag, target, and evidence/diagnostic reference.

### Control and authority

`src/control/` composes adapters with one exact browser session. It discovers a
dedicated authenticated Tilda tab, performs a fresh same-session inventory and
binding, checks the exact project/page/record target, and exposes only fixed
semantic operations. The authority intentionally does not expose arbitrary CDP
evaluation, arbitrary navigation, or a general JavaScript escape hatch.
The page-specific HEAD port requires the exact editor route, current-code
compare-before-write, bounded full-value handling, and two post-dispatch
rereads. It has no publication method.

### ChangeSets and recovery

`src/core/` stores content-free snapshots and append-only events beneath the
ignored `.tilda-runtime/` directory. It validates canonical IDs, expected
revision/hash, idempotency keys, stale events, locks, path containment, and
symlink boundaries. Apply, verify, and rollback are distinct operations. An
ambiguous result is journaled and quarantined; the engine never blindly retries.
The HEAD adapter's unstable reread errors are intentionally not reconciled to
success even if a later diagnostic hash happens to match, because that would
erase evidence of a normalization or timing ambiguity.

### Adapters

`src/adapters/` translates narrow, evidence-backed semantic requests into
authority-owned browser calls. Unknown fields are preserved. The implemented
contracts are deliberately small: selected Standard fields, T123 code, a few
Zero model transitions, one page SEO field, and one fixed page-lifecycle
transaction. Page-specific HEAD replacement is another typed operation inside
that same ChangeSet engine. These contracts are not a general Tilda schema;
site-wide HEAD is a separate, unproven surface.

### Research and observability

`src/research/` contains CDP discovery, inventory binding, hashing, browser
session probes, and a loopback-only sanitized Observatory. Sensitive values are
used transiently for verification or HMAC derivation and are not persisted in
the public package.

## Evidence promotion

An undocumented behavior moves through explicit evidence states:

1. source-observed hypothesis;
2. live observation in an authorized session;
3. reproduced reversible lab operation;
4. canary/restart verification against the current editor fingerprint;
5. a narrowly named MCP capability.

The private Phase 2 run reached the last state for the listed vertical-slice
operations. Public users must reproduce and review their own account-bound
lab evidence before enabling writes. A class being present in the registry is
not proof that a remote transport is safe for a different account or editor
release.

## Deliberate gaps

The public package does not claim arbitrary editor writes, all Standard block
families, all Zero element types or breakpoints, assets, catalog/forms,
cross-project moves, trash recovery, a documented Tilda write API, or production
reliability. Site-wide HEAD and Advanced Interface Mode compatibility are Phase
3 evidence gates. Editor drift must quarantine an adapter until a fresh lab
proof is available.
