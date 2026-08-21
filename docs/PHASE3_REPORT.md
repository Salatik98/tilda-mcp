# Phase 3 report

Date: 2026-08-20

Release: **1.0.0 public pre-release**

## Result

Phase 3 turns the narrow Phase 2 vertical slice into a practical local MCP
surface. It adds one bounded task authority, account-bound discovery, typed
audits and queries, safer Standard routing, T123 and Zero helpers,
same-project reference-page recipes, hover-only record-control revelation, and
bounded copy-test learning. The ChangeSet snapshot/hash/reread/restore model
remains the central safety boundary.

This report describes implementation and claim boundaries. It does not ship
account identifiers, raw editor payloads, or a portable live allowlist.

## MCP surface

The server exposes exactly fourteen semantic tools:

```text
tilda_status                 tilda_capabilities
tilda_authorize_task         tilda_audit
tilda_learn_capability       tilda_query
tilda_plan_changeset         tilda_apply_changeset
tilda_verify_changeset       tilda_rollback_changeset
tilda_publish                tilda_unpublish
tilda_verify_live            tilda_page_lifecycle
```

## Practical v1 boundary

Implemented and routed:

- `inventory` and `page_inventory` discovery through `tilda_query`;
- exact project/page/record/element queries and typed audits;
- safe discovered top-level Standard string-field patches;
- T123 full, one-literal, and bounded literal-batch replacements;
- bounded Zero primitive-property patches and element clones;
- same-project reference-page copying and receipt-bound cleanup;
- reproduced template recipes;
- hover-only `record_control` revelation after exact ownership proof;
- ChangeSet plan/apply/verify/rollback with idempotency and state hashes;
- separate publication/unpublication and bounded public verification;
- typed copy-test learning from sanitized trace/replay/restore evidence.

Unknown fields are preserved. Results and traces are bounded and sanitized.
Credentials, cookies, authentication headers, customer data, and raw page
content are not persisted as public evidence.

## Evidence language

`Implemented/tested` means generic code and local tests are present.
`Privately lab-verified` means the narrow contract passed a reversible live
experiment in an authorized isolated lab; that proof is intentionally omitted
from the public checkout. `Under investigation` and `Planned` are not
permissions to widen target scope.

The public package is intentionally not a replayable copy of any account. A
new operator must sign in, capture a fresh inventory, configure an exact
disjoint allowlist, bind the current session, and repeat the relevant proof.

## Unsupported or evidence-gapped

Asset upload, catalog bulk mutation, form receivers/submissions, arbitrary
nested Standard/raw HTML reconstruction, arbitrary Zero groups/molecules,
cross-project copy/move, folders/trash restore, generic delete or blank-page
creation, site-wide HEAD, arbitrary custom-domain verification, full Advanced
Interface Mode support, and automatic publication are outside v1.
