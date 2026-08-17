# ADR 0008 — Exact extension tab over private named-probe stdio

Status: accepted locally; controlled dry bind remains blocked pending reviewed output-contract rerun

## Context

The supported external-browser runtime owns the exact Chrome-extension tab and
its tab-scoped CDP capability, but `pnpm tilda bind` is a separate Node process.
A generic localhost CDP/WebSocket relay would weaken the exact-tab boundary and
create another rendezvous/authentication surface. The browser runtime also does
not guarantee a usable global `process`, so the broker cannot infer its Node
executable from `process.execPath`.

## Decision

Trusted capture consumes the transport-neutral `TrustedBrowserSession` contract.
It exposes only `readRoot`, `readIdentity`, `readProject(projectId)`,
`restoreRoot`, and `close`; it exposes no generic CDP method, expression, URL, or
tab ID. The three DOM probes are checked-in constants with fixed SHA-256 hashes.

For an explicitly claimed external-browser tab, the parent browser runtime
imports `runExtensionBindBroker` and passes that tab object plus the exact same
tab-scoped CDP capability whose capability documentation was already read in a
separate browser-runtime call. The broker:

- accepts only the exact `https://tilda.ru/projects/` URL with no query, hash,
  credentials, or alternate origin;
- obtains only that tab's `cdp` capability and internally issues the fixed
  `Runtime.evaluate` probes and fixed Tilda read-only navigations. The freshly
  obtained capability must be strictly identical to the supplied documented
  capability;
- derives the research workspace from the broker module's own real path;
- requires an explicit absolute Node executable and containing runtime root,
  verifies regular non-symlink containment, and spawns the built CLI directly
  with `shell: false` and a hidden Windows window;
- passes only binding paths/digests and exact lab/source allowlist fields to the
  child. API keys, `NODE_OPTIONS`, `PATH`, cookies, and the rest of the parent
  environment do not cross the child boundary; the child is instructed not to
  load `.env` again;
- gives the child two private inherited pipes only: fd3 for child requests and
  fd4 for parent responses. Frames are bounded length-prefixed JSON, allow only
  one outstanding message, and use a one-shot challenge plus the checked-in
  probe hashes;
- enforces `hello → root → identity → every root-derived project → identity →
  every root-derived project → restore → close`, with monotonic sequence
  numbers. Unknown fields, replay, out-of-order calls, arbitrary project IDs,
  arbitrary expressions, and arbitrary URLs fail closed;
- uses bounded browser, CDP, pipe, child-output, and overall deadlines. A timed-
  out navigation must settle before the final out-of-band root restore. The
  direct Node child is terminated, the exact root is ensured (navigated only if
  needed), and its named probe is read twice in cleanup;
- calls the supported extension-tab `goto(url)` API with its single URL
  argument. Navigation deadlines are enforced by the broker rather than passed
  as an unsupported second argument;
- parses child stdout and diagnostic stderr into narrow schemas and returns only
  frozen structured output with broker-owned error text. Successful output must
  finish `derive`; a fail-closed capture may legitimately finish after root
  restoration or after `derive` starts but before the machine key exists. A
  blocked `ALLOWLIST_CLASSIFICATION_MISMATCH` result is admitted only with its
  exact prospective-safety object and at least one failed preflight. Parser
  rejection diagnostics expose only a fixed-enum subreason, never raw child
  output.

`--transport=extension-stdio` is private-child only and fails closed when run
standalone because fd3/fd4 and the broker marker are absent. This transport is
dry-bind only: `--persist` is rejected. A successful dry capture may create the
ignored local HMAC machine key already defined by ADR 0006, but it cannot persist
the account/inventory binding. Persistence needs a separately reviewed second
run and capability.

The implementation is a Phase 1 research broker contract, not a production
Chrome extension or Native Messaging host. It trusts the same-user local broker
module, built research tree, and explicitly supplied runtime installation; it
does not claim cryptographic extension-origin attestation. Its result is
preflight evidence only and never reusable write authorization.

## Runnable Windows research recipe

Build the fixed child first:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

In the supported browser runtime, retain the exact claimed top-level tab object
and its exact tab-scoped CDP capability. Read that capability's documentation in
a separate browser-runtime call before invoking the broker; do not have the
broker read or suppress the documentation gate. Obtain the bundled Node
executable from workspace dependencies. Import the built broker by absolute
file URL and pass the executable plus its configured runtime root explicitly:

```js
const { runExtensionBindBroker } = await import(
  "file:///ABSOLUTE/PATH/TO/tilda-mcp/dist/src/research/transports/extension-broker.js"
);

const result = await runExtensionBindBroker({
  tab: freshTildaTab,
  cdp: freshTildaCdp,
  nodeExecutablePath: "C:\\...\\dependencies\\node\\bin\\node.exe",
  nodeRuntimeRoot: "C:\\...\\dependencies\\node",
  diagnosticProgress: true,
  timeoutMs: 120000,
});
```

Do not pass a numeric tab ID, CDP method, expression, URL, environment object,
workspace path, or persistence flag; the API deliberately has none of those
parameters. Do not substitute a TCP listener or a terminal-started broker.

## Consequences

- The exact supported tab stays the sole browser authority for this dry read.
- No port, token file, browser cookie, profile, raw account ID, or generic CDP
  proxy is introduced.
- An absent/stale tab, wrong root URL, unknown project, protocol drift, child
  crash, output drift, navigation timeout, or failed root restoration blocks the
  result.
- A controlled live dry bind remains an experiment; passing local tests does
  not promote EXP-01 or authorize a Tilda write.
