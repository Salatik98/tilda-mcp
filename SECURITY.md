# Security policy

## Supported versions

No stable release is supported yet. The repository is pre-alpha research and must not be used as a production control plane.

## Reporting a vulnerability

After the public GitHub repository exists, use GitHub's private vulnerability reporting or a private security advisory. Do not open a public issue containing exploit details, credentials, private Tilda data, or affected account identifiers.

Until a private reporting channel is published, keep the report private and do not attach sensitive artifacts to an issue.

## Sensitive data that must never enter the repository

- passwords, 2FA material, API keys, cookies, auth headers, session or CSRF tokens;
- browser profiles, storage state, raw HAR files, or unsanitized traces;
- Leads, orders, member data, customer PII, or proprietary page content;
- real account, project, page, record, element, or domain identifiers in public fixtures.

## Operational safety

Use a dedicated browser profile and an isolated lab project. Keep writes fail-closed unless the account, complete inventory, project, page ownership, and expected state are all verified. Publication is always a separate explicit operation.

Undocumented adapters must be quarantined on drift, ambiguous results, or failed restoration. Do not blind-retry.
