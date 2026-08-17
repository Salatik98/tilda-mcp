# Demo script

**Status: planned, not yet recordable as a working demo.**

Do not record this as a product demonstration until every operation in the script is implemented, live reproduced in an isolated lab, restored, and represented honestly in `CAPABILITIES.md`.

## Target length

60-120 seconds.

## Future verified vertical slice

1. User asks Codex to inspect an allowlisted Tilda research page.
2. Codex calls a read-only MCP inspection tool and shows semantic page/block identity.
3. Codex presents a structured ChangeSet for one heading and one CTA URL.
4. The policy engine verifies account binding, complete inventory, exact project/page ownership, and expected revision.
5. Codex applies one semantic mutation at a time.
6. The verifier rereads editor state and compares exact structural diffs.
7. With separate explicit approval, a research page is published and the public state is reread.
8. The demo ends on the evidence record, not on a save toast.

Zero Block or T123 should appear only after those adapters have independent reversible proofs. Until then, demonstrate the smaller verified slice rather than simulate missing capabilities.

## Capture rules

- Use a synthetic research page with no client content.
- Hide account identity, project/page IDs, domains, browser chrome, and auth state.
- Do not show raw requests, headers, cookies, storage, or source-corpus fixtures.
- Include the pre-alpha label and the exact capability statuses.
