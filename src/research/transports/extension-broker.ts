import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  EXTENSION_STDIO_PROTOCOL_VERSION,
  ExtensionStdioJsonChannel,
  ExtensionStdioTransportError,
  type ExtensionStdioRequest,
  type ExtensionStdioResponse,
} from "./extension-stdio.js";
import {
  IDENTITY_DOM_PROBE,
  PROJECTS_ROOT_DOM_PROBE,
  PROJECT_PAGES_DOM_PROBE,
  TRUSTED_PROBE_HASHES,
  type IdentityProbe,
  type ProjectPagesProbe,
  type ProjectsRootProbe,
} from "../probes.js";
import { hashLiveInventory, type LiveInventory } from "../config.js";

const CANONICAL_ID = /^[1-9][0-9]*$/;
const MAX_OPERATION_TIMEOUT_MS = 12_000;
const MAX_CHILD_OUTPUT_BYTES = 262_144;

export interface ExactClaimedExtensionTab {
  readonly capabilities: {
    get(id: string): Promise<unknown>;
  };
  url(): Promise<string | undefined>;
  goto(url: string): Promise<void>;
}

export interface ExactClaimedExtensionTabCdp {
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
}

export type ExtensionBindBrokerFailureStage =
  | "setup.workspace"
  | "setup.node"
  | "setup.config"
  | "setup.tab-url"
  | "setup.cdp-capability"
  | "child.spawn"
  | "protocol.channel"
  | "protocol.hello"
  | "protocol.root.url"
  | "protocol.root.cdp"
  | "protocol.root.cdp-envelope"
  | "protocol.root.probe-state"
  | "protocol.identity.goto"
  | "protocol.identity.url"
  | "protocol.identity.cdp"
  | "protocol.identity.cdp-envelope"
  | "protocol.identity.probe-state"
  | "protocol.project.goto"
  | "protocol.project.url"
  | "protocol.project.cdp"
  | "protocol.project.cdp-envelope"
  | "protocol.project.probe-state"
  | "protocol.restore.goto"
  | "protocol.restore.url"
  | "protocol.restore.cdp"
  | "protocol.restore.cdp-envelope"
  | "protocol.restore.probe-state"
  | "protocol.close"
  | "protocol.output"
  | "cleanup.child"
  | "cleanup.pending-navigation"
  | "cleanup.url"
  | "cleanup.goto"
  | "cleanup.cdp"
  | "cleanup.cdp-envelope"
  | "cleanup.probe-state";

export type ExtensionBindBrokerOutputSubreason =
  | "stdout_json_invalid"
  | "top_level_shape_invalid"
  | "success_envelope_invalid"
  | "blocked_envelope_invalid"
  | "error_envelope_invalid"
  | "binding_shape_invalid"
  | "binding_status_invalid"
  | "safety_shape_invalid"
  | "transcript_admission_invalid"
  | "progress_stream_invalid"
  | "progress_event_invalid"
  | "progress_order_invalid"
  | "unexpected_progress";

export interface ExtensionBindBrokerFailurePoint {
  readonly stage: ExtensionBindBrokerFailureStage;
  readonly code: string;
  readonly subreason?: ExtensionBindBrokerOutputSubreason;
}

export interface ExtensionBindBrokerFailureDiagnostics {
  readonly primary: ExtensionBindBrokerFailurePoint | null;
  readonly restore: ExtensionBindBrokerFailurePoint | null;
}

interface BrokerDiagnosticTracker {
  currentStage: ExtensionBindBrokerFailureStage;
  primary: ExtensionBindBrokerFailurePoint | null;
  restore: ExtensionBindBrokerFailurePoint | null;
}

interface ProbeDiagnosticStages {
  readonly goto: ExtensionBindBrokerFailureStage;
  readonly url: ExtensionBindBrokerFailureStage;
  readonly cdp: ExtensionBindBrokerFailureStage;
  readonly cdpEnvelope: ExtensionBindBrokerFailureStage;
  readonly probeState: ExtensionBindBrokerFailureStage;
}

const PROBE_DIAGNOSTIC_STAGES = Object.freeze({
  root: Object.freeze({
    goto: "protocol.root.url",
    url: "protocol.root.url",
    cdp: "protocol.root.cdp",
    cdpEnvelope: "protocol.root.cdp-envelope",
    probeState: "protocol.root.probe-state",
  }),
  identity: Object.freeze({
    goto: "protocol.identity.goto",
    url: "protocol.identity.url",
    cdp: "protocol.identity.cdp",
    cdpEnvelope: "protocol.identity.cdp-envelope",
    probeState: "protocol.identity.probe-state",
  }),
  project: Object.freeze({
    goto: "protocol.project.goto",
    url: "protocol.project.url",
    cdp: "protocol.project.cdp",
    cdpEnvelope: "protocol.project.cdp-envelope",
    probeState: "protocol.project.probe-state",
  }),
  restore: Object.freeze({
    goto: "protocol.restore.goto",
    url: "protocol.restore.url",
    cdp: "protocol.restore.cdp",
    cdpEnvelope: "protocol.restore.cdp-envelope",
    probeState: "protocol.restore.probe-state",
  }),
  cleanup: Object.freeze({
    goto: "cleanup.goto",
    url: "cleanup.url",
    cdp: "cleanup.cdp",
    cdpEnvelope: "cleanup.cdp-envelope",
    probeState: "cleanup.probe-state",
  }),
} satisfies Readonly<Record<string, ProbeDiagnosticStages>>);

interface BrokerContext {
  readonly tab: ExactClaimedExtensionTab;
  readonly cdp: ExactClaimedExtensionTabCdp;
  readonly rootUrl: URL;
  readonly overallDeadline: number;
  readonly diagnostics: BrokerDiagnosticTracker;
  pendingNavigation: Promise<void> | null;
}

export interface BrokerTranscript {
  readonly projectCount: number;
  readonly fullTwoPassCompleted: boolean;
}

type BrokerStage =
  | "await_hello"
  | "await_root"
  | "await_identity_1"
  | "await_projects_1"
  | "await_identity_2"
  | "await_projects_2"
  | "await_restore"
  | "failed"
  | "restored";

class BrokerProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrokerProtocolError";
    this.code = code;
  }
}

class ChildOutputRejectedError extends ExtensionStdioTransportError {
  readonly subreason: ExtensionBindBrokerOutputSubreason;

  constructor(subreason: ExtensionBindBrokerOutputSubreason) {
    super(
      "EXTENSION_CHILD_OUTPUT_REJECTED",
      "The bind child emitted output outside the sanitized bind-result schema.",
    );
    this.name = "ChildOutputRejectedError";
    this.subreason = subreason;
  }
}

export class ExtensionBindBrokerRunError extends ExtensionStdioTransportError {
  readonly diagnostics: ExtensionBindBrokerFailureDiagnostics;

