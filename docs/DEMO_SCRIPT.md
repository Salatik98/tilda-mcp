# Demo script

**Status: public recording can use only synthetic or user-supplied lab data.**

The public package must not expose private account evidence. The default demo
is local and read-only.

## Suggested 60–120 second flow

1. Start the local MCP server and show the fourteen semantic tool registrations.
2. Run the read-only `pnpm smoke:mcp` command.
3. Show a synthetic exact target and a dry-run ChangeSet from the unit tests.
4. Show the structured result contract: target, state-change flag,
   snapshot/ChangeSet references, and evidence code.
5. Explain that apply, rollback, publication, and live verification require a
   fresh operator-owned browser session, exact local allowlist, and separate
   approval gates.
6. End on the capability table and the unsupported-scope boundary; do not imply
   universal or production coverage.

## Capture rules

- Hide account identity, real project/page/record/element IDs, domains,
  browser chrome, credentials, cookies, and authentication state.
- Do not show raw requests, headers, storage, HAR, traces, T123/Zero payloads,
  client content, Leads, orders, or private source-corpus fixtures.
- Keep the `1.0.0` status and exact capability labels visible.
- Never publish a page as part of the default demo.
