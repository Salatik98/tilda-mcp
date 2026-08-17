# ADR 0006 — Trusted same-session account and inventory binding

Status: accepted locally; live dedicated-CDP capture pending

## Context

Exact lab IDs are insufficient if they are paired with a different authenticated account, a partial project list, stale page ownership, or caller-supplied classification. Phase 1 therefore needs a fresh trust root before any programmatic lab write can pass.

## Decision

Binding starts only from an unauthenticated loopback HTTP CDP endpoint and an exact loopback WebSocket target whose rendered page is the authenticated top-level `https://tilda.ru/projects/` route. Remote CDP endpoints and remote WebSocket URLs are rejected before connection. One CDP connection navigates that dedicated tab through `/identity/` and each `/projects/?projectid=…` detail page twice, rereads the initial projects route, and restores the tab without reading browser storage.

The capture is accepted only when:

- every rendered `.td-sites-grid__item` has one canonical `data-project-id`, the complete card set equals the project-link set and the independent rendered used-project count, and no project-list pagination is present;
- every project detail read remains authenticated and its exact `.td-page[id^="page"]` card identities equal the independent rendered used-page count;
- every page ID has exactly one project owner;
- `/identity/` prefers exactly one canonical numeric hidden `useruid`. When no
  hidden `useruid` input exists, it may instead use only the own data-property
  `globalThis.username` when its value is a non-empty, trimmed, NFC-normalized,
  bounded string without Unicode control, format, or surrogate code points. An
  accessor, inherited property, or any present invalid/ambiguous hidden input
  blocks the fallback;
- both full inventory passes and both account-identity reads (source and value)
  are identical in the same authenticated browser session, and the original
  root inventory is unchanged after restoration.

Node revalidates the selected identity and derives its fingerprint with a
random 32-byte local machine key. Numeric `useruid` retains the existing
`HMAC-SHA-256("tilda-agent-os/account-fingerprint/v1\\0" || useruid)` input for
compatibility. The username fallback uses the source-separated input
`HMAC-SHA-256("tilda-agent-os/account-fingerprint/v1\\0" ||
"identity_global_username\\0" || username)`, preventing a numeric username from
colliding with the hidden-ID source. The raw identity is discarded after
derivation and is never logged or persisted. The versioned canonical inventory
hash is computed from that HMAC, the internally observed project-ID set, and
internally observed page ownership only. Titles, routes, domains, timestamps,
classifications, cookies, and content are excluded.

The machine key is generated only by the explicit `bind` command and stored as a regular non-symlink file directly under ignored `.tilda-runtime/`. `bind --persist` writes only the HMAC fingerprint and inventory hash to a separate digest-only `.tilda-runtime/account-binding.json`, never to `.env`, and only if the existing permanent source denylist, exact lab project, and exact lab page tuples all pass against the fresh capture. `status` never creates a key and remains fail-closed on missing, ambiguous, incomplete, or drifting evidence. A fresh in-process capture is bound to the exact CDP target for 30 seconds, but it is preflight evidence rather than a write ticket. Serialized status therefore keeps both write-blocked flags true and reports matching classification separately. Any future write adapter must repeat the binding while it owns the exact CDP connection and release mutation only inside that same transaction; caller-supplied target strings, serialized captures, and caller-fabricated snapshots are never authorization.

## Consequences

- A fabricated caller inventory cannot pass binding preflight; status requires a fresh same-session CDP capture and never emits reusable write authority.
- UI localization or markup drift that prevents count/card verification blocks writes rather than guessing completeness.
- A new project, transferred project, page ownership change, account switch, duplicate page identity, or missing safe account ID invalidates the binding.
- This decision grants no Tilda content write or publication authority; it only makes the existing lab target gates capable of evaluating live evidence.
