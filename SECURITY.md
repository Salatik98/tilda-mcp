# Security policy

## Supported release

`1.0.0` is a public pre-release. It is lab-scoped and must not be treated as
an official Tilda integration or a production guarantee.

## Reporting a vulnerability

Use GitHub private vulnerability reporting or a private security advisory. Do
not publish exploit details, credentials, private Tilda data, or affected
account identifiers in an issue. If a private channel is unavailable, keep the
report private until one is available.

## Data that must never enter the repository

- passwords, 2FA material, API keys, cookies, auth headers, session or CSRF
  tokens;
- browser profiles, storage state, raw HAR files, or unsanitized traces;
- Leads, orders, member data, customer PII, or proprietary page content;
- real account, project, page, record, element, or custom-domain identifiers
  in public fixtures;
- screenshots or copied editor payloads that expose private content.

The public package keeps its source-corpus list empty. Each operator must build
an ignored local inventory and review a disjoint exact allowlist before any
write is even considered.

## Operational safety

Use a dedicated browser profile and a disposable lab project. A fresh account
and inventory binding, exact target scopes, task authority, expected hash or
revision, and snapshot are required. Every write follows:

```text
read → snapshot → dry-run → one semantic mutation
→ reread → exact diff → restore/rollback → reread restore
```

Editing never publishes. Publication and unpublication are separate explicit
gates. Undocumented adapters are quarantined on drift, ambiguous results, or
failed restoration; they are never blindly retried. The server rejects remote
or unclassified targets before dispatch.

See [`security/APPROVAL_POLICY.yaml`](security/APPROVAL_POLICY.yaml) and
[`security/REDACTION_RULES.yaml`](security/REDACTION_RULES.yaml) for the
machine-readable policy.
