# Changelog

## 0.2.0-prealpha

- Added the typed Phase 2 MCP control plane and eleven bounded tools.
- Added ChangeSet/snapshot/publication journals with idempotency and
  fail-closed recovery rules.
- Added narrow Standard, T123, Zero, SEO, lifecycle, and publication adapter
  contracts with public unit/security coverage.
- Added page-specific HEAD read and `page.head.code.replace` inside the same
  eleven-tool surface, including full-state hashing, stale-code checks, two
  bounded rereads, rollback, and non-reconcilable ambiguity handling.
- Added the bounded `page_head_code` query; raw HEAD content remains omitted by
  default and editing does not publish.
- Added a public-safe read-only stdio smoke with no live target IDs.
- Updated the public documentation and grant draft to distinguish private lab
  evidence from the sanitized public package.

## 0.0.0-prealpha.1

- Initial public Phase 1 research harness and safety primitives.
