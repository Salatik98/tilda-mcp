# Architecture

## Scope

The current repository is a Phase 1 research harness. It establishes safe discovery, normalization, observability, and target-gating primitives. It does not yet ship an MCP server or stable editor-write adapters.

## Implemented components

### CDP client

`src/research/cdp-client.ts` discovers browser targets, selects an exact Tilda tab, evaluates read-only probes, and receives CDP events.

### Inventory and status

`inventory.ts` reads semantic project cards from an authenticated page. `status.ts` reports CDP reachability, target identity, authentication signals, editor fingerprints, and fail-closed safety state.

### Configuration and target gates

`config.ts` validates canonical numeric IDs, exact project/page tuples, disjoint lab and read-only sets, complete live inventory coverage, account fingerprint matching, and canonical inventory hashes.

The checked-in environment is deliberately unusable for writes. Account fingerprints and inventory hashes belong only in ignored local state.

### Sanitized Observatory

`observatory.ts` captures a deliberately narrow subset of request, response, console, and mutation metadata. `security/sanitize.ts` redacts headers, query parameters, bodies, PII-shaped fields, and unsafe nested structures before persistence. Sanitizer failure aborts persistence.

## Evidence promotion path

An undocumented candidate moves through these states:

1. source observed;
2. live observed in an authorized session;
3. live reproduced on an allowlisted lab target;
4. canary verified against the current editor fingerprint;
5. exposed through a stable MCP capability.

Only the first two states exist for editor operations in this public pre-alpha package.

## Target architecture

The intended system separates:

- official Tilda API adapters;
- authenticated editor adapters;
- runtime-model adapters;
- CDP/semantic DOM fallbacks;
- a policy and approval engine;
- structured ChangeSets;
- verification and restore;
- MCP transport and tool schemas;
- compatibility canaries and editor-drift detection.

The separation prevents a UI fallback from silently becoming the contract for a supposedly semantic tool.

## Known architectural gaps

- No MCP transport or public tool schemas.
- No public, live-reproduced editor-write adapter.
- No executable immutable ledger for historical read-only source projects.
- No published compatibility corpus; private project fixtures are intentionally excluded.
- No end-to-end publish proof in the public package.
- No cross-version adapter repair loop.
