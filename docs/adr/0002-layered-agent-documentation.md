# ADR 0002: Layered agent documentation

Status: Accepted
Date: 2026-08-13

## Context

The project must be resumable in a new chat without the user retelling history. A single long README mixes stable context, transient state, operating rules, and historical lessons.

## Decision

Use a compact `AGENTS.md`, human map in `README.md`, stable `PROJECT_CONTEXT.md`, volatile `docs/CURRENT_STATE.md`, exact `docs/NEXT_SESSION.md`, cumulative `LESSONS.md`, ADRs, worklog, and evidence/experiment registries.

## Consequences

- Fresh agents load essential rules first and progressively read detail.
- Mutable facts have one owner, reducing contradictions.
- Every material work block includes a documentation checkpoint.
