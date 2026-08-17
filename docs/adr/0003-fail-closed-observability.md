# ADR 0003: Fail-closed observability

Status: Accepted
Date: 2026-08-13

## Context

Authenticated editor requests can include cookies, CSRF tokens, API credentials, form PII, and other session material.

## Decision

Sanitize every event in memory before persistence. Never persist raw HAR. Drop secret headers, redact sensitive query/body fields, and discard the entire trace when sanitization cannot guarantee safety.

## Consequences

- Some diagnostic detail is intentionally unavailable.
- Trace capture is considered failed when sanitization fails.
- Tests for redaction are a prerequisite for live tracing.