  constructor(diagnostics: ExtensionBindBrokerFailureDiagnostics) {
    super(
      "EXTENSION_BIND_BROKER_FAILED",
      "The extension bind broker stopped; inspect its sanitized failure stages and codes.",
    );
    this.name = "ExtensionBindBrokerRunError";
    this.diagnostics = Object.freeze({
      primary: diagnostics.primary === null ? null : Object.freeze({ ...diagnostics.primary }),
      restore: diagnostics.restore === null ? null : Object.freeze({ ...diagnostics.restore }),
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SANITIZED_FAILURE_CODES = new Set([
  "BROWSER_API_ERROR",
  "EACCES",
  "EEXIST",
  "EINVAL",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "EPIPE",
  "ETIMEDOUT",
  "EXTENSION_BIND_BROKER_FAILED",
  "EXTENSION_BROKER_REJECTED",
  "EXTENSION_BROKER_TIMEOUT",
  "EXTENSION_CDP_UNAVAILABLE",
  "EXTENSION_CHANNEL_CLOSED",
  "EXTENSION_CHANNEL_EOF",
  "EXTENSION_CHANNEL_TIMEOUT",
  "EXTENSION_CHILD_EARLY_EXIT",
  "EXTENSION_CHILD_FAILED",
  "EXTENSION_CHILD_OUTPUT_REJECTED",
  "EXTENSION_CHILD_PATH_REJECTED",
  "EXTENSION_CHILD_TERMINATED",
  "EXTENSION_CONCURRENT_RECEIVE_REJECTED",
  "EXTENSION_FRAME_BURST_REJECTED",
  "EXTENSION_FRAME_JSON_REJECTED",
  "EXTENSION_FRAME_SIZE_REJECTED",
  "EXTENSION_FRAME_TRUNCATED",
  "EXTENSION_HANDSHAKE_REJECTED",
  "EXTENSION_NAMED_PROBE_FAILED",
  "EXTENSION_NAMED_PROBE_TIMEOUT",
  "EXTENSION_NODE_PATH_REJECTED",
  "EXTENSION_PRIVATE_PIPE_FAILED",
  "EXTENSION_PROJECT_ID_REJECTED",
  "EXTENSION_REQUEST_ORDER_REJECTED",
  "EXTENSION_REQUEST_REJECTED",
  "EXTENSION_RESPONSE_REJECTED",
  "EXTENSION_ROOT_PROBE_REJECTED",
  "EXTENSION_SAFE_CONFIG_REJECTED",
  "EXTENSION_TAB_NOT_ROOT",
  "EXTENSION_TIMEOUT_REJECTED",
  "EXTENSION_TRANSPORT_NOT_ATTACHED",
]);

function sanitizedFailureCode(error: unknown): string {
  const code = nodeErrorCode(error);
  return code !== null && SANITIZED_FAILURE_CODES.has(code) ? code : "BROWSER_API_ERROR";
}

function failurePoint(
  stage: ExtensionBindBrokerFailureStage,
  error: unknown,
): ExtensionBindBrokerFailurePoint {
  return Object.freeze({
    stage,
    code: sanitizedFailureCode(error),
    ...(stage === "protocol.output" && error instanceof ChildOutputRejectedError
      ? { subreason: error.subreason }
      : {}),
  });
}

function recordPrimaryFailure(tracker: BrokerDiagnosticTracker, error: unknown): void {
  tracker.primary ??= failurePoint(tracker.currentStage, error);
}

function recordRestoreFailure(tracker: BrokerDiagnosticTracker, error: unknown): void {
  tracker.restore ??= failurePoint(tracker.currentStage, error);
}

function recordFailureAtStage(
  tracker: BrokerDiagnosticTracker,
  stage: ExtensionBindBrokerFailureStage,
  error: unknown,
): void {
  tracker.currentStage = stage;
  if (stage.startsWith("cleanup.")) {
    if (tracker.restore === null || tracker.restore.stage === "cleanup.child") {
      tracker.restore = failurePoint(stage, error);
    }
  } else {
    tracker.primary ??= failurePoint(stage, error);
  }
}

async function stagedBrokerOperation<T>(
  tracker: BrokerDiagnosticTracker,
  stage: ExtensionBindBrokerFailureStage,
  operation: () => Promise<T>,
): Promise<T> {
  tracker.currentStage = stage;
  try {
    return await operation();
  } catch (error) {
    recordFailureAtStage(tracker, stage, error);
    throw error;
  }
}

function throwAtStage(
  tracker: BrokerDiagnosticTracker,
  stage: ExtensionBindBrokerFailureStage,
  error: unknown,
): never {
  recordFailureAtStage(tracker, stage, error);
  throw error;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function assertRootUrl(value: string | undefined): URL {
  if (value === undefined) {
    throw new BrokerProtocolError(
      "EXTENSION_TAB_NOT_ROOT",
      "The explicitly claimed extension tab has no readable URL.",
    );
  }
  const url = new URL(value);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/projects/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new BrokerProtocolError(
      "EXTENSION_TAB_NOT_ROOT",
      "The explicitly claimed extension tab must already be the top-level Tilda projects route.",
    );
  }
  return url;
}

function normalizeTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new BrokerProtocolError(
      "EXTENSION_REQUEST_REJECTED",
      "Named probe timeout is invalid.",
    );
  }
  return Math.min(value as number, MAX_OPERATION_TIMEOUT_MS);
}

function exactUrl(actualValue: string | undefined, expected: URL): boolean {
  if (actualValue === undefined) return false;
  try {
    const actual = new URL(actualValue);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search &&
      actual.hash === expected.hash &&
      actual.username === expected.username &&
      actual.password === expected.password
    );
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function remainingDeadlineMs(deadline: number, maximumMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    throw new BrokerProtocolError(
      "EXTENSION_BROKER_TIMEOUT",
      "The exact-tab broker exceeded its bounded overall deadline.",
    );
  }
  return Math.min(maximumMs, remaining);
}

async function boundedBrokerOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BrokerProtocolError("EXTENSION_BROKER_TIMEOUT", message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function evaluateNamedProbe<T>(
  context: BrokerContext,
  expression: string,
  expectedUrl: URL,
  timeoutMs: number,
  stages: ProbeDiagnosticStages,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const probeDeadline = Math.min(deadline, context.overallDeadline);
  while (Date.now() < probeDeadline) {
    const currentUrl = await stagedBrokerOperation(
      context.diagnostics,
      stages.url,
      () =>
        boundedBrokerOperation(
          context.tab.url(),
          remainingDeadlineMs(probeDeadline, 5_000),
          "The exact extension tab URL read exceeded its deadline.",
        ),
    );
    if (!exactUrl(currentUrl, expectedUrl)) {
      await delay(125);
      continue;
    }
    const operationTimeoutMs = remainingDeadlineMs(probeDeadline, 10_000);
    const raw = await stagedBrokerOperation(
      context.diagnostics,
      stages.cdp,
      () =>
        boundedBrokerOperation(
          context.cdp.send(
            "Runtime.evaluate",
            {
              expression,
              returnByValue: true,
              awaitPromise: true,
              userGesture: false,
            },
            { timeoutMs: operationTimeoutMs },
          ),
          operationTimeoutMs,
          "The exact-tab checked-in probe exceeded its deadline.",
        ),
    );
    context.diagnostics.currentStage = stages.cdpEnvelope;
    if (!isObject(raw) || !isObject(raw.result)) {
      throwAtStage(
        context.diagnostics,
        stages.cdpEnvelope,
        new BrokerProtocolError(
          "EXTENSION_NAMED_PROBE_FAILED",
          "The exact-tab CDP capability returned an invalid named-probe envelope.",
        ),
      );
    }
    if (raw.exceptionDetails !== undefined) {
      throwAtStage(
        context.diagnostics,
        stages.cdpEnvelope,
        new BrokerProtocolError(
          "EXTENSION_NAMED_PROBE_FAILED",
          "The exact-tab CDP capability rejected a checked-in named probe.",
        ),
      );
    }
    context.diagnostics.currentStage = stages.probeState;
    const value = raw.result.value;
    if (
      isObject(value) &&
      value.uiReady === true &&
      exactUrl(typeof value.href === "string" ? value.href : undefined, expectedUrl)
    ) {
      return value as T;
    }
    await delay(125);
  }
  throwAtStage(
    context.diagnostics,
    stages.probeState,
    new BrokerProtocolError(
      "EXTENSION_NAMED_PROBE_TIMEOUT",
      "The exact claimed tab did not reach the expected named-probe state before the deadline.",
    ),
  );
}

async function navigateAndProbe<T>(
  context: BrokerContext,
  expectedUrl: URL,
  expression: string,
  timeoutMs: number,
  stages: ProbeDiagnosticStages,
): Promise<T> {
  const navigationTimeoutMs = remainingDeadlineMs(context.overallDeadline, timeoutMs);
  let trackedNavigation: Promise<void>;
  const rawNavigation = stagedBrokerOperation(context.diagnostics, stages.goto, () =>
    context.tab.goto(expectedUrl.href),
  );
  trackedNavigation = rawNavigation.finally(() => {
    if (context.pendingNavigation === trackedNavigation) context.pendingNavigation = null;
  });
  context.pendingNavigation = trackedNavigation;
  await boundedBrokerOperation(
    trackedNavigation,
    navigationTimeoutMs,
    "The exact extension tab navigation exceeded its deadline.",
  );
  return evaluateNamedProbe<T>(context, expression, expectedUrl, timeoutMs, stages);
}

async function ensureUrlAndProbe<T>(
  context: BrokerContext,
  expectedUrl: URL,
  expression: string,
  timeoutMs: number,
  stages: ProbeDiagnosticStages,
): Promise<T> {
  const currentUrl = await stagedBrokerOperation(
    context.diagnostics,
    stages.url,
    () =>
      boundedBrokerOperation(
        context.tab.url(),
        remainingDeadlineMs(context.overallDeadline, 5_000),
        "The exact extension tab URL read exceeded its deadline.",
      ),
  );
  if (exactUrl(currentUrl, expectedUrl)) {
    return evaluateNamedProbe<T>(context, expression, expectedUrl, timeoutMs, stages);
  }
  return navigateAndProbe<T>(context, expectedUrl, expression, timeoutMs, stages);
}

async function createBrokerContext(
  tab: ExactClaimedExtensionTab,
  documentedCdp: ExactClaimedExtensionTabCdp,
  overallDeadline: number,
  diagnostics: BrokerDiagnosticTracker,
): Promise<BrokerContext> {
  const rootUrl = assertRootUrl(
    await stagedBrokerOperation(
      diagnostics,
      "setup.tab-url",
      () =>
        boundedBrokerOperation(
          tab.url(),
          remainingDeadlineMs(overallDeadline, 5_000),
          "The exact extension tab URL read exceeded its deadline.",
        ),
    ),
  );
  const capability = await stagedBrokerOperation(
    diagnostics,
    "setup.cdp-capability",
    () =>
      boundedBrokerOperation(
        tab.capabilities.get("cdp"),
        remainingDeadlineMs(overallDeadline, 5_000),
        "The exact extension tab CDP capability lookup exceeded its deadline.",
      ),
  );
  if (
    capability !== documentedCdp ||
    !isObject(documentedCdp) ||
    typeof documentedCdp.send !== "function"
  ) {
    throw new BrokerProtocolError(
      "EXTENSION_CDP_UNAVAILABLE",
      "The exact claimed extension tab does not expose the supplied documented CDP capability.",
    );
  }
  return {
    tab,
    cdp: documentedCdp,
    rootUrl,
    overallDeadline,
    diagnostics,
    pendingNavigation: null,
  };
}

function parseRequest(value: unknown, expectedSequence: number): ExtensionStdioRequest {
  if (!isObject(value)) {
    throw new BrokerProtocolError("EXTENSION_REQUEST_REJECTED", "Extension request is not an object.");
  }
  if (
    value.version !== EXTENSION_STDIO_PROTOCOL_VERSION ||
    value.sequence !== expectedSequence ||
    typeof value.operation !== "string"
  ) {
    throw new BrokerProtocolError(
      "EXTENSION_REQUEST_REJECTED",
      "Extension request version, sequence, or operation is invalid.",
    );
  }
  const operation = value.operation;
  const allowedKeys =
    operation === "bind.hello"
      ? ["challenge", "operation", "probeHashes", "sequence", "version"]
      : operation === "bind.project"
        ? ["operation", "projectId", "sequence", "timeoutMs", "version"]
        : operation === "bind.close"
          ? ["operation", "sequence", "version"]
          : ["operation", "sequence", "timeoutMs", "version"];
  if (!exactKeys(value, allowedKeys)) {
    throw new BrokerProtocolError(
      "EXTENSION_REQUEST_REJECTED",
      "Extension request contains missing or unrecognized fields.",
    );
  }
  if (
    ![
      "bind.hello",
      "bind.root",
      "bind.identity",
      "bind.project",
      "bind.restore",
      "bind.close",
    ].includes(operation)
  ) {
    throw new BrokerProtocolError(
      "EXTENSION_REQUEST_REJECTED",
      "Extension request operation is not a named bind operation.",
    );
  }
  return value as unknown as ExtensionStdioRequest;
}

function success(sequence: number, result: unknown): ExtensionStdioResponse {
  return {
    version: EXTENSION_STDIO_PROTOCOL_VERSION,
    sequence,
    ok: true,
    result,
  };
}

function failure(sequence: number, error: unknown): ExtensionStdioResponse {
  return {
    version: EXTENSION_STDIO_PROTOCOL_VERSION,
    sequence,
    ok: false,
    error: {
      code: error instanceof BrokerProtocolError ? error.code : "EXTENSION_NAMED_PROBE_FAILED",
      message:
        error instanceof BrokerProtocolError
          ? error.message
          : "The exact-tab broker could not complete the named read-only operation.",
    },
  };
}

export async function serveExtensionStdioBroker(
  tab: ExactClaimedExtensionTab,
  documentedCdp: ExactClaimedExtensionTabCdp,
  channel: ExtensionStdioJsonChannel,
  timeoutMs = 120_000,
): Promise<BrokerTranscript> {
  const boundedTimeoutMs = Math.max(12_000, Math.min(timeoutMs, 180_000));
  const diagnostics: BrokerDiagnosticTracker = {
    currentStage: "setup.tab-url",
    primary: null,
    restore: null,
  };
  let context: BrokerContext | null = null;
  try {
    context = await createBrokerContext(
      tab,
      documentedCdp,
      Date.now() + boundedTimeoutMs,
      diagnostics,
    );
    return await serveExtensionStdioBrokerWithContext(context, channel);
  } finally {
    try {
      if (context !== null) await restoreExactRootOutOfBand(context);
    } finally {
      channel.close();
    }
  }
}

async function receiveBrokerRequest(
  context: BrokerContext,
  channel: ExtensionStdioJsonChannel,
): Promise<unknown> {
  context.diagnostics.currentStage = "protocol.channel";
  const timeoutMs = remainingDeadlineMs(context.overallDeadline, 30_000);
  return boundedBrokerOperation(
    channel.receive(timeoutMs),
    timeoutMs,
    "The bind child did not send its next named request before the broker deadline.",
  );
}

async function sendBrokerResponse(
  context: BrokerContext,
  channel: ExtensionStdioJsonChannel,
  response: ExtensionStdioResponse,
): Promise<void> {
  context.diagnostics.currentStage = "protocol.channel";
  const timeoutMs = remainingDeadlineMs(context.overallDeadline, 5_000);
  await boundedBrokerOperation(
    channel.send(response),
    timeoutMs,
    "The broker could not write its bounded response to the private child pipe.",
  );
}

async function serveExtensionStdioBrokerWithContext(
  context: BrokerContext,
  channel: ExtensionStdioJsonChannel,
): Promise<BrokerTranscript> {
  let stage: BrokerStage = "await_hello";
  let sequence = 0;
  let projectIds: string[] = [];
  let projectIndex = 0;
  let fullTwoPassCompleted = false;

  for (;;) {
    const request = parseRequest(await receiveBrokerRequest(context, channel), sequence + 1);
    sequence = request.sequence;
    try {
      switch (request.operation) {
        case "bind.hello": {
          context.diagnostics.currentStage = "protocol.hello";
          if (stage !== "await_hello") {
            throw new BrokerProtocolError("EXTENSION_REQUEST_ORDER_REJECTED", "Handshake cannot be replayed.");
          }
          if (
            typeof request.challenge !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.challenge) ||
            !isObject(request.probeHashes) ||
            request.probeHashes.projectsRoot !== TRUSTED_PROBE_HASHES.projectsRoot ||
            request.probeHashes.identity !== TRUSTED_PROBE_HASHES.identity ||
            request.probeHashes.projectPages !== TRUSTED_PROBE_HASHES.projectPages
          ) {
            throw new BrokerProtocolError(
              "EXTENSION_HANDSHAKE_REJECTED",
              "Extension challenge or checked-in probe hashes do not match.",
            );
          }
          stage = "await_root";
          await sendBrokerResponse(context, channel, success(sequence, { challenge: request.challenge }));
          break;
        }
        case "bind.root": {
          context.diagnostics.currentStage = "protocol.root.probe-state";
          if (stage !== "await_root") {
            throw new BrokerProtocolError("EXTENSION_REQUEST_ORDER_REJECTED", "Root probe is out of order.");
          }
          const result = await evaluateNamedProbe<ProjectsRootProbe>(
            context,
            PROJECTS_ROOT_DOM_PROBE,
            context.rootUrl,
            normalizeTimeout(request.timeoutMs),
            PROBE_DIAGNOSTIC_STAGES.root,
          );
          if (
            !Array.isArray(result.projectIds) ||
            result.projectIds.length === 0 ||
            result.projectIds.some((id) => typeof id !== "string" || !CANONICAL_ID.test(id)) ||
            new Set(result.projectIds).size !== result.projectIds.length
          ) {
            throw new BrokerProtocolError(
              "EXTENSION_ROOT_PROBE_REJECTED",
              "Root named probe did not return a canonical project set.",
            );
          }
          projectIds = [...result.projectIds];
          projectIndex = 0;
          stage = "await_identity_1";
          await sendBrokerResponse(context, channel, success(sequence, result));
          break;
        }
        case "bind.identity": {
          context.diagnostics.currentStage = "protocol.identity.probe-state";
          if (stage !== "await_identity_1" && stage !== "await_identity_2") {
            throw new BrokerProtocolError("EXTENSION_REQUEST_ORDER_REJECTED", "Identity probe is out of order.");
          }
          const result = await navigateAndProbe<IdentityProbe>(
            context,
            new URL("https://tilda.ru/identity/"),
            IDENTITY_DOM_PROBE,
            normalizeTimeout(request.timeoutMs),
            PROBE_DIAGNOSTIC_STAGES.identity,
          );
          projectIndex = 0;
          stage = stage === "await_identity_1" ? "await_projects_1" : "await_projects_2";
          await sendBrokerResponse(context, channel, success(sequence, result));
          break;
        }
        case "bind.project": {
          context.diagnostics.currentStage = "protocol.project.probe-state";
          if (stage !== "await_projects_1" && stage !== "await_projects_2") {
            throw new BrokerProtocolError("EXTENSION_REQUEST_ORDER_REJECTED", "Project probe is out of order.");
          }
          const expectedProjectId = projectIds[projectIndex];
          if (
            expectedProjectId === undefined ||
            request.projectId !== expectedProjectId ||
            !CANONICAL_ID.test(request.projectId)
          ) {
            throw new BrokerProtocolError(
              "EXTENSION_PROJECT_ID_REJECTED",
              "Project probe must use the next canonical ID captured by the root probe.",
            );
          }
          const url = new URL("https://tilda.ru/projects/");
          url.searchParams.set("projectid", expectedProjectId);
          const result = await navigateAndProbe<ProjectPagesProbe>(
            context,
            url,
            PROJECT_PAGES_DOM_PROBE,
            normalizeTimeout(request.timeoutMs),
            PROBE_DIAGNOSTIC_STAGES.project,
          );
          projectIndex += 1;
          if (projectIndex === projectIds.length) {
            projectIndex = 0;
            stage = stage === "await_projects_1" ? "await_identity_2" : "await_restore";
          }
          await sendBrokerResponse(context, channel, success(sequence, result));
          break;
        }
        case "bind.restore": {
          context.diagnostics.currentStage = "protocol.restore.probe-state";
          if (stage === "await_hello" || stage === "restored") {
            throw new BrokerProtocolError("EXTENSION_REQUEST_ORDER_REJECTED", "Restore is unavailable in this state.");
          }
          const completedBothPasses = stage === "await_restore";
          const result = await ensureUrlAndProbe<ProjectsRootProbe>(
            context,
            context.rootUrl,
            PROJECTS_ROOT_DOM_PROBE,
            normalizeTimeout(request.timeoutMs),
            PROBE_DIAGNOSTIC_STAGES.restore,
          );
          fullTwoPassCompleted = completedBothPasses;
          stage = "restored";
          await sendBrokerResponse(context, channel, success(sequence, result));
          break;
        }
        case "bind.close": {
          context.diagnostics.currentStage = "protocol.close";
          if (stage !== "restored") {
            throw new BrokerProtocolError(
              "EXTENSION_REQUEST_ORDER_REJECTED",
              "Close is allowed only after the exact root restore completes.",
            );
          }
          await sendBrokerResponse(context, channel, success(sequence, { closed: true }));
          return { projectCount: projectIds.length, fullTwoPassCompleted };
        }
      }
    } catch (error) {
      recordPrimaryFailure(context.diagnostics, error);
      await sendBrokerResponse(context, channel, failure(sequence, error));
      if (request.operation === "bind.restore") stage = "failed";
      else if (request.operation !== "bind.close") stage = "failed";
      if (error instanceof BrokerProtocolError && error.code.includes("ORDER_REJECTED")) {
        throw error;
      }
    }
  }
}

async function collectBounded(stream: Readable, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    total += buffer.byteLength;
    if (total > MAX_CHILD_OUTPUT_BYTES) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_CHILD_OUTPUT_REJECTED",
        `${label} exceeded the bounded output limit.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const PROGRESS_PHASES = new Set([
  "root",
  "identity_pass_1",
  "project_pass_1",
  "identity_pass_2",
  "project_pass_2",
  "restore_root",
  "derive",
]);

export interface ExtensionBindBrokerProgress {
  readonly phase: string;
  readonly state: "started" | "completed";
  readonly elapsedMs: number;
  readonly projectOrdinal?: number;
  readonly projectCount?: number;
}

function outputRejected(subreason: ExtensionBindBrokerOutputSubreason): never {
  throw new ChildOutputRejectedError(subreason);
}

function safeMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function canonicalIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && CANONICAL_ID.test(item)) &&
    new Set(value).size === value.length
  );
}

function assertSafeBindingOutput(value: unknown): void {
  if (!isObject(value) || typeof value.status !== "string") {
    outputRejected("binding_shape_invalid");
  }
  if (value.status === "BLOCKED") {
    if (
      !exactKeys(value, ["code", "message", "status"]) ||
      typeof value.code !== "string" ||
      !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.code) ||
      !safeMessage(value.message)
    ) {
      outputRejected("binding_shape_invalid");
    }
    return;
  }
  if (
    value.status !== "BOUND" ||
    !exactKeys(value, [
      "accountFingerprint",
      "captureContext",
      "capturedAt",
      "inventory",
      "inventoryHash",
      "pageCount",
      "privacy",
      "projectCount",
      "route",
      "source",
      "status",
    ]) ||
    value.source !== "trusted_same_session_cdp" ||
    value.route !== "/projects/" ||
    typeof value.capturedAt !== "string" ||
    Number.isNaN(Date.parse(value.capturedAt)) ||
    typeof value.accountFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.accountFingerprint) ||
    typeof value.inventoryHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.inventoryHash) ||
    !Number.isSafeInteger(value.projectCount) ||
    (value.projectCount as number) < 1 ||
    !Number.isSafeInteger(value.pageCount) ||
    (value.pageCount as number) < 0 ||
    !isObject(value.captureContext) ||
    !exactKeys(value.captureContext, ["cdpTargetId", "expiresAt"]) ||
    typeof value.captureContext.cdpTargetId !== "string" ||
    !/^extension-stdio:[a-f0-9]{64}$/u.test(value.captureContext.cdpTargetId) ||
    typeof value.captureContext.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.captureContext.expiresAt)) ||
    !isObject(value.privacy) ||
    !exactKeys(value.privacy, [
      "cookiesOrSessionDataPersisted",
      "rawAccountIdPersisted",
      "titlesOrContentPersisted",
    ]) ||
    value.privacy.cookiesOrSessionDataPersisted !== false ||
    value.privacy.rawAccountIdPersisted !== false ||
    value.privacy.titlesOrContentPersisted !== false ||
    !isObject(value.inventory) ||
    !exactKeys(value.inventory, ["accountFingerprint", "pageOwnership", "projectIds"]) ||
    value.inventory.accountFingerprint !== value.accountFingerprint ||
    !canonicalIdArray(value.inventory.projectIds) ||
    value.inventory.projectIds.length !== value.projectCount ||
    !isObject(value.inventory.pageOwnership)
  ) {
    outputRejected("binding_shape_invalid");
  }
  const capturedAtMs = Date.parse(value.capturedAt);
  const expiresAtMs = Date.parse(value.captureContext.expiresAt);
  const now = Date.now();
  if (
    capturedAtMs > now + 5_000 ||
    now - capturedAtMs > 180_000 ||
    expiresAtMs <= now ||
    expiresAtMs - capturedAtMs > 60_000
  ) {
    outputRejected("binding_shape_invalid");
  }
  const ownership = value.inventory.pageOwnership;
  if (!exactKeys(ownership, value.inventory.projectIds)) {
    outputRejected("binding_shape_invalid");
  }
  let pageCount = 0;
  const seenPages = new Set<string>();
  for (const projectId of value.inventory.projectIds) {
    const pageIds = ownership[projectId];
    if (!canonicalIdArray(pageIds)) outputRejected("binding_shape_invalid");
    for (const pageId of pageIds) {
      if (seenPages.has(pageId)) outputRejected("binding_shape_invalid");
      seenPages.add(pageId);
      pageCount += 1;
    }
  }
  if (pageCount !== value.pageCount) outputRejected("binding_shape_invalid");
  if (hashLiveInventory(value.inventory as unknown as LiveInventory) !== value.inventoryHash) {
    outputRejected("binding_shape_invalid");
  }
}

const SAFETY_KEYS = Object.freeze([
  "allowlistBoundToInventory",
  "labAllowlistConfigured",
  "labPageTargetsConfigured",
  "liveInventoryCaptured",
  "officialApiConfigured",
  "pageWritePreflightWouldPass",
  "pageWritesBlocked",
  "projectAllowlistSyntacticallyValid",
  "readOnlyCorpusProtected",
  "requiresFreshWriteTimeCapture",
  "writeAuthorizationReusable",
  "writePreflightWouldPass",
  "writesBlocked",
]);

function assertSafeProspectiveSafety(
  value: unknown,
  expected: "successful" | "classification_blocked",
): void {
  if (
    !isObject(value) ||
    !exactKeys(value, SAFETY_KEYS) ||
    SAFETY_KEYS.some((key) => typeof value[key] !== "boolean") ||
    value.writesBlocked !== true ||
    value.pageWritesBlocked !== true ||
    value.requiresFreshWriteTimeCapture !== true ||
    value.writeAuthorizationReusable !== false
  ) {
    outputRejected("safety_shape_invalid");
  }
  const bothPreflightsPass =
    value.writePreflightWouldPass === true &&
    value.pageWritePreflightWouldPass === true;
  if (
    (expected === "successful" && !bothPreflightsPass) ||
    (expected === "classification_blocked" && bothPreflightsPass)
  ) {
    outputRejected("safety_shape_invalid");
  }
}

function freezeValidatedOutput(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (isObject(cloned.binding) && cloned.binding.status === "BLOCKED") {
    cloned.binding.message = "The bind child reported a fail-closed binding result; use its sanitized code for diagnosis.";
  }
  if (isObject(cloned.error)) {
    cloned.error.message = "The bind child reported a fail-closed local error; use its sanitized code for diagnosis.";
  }
  const freezeRecursively = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const nested of Object.values(item)) freezeRecursively(nested);
    Object.freeze(item);
  };
  freezeRecursively(cloned);
  return cloned;
}

function parseBindChildOutput(stdout: string, exitCode: number): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    outputRejected("stdout_json_invalid");
  }
  return validateExtensionBindChildOutput(parsed, exitCode);
}

export function validateExtensionBindChildOutput(
  parsed: unknown,
  exitCode: number,
): Readonly<Record<string, unknown>> {
  if (!isObject(parsed) || typeof parsed.ok !== "boolean") {
    outputRejected("top_level_shape_invalid");
  }
  if (parsed.ok === true) {
    if (
      exitCode !== 0 ||
      !exactKeys(parsed, ["binding", "ok", "persisted", "prospectiveSafety"]) ||
      parsed.persisted !== false
    ) {
      outputRejected("success_envelope_invalid");
    }
    assertSafeBindingOutput(parsed.binding);
    if (!isObject(parsed.binding) || parsed.binding.status !== "BOUND") {
      outputRejected("binding_status_invalid");
    }
    assertSafeProspectiveSafety(parsed.prospectiveSafety, "successful");
    return freezeValidatedOutput(parsed);
  }
  if ("binding" in parsed) {
    const expectedKeys = "prospectiveSafety" in parsed
      ? ["binding", "ok", "persisted", "prospectiveSafety"]
      : ["binding", "ok", "persisted"];
    if (exitCode !== 2 || !exactKeys(parsed, expectedKeys) || parsed.persisted !== false) {
      outputRejected("blocked_envelope_invalid");
    }
    assertSafeBindingOutput(parsed.binding);
    if (!isObject(parsed.binding) || parsed.binding.status !== "BLOCKED") {
      outputRejected("binding_status_invalid");
    }
    if ("prospectiveSafety" in parsed) {
      if (parsed.binding.code !== "ALLOWLIST_CLASSIFICATION_MISMATCH") {
        outputRejected("blocked_envelope_invalid");
      }
      assertSafeProspectiveSafety(parsed.prospectiveSafety, "classification_blocked");
    } else if (parsed.binding.code === "ALLOWLIST_CLASSIFICATION_MISMATCH") {
      outputRejected("blocked_envelope_invalid");
    }
    return freezeValidatedOutput(parsed);
  }
  if (
    exitCode !== 1 ||
    !exactKeys(parsed, ["error", "ok"]) ||
    !isObject(parsed.error) ||
    !exactKeys(parsed.error, ["code", "message"]) ||
    typeof parsed.error.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,63}$/u.test(parsed.error.code) ||
    !safeMessage(parsed.error.message)
  ) {
    outputRejected("error_envelope_invalid");
  }
  return freezeValidatedOutput(parsed);
}

function validateProgressOrder(
  progress: readonly ExtensionBindBrokerProgress[],
  expectedProjectCount: number,
  allowIncompleteDerive: boolean,
): void {
  if (progress.length === 0) return;
  let expectedPhase = "root";
  let expectedProjectOrdinal = 1;
  let pending: ExtensionBindBrokerProgress | null = null;
  let restored = false;
  for (const event of progress) {
    if (event.state === "started") {
      if (event.phase === "restore_root") {
        if (
          !allowIncompleteDerive &&
          (pending !== null || expectedPhase !== "restore_root")
        ) {
          outputRejected("progress_order_invalid");
        }
        pending = event;
        expectedPhase = "restore_root";
        continue;
      }
      if (
        pending !== null ||
        (restored && event.phase !== "derive") ||
        event.phase !== expectedPhase ||
        ((event.phase === "project_pass_1" || event.phase === "project_pass_2") &&
          (event.projectOrdinal !== expectedProjectOrdinal ||
            event.projectCount !== expectedProjectCount))
      ) {
        outputRejected("progress_order_invalid");
      }
      pending = event;
      continue;
    }
    if (
      pending === null ||
      event.phase !== pending.phase ||
      event.projectOrdinal !== pending.projectOrdinal ||
      event.projectCount !== pending.projectCount
    ) {
      outputRejected("progress_order_invalid");
    }
    pending = null;
    switch (event.phase) {
      case "root":
        expectedPhase = "identity_pass_1";
        break;
      case "identity_pass_1":
        expectedPhase = "project_pass_1";
        expectedProjectOrdinal = 1;
        break;
      case "project_pass_1":
        if (expectedProjectOrdinal < expectedProjectCount) expectedProjectOrdinal += 1;
        else {
          expectedPhase = "identity_pass_2";
          expectedProjectOrdinal = 1;
        }
        break;
      case "identity_pass_2":
        expectedPhase = "project_pass_2";
        expectedProjectOrdinal = 1;
        break;
      case "project_pass_2":
        if (expectedProjectOrdinal < expectedProjectCount) expectedProjectOrdinal += 1;
        else {
          expectedPhase = "restore_root";
          expectedProjectOrdinal = 1;
        }
        break;
      case "restore_root":
        restored = true;
        expectedPhase = "derive";
        break;
      case "derive":
        if (!restored) outputRejected("progress_order_invalid");
        expectedPhase = "complete";
        break;
    }
  }
  const incompleteDeriveStarted =
    allowIncompleteDerive &&
    pending?.phase === "derive" &&
    pending.state === "started" &&
    expectedPhase === "derive";
  if (
    !restored ||
    (allowIncompleteDerive
      ? !(
          incompleteDeriveStarted ||
          (pending === null && (expectedPhase === "derive" || expectedPhase === "complete"))
        )
      : pending !== null || expectedPhase !== "complete")
  ) {
    outputRejected("progress_order_invalid");
  }
}

export function validateExtensionBindChildProgress(
  stderr: string,
  expectedProjectCount: number,
  outputOk: boolean,
): readonly ExtensionBindBrokerProgress[] {
  if (stderr === "") return Object.freeze([]);
  if (!stderr.endsWith("\n")) outputRejected("progress_stream_invalid");
  const progress: ExtensionBindBrokerProgress[] = [];
  for (const line of stderr.slice(0, -1).split("\n")) {
    if (!line.startsWith("[trusted-bind] ")) outputRejected("progress_stream_invalid");
    let event: unknown;
    try {
      event = JSON.parse(line.slice("[trusted-bind] ".length)) as unknown;
    } catch {
      outputRejected("progress_stream_invalid");
    }
    if (!isObject(event)) outputRejected("progress_event_invalid");
    const hasProject = "projectOrdinal" in event || "projectCount" in event;
    if (
      !exactKeys(
        event,
        hasProject
          ? ["elapsedMs", "phase", "projectCount", "projectOrdinal", "state"]
          : ["elapsedMs", "phase", "state"],
      ) ||
      typeof event.phase !== "string" ||
      !PROGRESS_PHASES.has(event.phase) ||
      (event.state !== "started" && event.state !== "completed") ||
      !Number.isSafeInteger(event.elapsedMs) ||
      (event.elapsedMs as number) < 0 ||
      (hasProject &&
        (!Number.isSafeInteger(event.projectOrdinal) ||
          !Number.isSafeInteger(event.projectCount) ||
          (event.projectOrdinal as number) < 1 ||
          (event.projectCount as number) < (event.projectOrdinal as number)))
    ) {
      outputRejected("progress_event_invalid");
    }
    progress.push(
      Object.freeze({ ...event }) as unknown as ExtensionBindBrokerProgress,
    );
  }
  validateProgressOrder(progress, expectedProjectCount, !outputOk);
  return Object.freeze(progress);
}

export function assertExtensionBindTranscriptAdmission(
  output: Readonly<Record<string, unknown>>,
  transcript: BrokerTranscript,
): void {
  if (output.ok !== true) return;
  if (
    !transcript.fullTwoPassCompleted ||
    !isObject(output.binding) ||
    output.binding.status !== "BOUND" ||
    output.binding.projectCount !== transcript.projectCount
  ) {
    outputRejected("transcript_admission_invalid");
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const childPath = relative(root, candidate);
  return (
    childPath !== "" &&
    childPath !== ".." &&
    !childPath.startsWith(`..${sep}`) &&
    !isAbsolute(childPath)
  );
}

interface WorkspaceCli {
  readonly root: string;
  readonly cliPath: string;
}

const SAFE_BIND_CHILD_ENV_KEYS = Object.freeze([
  "TILDA_BINDING_KEY_PATH",
  "TILDA_BINDING_STATE_PATH",
  "TILDA_ACCOUNT_FINGERPRINT",
  "TILDA_INVENTORY_HASH",
  "LAB_PROJECT_IDS",
  "READ_ONLY_PROJECT_IDS",
  "LAB_PAGE_TARGETS",
  "LAB_RECORD_TARGETS",
] as const);

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function filterSafeBindChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    TILDA_SKIP_ENV_FILE: "extension-stdio-v1",
  };
  for (const key of SAFE_BIND_CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function safeBindChildEnvironment(workspaceRoot: string): Promise<NodeJS.ProcessEnv> {
  try {
    const parsed = parseEnv(await readFile(resolve(workspaceRoot, ".env"), "utf8"));
    return filterSafeBindChildEnvironment(parsed);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code !== "ENOENT") {
      throw new ExtensionStdioTransportError(
        "EXTENSION_SAFE_CONFIG_REJECTED",
        "The broker could not parse the local configuration into its safe bind-only subset.",
      );
    }
  }
  return filterSafeBindChildEnvironment({});
}

async function assertWorkspaceCli(): Promise<WorkspaceCli> {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDirectory = dirname(modulePath);
  const candidates = [
    resolve(moduleDirectory, "..", "..", ".."),
    resolve(moduleDirectory, "..", "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    const packagePath = resolve(candidate, "package.json");
    try {
      const packageSource = await readFile(packagePath, "utf8");
      const parsed = JSON.parse(packageSource) as {
        name?: unknown;
        private?: unknown;
        type?: unknown;
      };
      if (
        parsed.name !== "tilda-agent-os-research" ||
        parsed.private !== true ||
        parsed.type !== "module"
      ) {
        continue;
      }
      const cliPath = resolve(candidate, "dist", "src", "research", "cli.js");
      const [rootMetadata, packageMetadata, cliMetadata, realRoot, realModule, realCli] =
        await Promise.all([
          lstat(candidate),
          lstat(packagePath),
          lstat(cliPath),
          realpath(candidate),
          realpath(modulePath),
          realpath(cliPath),
        ]);
      if (
        !rootMetadata.isDirectory() ||
        rootMetadata.isSymbolicLink() ||
        !packageMetadata.isFile() ||
        packageMetadata.isSymbolicLink() ||
        !cliMetadata.isFile() ||
        cliMetadata.isSymbolicLink() ||
        !isContainedPath(realRoot, realModule) ||
        !isContainedPath(realRoot, realCli)
      ) {
        throw new ExtensionStdioTransportError(
          "EXTENSION_CHILD_PATH_REJECTED",
          "The module-derived workspace and built bind CLI must be regular non-symlink paths.",
        );
      }
      return { root: realRoot, cliPath: realCli };
    } catch (error) {
      const code = nodeErrorCode(error);
      if (code !== "ENOENT") throw error;
    }
  }
  throw new ExtensionStdioTransportError(
    "EXTENSION_CHILD_PATH_REJECTED",
    "The broker could not derive the research workspace from its own imported module.",
  );
}

async function assertConfiguredNodeExecutable(
  nodeExecutablePath: string,
  nodeRuntimeRoot: string,
): Promise<string> {
  if (!isAbsolute(nodeExecutablePath) || !isAbsolute(nodeRuntimeRoot)) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_NODE_PATH_REJECTED",
      "The Node executable and its configured runtime root must be absolute paths.",
    );
  }
  const executablePath = resolve(nodeExecutablePath);
  const runtimeRoot = resolve(nodeRuntimeRoot);
  if (!isContainedPath(runtimeRoot, executablePath)) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_NODE_PATH_REJECTED",
      "The Node executable must be contained by the configured runtime root.",
    );
  }
  if (!["node", "node.exe"].includes(basename(executablePath).toLowerCase())) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_NODE_PATH_REJECTED",
      "The configured runtime executable is not a Node executable.",
    );
  }

  const rootMetadata = await lstat(runtimeRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_NODE_PATH_REJECTED",
      "The configured Node runtime root must be a regular non-symlink directory.",
    );
  }
  const childPath = relative(runtimeRoot, executablePath);
  const pathSegments = childPath.split(sep).filter((segment) => segment !== "");
  let checkedPath = runtimeRoot;
  for (let index = 0; index < pathSegments.length; index += 1) {
    checkedPath = resolve(checkedPath, pathSegments[index]!);
    const metadata = await lstat(checkedPath);
    const isLast = index === pathSegments.length - 1;
    if (
      metadata.isSymbolicLink() ||
      (isLast ? !metadata.isFile() : !metadata.isDirectory())
    ) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_NODE_PATH_REJECTED",
        "The configured Node path must contain only regular non-symlink directories and an executable file.",
      );
    }
  }

  const [realRuntimeRoot, realExecutablePath] = await Promise.all([
    realpath(runtimeRoot),
    realpath(executablePath),
  ]);
  if (!isContainedPath(realRuntimeRoot, realExecutablePath)) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_NODE_PATH_REJECTED",
      "The resolved Node executable escapes the configured runtime root.",
    );
  }
  return executablePath;
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function terminateBindChild(
  child: ChildProcess,
  exitPromise: Promise<number>,
): Promise<void> {
  if (childIsRunning(child)) child.kill();
  await Promise.race([exitPromise.catch(() => undefined), delay(1_500)]);
  if (childIsRunning(child)) child.kill("SIGKILL");
  await Promise.race([exitPromise.catch(() => undefined), delay(1_500)]);
}

async function restoreExactRootOutOfBand(context: BrokerContext): Promise<void> {
  const restoreContext: BrokerContext = {
    ...context,
    overallDeadline: Date.now() + 20_000,
  };
  const pendingNavigation = context.pendingNavigation;
  if (pendingNavigation !== null) {
    restoreContext.diagnostics.currentStage = "cleanup.pending-navigation";
    try {
      await boundedBrokerOperation(
        pendingNavigation,
        remainingDeadlineMs(restoreContext.overallDeadline, MAX_OPERATION_TIMEOUT_MS),
        "The prior exact-tab navigation did not settle before root restoration.",
      );
    } catch (error) {
      if (error instanceof BrokerProtocolError && error.code === "EXTENSION_BROKER_TIMEOUT") {
        recordFailureAtStage(
          restoreContext.diagnostics,
          "cleanup.pending-navigation",
          error,
        );
        throw error;
      }
      // A rejected navigation is settled and can no longer race the restore.
    }
  }
  await ensureUrlAndProbe<ProjectsRootProbe>(
    restoreContext,
    context.rootUrl,
    PROJECTS_ROOT_DOM_PROBE,
    MAX_OPERATION_TIMEOUT_MS,
    PROBE_DIAGNOSTIC_STAGES.cleanup,
  );
  await delay(250);
  await evaluateNamedProbe<ProjectsRootProbe>(
    restoreContext,
    PROJECTS_ROOT_DOM_PROBE,
    context.rootUrl,
    5_000,
    PROBE_DIAGNOSTIC_STAGES.cleanup,
  );
}

export interface RunExtensionBindBrokerOptions {
  readonly tab: ExactClaimedExtensionTab;
  /** The exact tab-scoped CDP object whose documentation was read by the browser runtime. */
  readonly cdp: ExactClaimedExtensionTabCdp;
  /** Exact Node executable returned by the configured workspace runtime. */
  readonly nodeExecutablePath: string;
  /** Absolute configured runtime root containing nodeExecutablePath. */
  readonly nodeRuntimeRoot: string;
  readonly diagnosticProgress?: boolean;
  readonly timeoutMs?: number;
}

export interface ExtensionBindBrokerResult {
  readonly exitCode: number;
  readonly output: Readonly<Record<string, unknown>>;
  readonly progress: readonly ExtensionBindBrokerProgress[];
}

/**
 * Intended to be imported and invoked by the browser runtime after it has
 * claimed one exact extension tab. It accepts no tab ID, URL, CDP method, or
 * expression from its caller.
 */
export async function runExtensionBindBroker(
  options: RunExtensionBindBrokerOptions,
): Promise<ExtensionBindBrokerResult> {
  const diagnostics: BrokerDiagnosticTracker = {
    currentStage: "setup.workspace",
    primary: null,
    restore: null,
  };
  let workspace: WorkspaceCli;
  let nodeExecutablePath: string;
  let childEnvironment: NodeJS.ProcessEnv;
  let context: BrokerContext;
  try {
    diagnostics.currentStage = "setup.workspace";
    workspace = await assertWorkspaceCli();
    diagnostics.currentStage = "setup.node";
    nodeExecutablePath = await assertConfiguredNodeExecutable(
      options.nodeExecutablePath,
      options.nodeRuntimeRoot,
    );
    diagnostics.currentStage = "setup.config";
    childEnvironment = await safeBindChildEnvironment(workspace.root);
    const timeoutMs = Math.max(12_000, Math.min(options.timeoutMs ?? 120_000, 180_000));
    context = await createBrokerContext(options.tab, options.cdp, Date.now() + timeoutMs, diagnostics);
  } catch (error) {
    recordPrimaryFailure(diagnostics, error);
    throw new ExtensionBindBrokerRunError(diagnostics);
  }
  const timeoutMs = Math.max(12_000, Math.min(options.timeoutMs ?? 120_000, 180_000));
  const args = [
    workspace.cliPath,
    "bind",
    "--transport=extension-stdio",
    "--extension-private-stdio=v1",
  ];
  if (options.diagnosticProgress === true) args.push("--diagnostic-progress");

  diagnostics.currentStage = "child.spawn";
  const child = spawn(nodeExecutablePath, args, {
    cwd: workspace.root,
    env: childEnvironment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });

  let protocolComplete = false;
  let rejectLifecycle: (error: unknown) => void = () => undefined;
  const lifecycleFailure = new Promise<never>((_resolve, reject) => {
    rejectLifecycle = reject;
  });
  const noteLifecycleFailure = (error: unknown): void => {
    rejectLifecycle(
      error instanceof Error
        ? error
        : new ExtensionStdioTransportError(
            "EXTENSION_CHILD_FAILED",
            "The direct bind child failed before protocol completion.",
          ),
    );
  };
  const exitPromise = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      rejectExit(error);
      noteLifecycleFailure(error);
    });
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        const error = new ExtensionStdioTransportError(
          "EXTENSION_CHILD_TERMINATED",
          "The direct bind child was terminated before completion.",
        );
        rejectExit(error);
        noteLifecycleFailure(error);
        return;
      }
      if (!protocolComplete) {
        noteLifecycleFailure(
          new ExtensionStdioTransportError(
            "EXTENSION_CHILD_EARLY_EXIT",
            "The direct bind child exited before the named-probe protocol completed.",
          ),
        );
      }
      resolveExit(code ?? 1);
    });
  });
  void exitPromise.catch(() => undefined);

  const remainingOverallMs = Math.max(1, context.overallDeadline - Date.now());
  const overallTimeout = setTimeout(() => {
    noteLifecycleFailure(
      new ExtensionStdioTransportError(
        "EXTENSION_BROKER_TIMEOUT",
        "The exact-tab bind broker exceeded its bounded overall deadline.",
      ),
    );
    if (childIsRunning(child)) child.kill();
  }, remainingOverallMs);

  let channel: ExtensionStdioJsonChannel | null = null;
  let stdoutPromise: Promise<string> = Promise.resolve("");
  let stderrPromise: Promise<string> = Promise.resolve("");
  let primaryError: unknown = null;
  let restoreError: unknown = null;
  let result: ExtensionBindBrokerResult | null = null;
  try {
    const requestStream = child.stdio[3];
    const responseStream = child.stdio[4];
    if (
      requestStream === null ||
      requestStream === undefined ||
      responseStream === null ||
      responseStream === undefined ||
      child.stdout === null ||
      child.stderr === null
    ) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_PRIVATE_PIPE_FAILED",
        "The direct bind child did not receive its required private stdio pipes.",
      );
    }

    channel = new ExtensionStdioJsonChannel({
      readable: requestStream as Readable,
      writable: responseStream as Writable,
    });
    stdoutPromise = collectBounded(child.stdout, "Bind child stdout");
    stderrPromise = collectBounded(child.stderr, "Bind child stderr");
    void stdoutPromise.catch(noteLifecycleFailure);
    void stderrPromise.catch(noteLifecycleFailure);
    void stdoutPromise.catch(() => undefined);
    void stderrPromise.catch(() => undefined);

    const transcript = await Promise.race([
      serveExtensionStdioBrokerWithContext(context, channel),
      lifecycleFailure,
    ]);
    protocolComplete = true;
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([exitPromise, stdoutPromise, stderrPromise]),
      lifecycleFailure,
    ]);
    diagnostics.currentStage = "protocol.output";
    const output = parseBindChildOutput(stdout, exitCode);
    assertExtensionBindTranscriptAdmission(output, transcript);
    const progress = validateExtensionBindChildProgress(
      stderr,
      transcript.projectCount,
      output.ok === true,
    );
    if (options.diagnosticProgress !== true && progress.length > 0) {
      outputRejected("unexpected_progress");
    }
    result = Object.freeze({ exitCode, output, progress });
  } catch (error) {
    primaryError = error;
    recordPrimaryFailure(diagnostics, error);
  } finally {
    clearTimeout(overallTimeout);
    const noteChildCleanupFailure = (error: unknown): void => {
      restoreError ??= error;
      recordFailureAtStage(diagnostics, "cleanup.child", error);
    };
    try {
      channel?.close();
    } catch (error) {
      noteChildCleanupFailure(error);
    }
    try {
      diagnostics.currentStage = "cleanup.child";
      await terminateBindChild(child, exitPromise);
    } catch (error) {
      noteChildCleanupFailure(error);
    }
    try {
      await Promise.race([
        Promise.allSettled([stdoutPromise, stderrPromise]),
        delay(2_000),
      ]);
    } catch (error) {
      noteChildCleanupFailure(error);
    }
    try {
      await restoreExactRootOutOfBand(context);
    } catch (error) {
      restoreError = error;
      recordRestoreFailure(diagnostics, error);
    }
  }

  if (restoreError !== null || primaryError !== null) {
    throw new ExtensionBindBrokerRunError(diagnostics);
  }
  if (result === null) {
    const error = new ExtensionStdioTransportError(
      "EXTENSION_CHILD_FAILED",
      "The direct bind child produced no validated result.",
    );
    recordPrimaryFailure(diagnostics, error);
    throw new ExtensionBindBrokerRunError(diagnostics);
  }
  return result;
}
