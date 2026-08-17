# Roadmap

## Phase 1 — evidence-first research primitives

- [x] CDP target discovery, inventory normalization, hashing, and status.
- [x] Fail-closed target and source-corpus policy primitives.
- [x] Loopback-only sanitized observability.
- [x] Public-safe OSS packaging and privacy scan rules.

## Phase 2 — verified vertical slice

- [x] Typed adapter contracts and an append-only ChangeSet engine.
- [x] Same-session browser authority with exact target gates.
- [x] Standard, T123, narrow Zero, and page SEO adapters.
- [x] Page-specific HEAD read and reversible replacement inside the existing
  eleven-tool ChangeSet surface, with publication unchanged.
- [x] Separate publication controller and public verifier.
- [x] Fixed page-lifecycle transaction with restoration checks.
- [x] Private isolated-lab live round-trips, source-target rejection, and
  dedicated-browser restart/rebind verification.
- [x] Public `0.2.0-prealpha` candidate with sanitized code/tests/docs.

## Phase 3 — public pre-release

- [ ] Add a documented, user-owned local ledger workflow without shipping
  account-specific fixtures.
- [ ] Publish sanitized compatibility fixture and editor-drift canary formats.
- [ ] Add more Standard families, Zero element families, and page settings only
  after separate reversible lab evidence.
- [ ] Research site-wide HEAD separately; do not generalize the page-specific
  route/runtime contract.
- [ ] Compare normal mode with Tilda Advanced Interface Mode and fail closed on
  inventory, pagination, sorting, or DOM-shape drift.
- [ ] Produce a reproducible public demo with synthetic or user-supplied lab
  data and explicit approval gates.
- [ ] Gather external users/contributors before making broader adoption claims.

## Explicitly out of scope for this pre-alpha

Production guarantees, universal Tilda coverage, arbitrary undocumented writes,
official editor-write API claims, assets/catalog/forms, cross-project moves,
trash recovery, site-wide HEAD, Advanced Interface Mode compatibility, and
automatic publication.
