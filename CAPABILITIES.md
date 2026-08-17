# Capability status

Status meanings:

- **Implemented/tested**: code and local automated tests exist in this package.
- **Live observed**: observed in an authorized Tilda session, without a public replay contract.
- **Under investigation**: a candidate mechanism exists but is not reproduced.
- **Planned**: design intent only.

| Capability | Status | Notes |
|---|---|---|
| CDP endpoint/target discovery | Implemented/tested | Selects a Tilda target semantically; no cursor coordinates. |
| Safety/status report | Implemented/tested | Reports identity and keeps write flags blocked. |
| Read-only project inventory | Implemented/tested; live observed privately | Reads project IDs/titles from semantic page state. Private inventory is not included. |
| Canonical state hashing | Implemented/tested | Stable JSON normalization and SHA-256. |
| Account/inventory-bound target gates | Implemented/tested | Requires exact binding and project/page ownership. |
| Sanitized Observatory | Implemented/tested | Loopback-only, narrow capture, fail-closed persistence. |
| Project/page semantic identity | Live observed | Cross-version stability is not yet established. |
| Standard/T123/Zero block identity | Live observed | Private source-corpus evidence is excluded. |
| Standard block settings read | Under investigation | No public live reproduction. |
| Standard field patch and restore | Under investigation | No public live reproduction. |
| T123 raw-code read/patch | Under investigation | No public live reproduction. |
| Zero Block model read/patch | Under investigation | No public live reproduction. |
| Page settings/lifecycle | Under investigation | UI observations are not a stable adapter. |
| Publication and live verification | Under investigation; blocked | Separate approval and domain gates required. |
| MCP server and tool schemas | Planned | Not present in this package. |

## Example promotion queue

The examples requested for a future public demo will be added only after proof:

1. Read page structure.
2. Update one standard-block field and restore it.
3. Read and minimally patch T123 code, then restore it.
4. Read and minimally patch one Zero Block leaf, then restore it.
5. Publish an isolated research page with explicit approval and verify the public state.

Items 2-5 are not executable examples today.
