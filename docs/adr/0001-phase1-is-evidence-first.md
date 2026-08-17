# ADR 0001: Phase 1 is evidence-first

Status: Accepted
Date: 2026-08-13

## Context

The research pack proposes a full MCP architecture, while the direct Phase 1 request explicitly says not to build the final MCP yet.

## Decision

Implement only the Observatory, probes, fixtures, experiment harnesses, and proof-of-concept adapters needed to reproduce real Tilda contracts. Production MCP construction waits for Phase 1 evidence.

## Consequences

- Code is optimized for observation and reproducibility.
- Tool surfaces may remain internal CLI/HTTP research primitives.
- Build/tests alone cannot close Phase 1.
