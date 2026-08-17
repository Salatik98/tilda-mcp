# Demo script

**Status: public recording still pending.**

The private Phase 2 vertical slice has been verified in an authorized isolated
lab, but a public demo must use synthetic or user-supplied lab data and must
not expose the private account evidence.

## Suggested 60–120 second public flow

1. Start the local MCP server and show the eleven tool registrations.
2. Run the read-only `pnpm smoke:mcp` command.
3. Show a synthetic target and a dry-run ChangeSet in unit-test fixtures.
4. Show the structured result contract: exact target, state-change flag,
   snapshot/ChangeSet references, and an explicit evidence code.
5. Explain that apply, rollback, publication, and live verification require a
   fresh operator-owned browser session and a local allowlist.
6. End on the safety boundary and capability table; do not imply universal or
   production coverage.

## Capture rules

- Hide account identity, project/page/record/element IDs, domains, browser
  chrome, credentials, cookies, and auth state.
- Do not show raw requests, headers, storage, HAR, traces, T123/Zero payloads,
  client content, Leads, orders, or source-corpus fixtures.
- Keep the `0.2.0-prealpha` label and exact capability statuses visible.
