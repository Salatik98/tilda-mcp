# Capability status

Status meanings:

- **Implemented/tested** — generic code and local automated tests exist.
- **Privately lab-verified** — a narrow contract passed a reversible live
  experiment in an authorized isolated lab; private evidence is not shipped.
- **Under investigation** — a candidate exists but the contract is not stable.
- **Planned** — design intent only.

| Capability | Status | Boundary |
|---|---|---|
| MCP stdio transport and fourteen tool schemas | Implemented/tested | Local protocol; the public smoke is read-only. |
| Structured result/error contract | Implemented/tested | Bounded payloads and explicit state-change codes. |
| One-task authority and exact target scopes | Implemented/tested | Fresh account/inventory binding, TTL, revocation, and operation allowlist. |
| ChangeSet snapshots, journal, idempotency, stale-state checks | Implemented/tested | Local ignored runtime state; fail-closed recovery. |
| Path, symlink, lock, and source-corpus gates | Implemented/tested | Exact local project/page/record tuples are required; public corpus is empty. |
| Same-session loopback browser authority | Implemented/tested; privately lab-verified | Dedicated authenticated browser and fresh binding required. |
| Safe Standard field patch/restore | Privately lab-verified | Discovered top-level string fields only; identity/routing/control fields rejected. |
| T123 code replacement | Privately lab-verified | Full, one-literal, or bounded literal-batch replacement; editor shape is version-sensitive. |
| Zero property/clone transitions | Implemented/tested; privately lab-verified for narrow shapes | Primitive properties and known transitions only; generic discovery remains bounded. |
| Page SEO `meta_descr` patch/restore | Privately lab-verified | One exact page-setting field with full-form preservation. |
| Page-specific HEAD read/replacement | Implemented/tested; privately lab-verified | Exact page route; site-wide HEAD is excluded. |
| Same-project reference-page copy/cleanup | Implemented/tested; privately lab-verified | Adapter-owned receipt and exact source/project lineage. |
| Hover-only record-control revelation | Implemented/tested; privately lab-verified | Ownership proof only; no click or screen-coordinate mechanism. |
| Bounded copy-test capability learning | Implemented/tested | Typed trace/replay/restore only; missing or ambiguous proof fails closed. |
| Separate publication/unpublication | Privately lab-verified | Exact task-authorized page and explicit publication gate. |
| Public live verification | Privately lab-verified | One locally configured public root; no automatic publication. |
| Arbitrary Tilda editor write API | Under investigation | No universal undocumented contract is claimed. |
| Assets, catalog/forms, cross-project moves, folders/trash | Planned | Separate evidence and safety gates are required. |
| Site-wide HEAD | Planned | Page-specific proof does not establish the site-wide route/runtime contract. |
| Advanced Interface Mode compatibility | Planned | Normal mode is the current boundary; DOM/pagination/sorting drift must fail closed. |

## Evidence boundary

The public repository contains no real account identifiers, private page copy,
raw T123/Zero payloads, client domains, or live fixtures. `Privately
lab-verified` reports a project milestone without making the omitted account or
its evidence portable. A new deployment must use its own authorized account,
complete an inventory, configure a disjoint allowlist, and perform a fresh
same-session binding before any write.
