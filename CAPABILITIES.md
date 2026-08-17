# Capability status

Status meanings:

- **Implemented/tested** — generic code and local automated tests are present.
- **Privately lab-verified** — the narrow contract passed a reversible live
  experiment in an authorized isolated lab; private evidence is not shipped.
- **Under investigation** — a candidate exists but the contract is not stable.
- **Planned** — design intent only.

| Capability | Status | Boundary |
|---|---|---|
| MCP stdio transport and eleven tool schemas | Implemented/tested | Local protocol only; public smoke performs no remote writes. |
| Structured result/error contract | Implemented/tested | Bounded payloads and explicit state-change codes. |
| ChangeSet snapshots, journal, idempotency, stale-state checks | Implemented/tested | Local ignored runtime state; fail-closed recovery. |
| Path, symlink, lock, and target gates | Implemented/tested | Exact local project/page/record tuples are required. |
| Same-session loopback browser authority | Implemented/tested; privately lab-verified | Dedicated authenticated browser and fresh binding required. |
| Standard field patch/restore | Privately lab-verified | Narrow tested Standard field shapes only. |
| T123 code replace/restore | Privately lab-verified | Code-only replacement; editor synchronization is version-sensitive. |
| Zero leaf/responsive/clone transitions | Privately lab-verified | Only the tested model shapes/elements/breakpoints. |
| Page SEO `meta_descr` patch/restore | Privately lab-verified | Full-form preservation with one semantic field diff. |
| Page-specific HEAD read | Implemented/tested; privately lab-verified | Exact page query; payload omitted by default and bounded only when requested. |
| `page.head.code.replace` | Implemented/tested; privately lab-verified | Full page-specific HEAD replacement with two rereads, unchanged publication state, rollback, and fail-closed ambiguity handling. |
| Fixed page lifecycle | Privately lab-verified | Duplicate/parity/reorder/restore/cleanup transaction only. |
| Separate publication/unpublication | Privately lab-verified | Exact lab page and explicit approval; never an edit side effect. |
| Public live verification | Privately lab-verified | Cache-busted HTTPS checks against a locally configured public root. |
| Arbitrary Tilda editor write API | Under investigation | No universal undocumented contract is claimed. |
| Assets, catalog/forms, cross-project moves, trash recovery | Planned | Separate evidence and safety gates required. |
| Site-wide HEAD | Planned for Phase 3 | Page-specific proof does not establish the site-wide contract. |
| Advanced Interface Mode compatibility | Planned for Phase 3 | Normal-mode inventory/binding is proven; DOM, pagination, sorting, and batch behavior must be compared separately. |

## Evidence boundary

The public repository contains no real account identifiers, private page copy,
raw T123/Zero payloads, domain names, or live fixtures. The `Privately
lab-verified` label reports the project milestone without making the omitted
account or its evidence portable. A new deployment must use its own authorized
account, complete inventory, disjoint lab allowlist, and fresh same-session
binding.
