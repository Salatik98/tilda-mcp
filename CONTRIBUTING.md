# Contributing

Tilda Agent OS is pre-alpha. Contributions should improve evidence quality, safety, portability, or documentation before expanding the claimed surface area.

## Before opening a pull request

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Evidence requirements

For undocumented Tilda behavior, include:

- the exact capability and evidence status;
- a sanitized target description with no customer identifiers;
- setup and recovery steps;
- before/after structural hashes;
- one semantic mutation only;
- reread and exact diff;
- verified restore and restoration reread;
- current editor/browser fingerprints where they can be shared safely;
- failure behavior and quarantine conditions.

Never promote community code or a UI observation directly to a stable adapter.

## Privacy requirements

Do not submit real project/page/record IDs, client names, page copy, domains, screenshots, raw HTML, form submissions, Leads, orders, email addresses, phone numbers, credentials, cookies, browser profiles, HAR files, or session traces. Use reserved examples such as `example.test` and synthetic IDs.

If a fixture is necessary, minimize it, replace identifiers deterministically, remove content, and document the sanitization method.

## Change scope

- Keep editor reads and writes separate.
- Keep edits and publication separate.
- Preserve unknown raw fields; do not rebuild undocumented objects from assumptions.
- Add regression tests for every sanitizer or target-gate change.
- Update `CAPABILITIES.md` only to the evidence level the artifact proves.

By contributing, you agree that your contribution is licensed under Apache-2.0.
