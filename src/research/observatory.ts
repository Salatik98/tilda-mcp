import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CdpConnection, CdpEvent } from "./cdp-client.js";
import { canonicalHash } from "./hash.js";
import {
  redactValue,
  SanitizationError,
  sanitizeForPersistence,
} from "./security/index.js";

export interface TraceTarget {
  projectId: string;
  pageId?: string;
  recordId?: string;
  elementId?: string;
}

export interface TraceStartInput {
  purpose: string;
  target: TraceTarget;
  redactionProfile: "strict";
}

export interface StructuralSnapshot {
  hash: string;
  summary: Record<string, unknown>;
}

export interface TraceEventSource {
  snapshot(): Promise<Record<string, unknown>>;
  subscribe(listener: (event: CdpEvent) => void): () => void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface TraceArtifact {
  traceId: string;
  purpose: string;
  target: TraceTarget;
  redactionProfile: "strict";
  startedAt: string;
  stoppedAt: string;
  before: StructuralSnapshot;
  after: StructuralSnapshot;
  changed: boolean;
  eventCount: number;
  events: ReadonlyArray<Record<string, unknown>>;
}

export interface TraceStartResult {
  traceId: string;
  startedAt: string;
  beforeHash: string;
}

export interface TraceStopResult {
  traceId: string;
  artifactPath: string;
  eventCount: number;
  changed: boolean;
  beforeHash: string;
  afterHash: string;
}

interface ActiveTrace {
  traceId: string;
  input: TraceStartInput;
  startedAt: string;
  before: StructuralSnapshot;
  events: Array<Record<string, unknown>>;
  unsubscribe: () => void;
}

export class TraceStateError extends Error {
  readonly code: "TRACE_ALREADY_ACTIVE" | "TRACE_NOT_ACTIVE" | "TRACE_ID_MISMATCH";

  constructor(
    code: "TRACE_ALREADY_ACTIVE" | "TRACE_NOT_ACTIVE" | "TRACE_ID_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "TraceStateError";
    this.code = code;
  }
}

export class SanitizedTraceStore {
  readonly #root: string;

  constructor(root = resolve("research", "artifacts", "traces", "sanitized")) {
    this.#root = resolve(root);
  }

  artifactPath(traceId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(traceId)) {
      throw new Error("Invalid trace ID.");
    }
    return join(this.#root, `${traceId}.json`);
  }

  async persist(traceId: string, sanitizedArtifact: TraceArtifact): Promise<string> {
    const outputPath = this.artifactPath(traceId);
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    await mkdir(dirname(outputPath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(sanitizedArtifact, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, outputPath);
      return outputPath;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function assertTraceInput(input: TraceStartInput): void {
  if (input.redactionProfile !== "strict") {
    throw new Error("Only the strict redaction profile is supported.");
  }
  if (input.purpose.trim().length < 3 || input.purpose.length > 240) {
    throw new Error("Trace purpose must contain 3 to 240 characters.");
  }
  for (const [name, value] of Object.entries(input.target)) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
      throw new Error(`Trace target ${name} must be a non-empty bounded string.`);
    }
  }
}

function snapshot(value: Record<string, unknown>): StructuralSnapshot {
  const sanitized = sanitizeForPersistence(value);
  return {
    hash: canonicalHash(sanitized),
    summary: sanitized,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function definedEntries(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

/**
 * Project a CDP event to the minimum causal metadata required by Phase 1.
 * Request/response bodies and headers are never retained.
 */
export function projectCdpEvent(event: CdpEvent): Record<string, unknown> | null {
  const params = asObject(event.params);

  switch (event.method) {
    case "Network.requestWillBeSent": {
      const request = asObject(params.request);
      const initiator = asObject(params.initiator);
      return definedEntries({
        method: event.method,
        requestId: asString(params.requestId),
        loaderId: asString(params.loaderId),
        resourceType: asString(params.type),
        url: asString(request.url),
        httpMethod: asString(request.method),
        hasPostData: request.hasPostData === true,
        initiatorType: asString(initiator.type),
        timestamp: asNumber(params.timestamp),
      });
    }
    case "Network.responseReceived": {
      const response = asObject(params.response);
      return definedEntries({
        method: event.method,
        requestId: asString(params.requestId),
        resourceType: asString(params.type),
        url: asString(response.url),
        status: asNumber(response.status),
        mimeType: asString(response.mimeType),
        protocol: asString(response.protocol),
        fromDiskCache: response.fromDiskCache === true,
        fromServiceWorker: response.fromServiceWorker === true,
        timestamp: asNumber(params.timestamp),
      });
    }
    case "Runtime.consoleAPICalled": {
      const args = Array.isArray(params.args) ? params.args : [];
      return definedEntries({
        method: event.method,
        consoleType: asString(params.type),
        argumentTypes: args.map((argument) => asString(asObject(argument).type) ?? "unknown"),
        timestamp: asNumber(params.timestamp),
      });
    }
    case "Runtime.exceptionThrown": {
      const details = asObject(params.exceptionDetails);
      const exception = asObject(details.exception);
      const text = [asString(details.text), asString(exception.description)]
        .filter((value): value is string => value !== undefined)
        .join("\n");
      return definedEntries({
        method: event.method,
        exceptionId: asNumber(details.exceptionId),
        url: asString(details.url),
        lineNumber: asNumber(details.lineNumber),
        columnNumber: asNumber(details.columnNumber),
        messageFingerprint: text.length > 0 ? redactValue(text) : undefined,
        timestamp: asNumber(params.timestamp),
      });
    }
    case "Log.entryAdded": {
      const entry = asObject(params.entry);
      const text = asString(entry.text);
      return definedEntries({
        method: event.method,
        source: asString(entry.source),
        level: asString(entry.level),
        url: asString(entry.url),
        lineNumber: asNumber(entry.lineNumber),
        messageFingerprint: text === undefined ? undefined : redactValue(text),
        timestamp: asNumber(entry.timestamp),
      });
    }
    case "Page.frameNavigated": {
      const frame = asObject(params.frame);
      return definedEntries({
        method: event.method,
        frameId: asString(frame.id),
        parentId: asString(frame.parentId),
        loaderId: asString(frame.loaderId),
        url: asString(frame.url),
        mimeType: asString(frame.mimeType),
      });
    }
    case "Page.lifecycleEvent":
      return definedEntries({
        method: event.method,
        frameId: asString(params.frameId),
        loaderId: asString(params.loaderId),
        name: asString(params.name),
        timestamp: asNumber(params.timestamp),
      });
    case "Page.frameAttached":
    case "Page.frameDetached":
      return definedEntries({
        method: event.method,
        frameId: asString(params.frameId),
        parentFrameId: asString(params.parentFrameId),
        reason: asString(params.reason),
      });
    default:
      return null;
  }
}

export class Observatory {
  readonly #source: TraceEventSource;
  readonly #store: SanitizedTraceStore;
  #active: ActiveTrace | null = null;

  constructor(source: TraceEventSource, store = new SanitizedTraceStore()) {
    this.#source = source;
    this.#store = store;
  }

  get activeTraceId(): string | null {
    return this.#active?.traceId ?? null;
  }

  async startTrace(input: TraceStartInput): Promise<TraceStartResult> {
    assertTraceInput(input);
    if (this.#active !== null) {
      throw new TraceStateError("TRACE_ALREADY_ACTIVE", "A trace is already active.");
    }

    await this.#source.start?.();
    const before = snapshot(await this.#source.snapshot());
    const traceId = randomUUID();
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = this.#source.subscribe((event) => {
      const projected = projectCdpEvent(event);
      if (projected !== null) events.push(projected);
    });
    const startedAt = new Date().toISOString();

    this.#active = {
      traceId,
      input: structuredClone(input),
      startedAt,
      before,
      events,
      unsubscribe,
    };
    return { traceId, startedAt, beforeHash: before.hash };
  }

  async stopTrace(traceId: string): Promise<TraceStopResult> {
    const active = this.#active;
    if (active === null) {
      throw new TraceStateError("TRACE_NOT_ACTIVE", "No trace is active.");
    }
    if (active.traceId !== traceId) {
      throw new TraceStateError("TRACE_ID_MISMATCH", "Trace ID does not match the active trace.");
    }

    active.unsubscribe();
    this.#active = null;

    try {
      const after = snapshot(await this.#source.snapshot());
      const artifact: TraceArtifact = {
        traceId: active.traceId,
        purpose: active.input.purpose,
        target: active.input.target,
        redactionProfile: active.input.redactionProfile,
        startedAt: active.startedAt,
        stoppedAt: new Date().toISOString(),
        before: active.before,
        after,
        changed: active.before.hash !== after.hash,
        eventCount: active.events.length,
        events: active.events,
      };

      // This is the only object allowed to cross the persistence boundary.
      const sanitized = sanitizeForPersistence(artifact);
      const artifactPath = await this.#store.persist(traceId, sanitized);
      return {
        traceId,
        artifactPath,
        eventCount: sanitized.eventCount,
        changed: sanitized.changed,
        beforeHash: sanitized.before.hash,
        afterHash: sanitized.after.hash,
      };
    } catch (error) {
      if (error instanceof SanitizationError) throw error;
      throw error;
    } finally {
      await this.#source.stop?.().catch(() => undefined);
    }
  }
}

export class CdpTraceEventSource implements TraceEventSource {
  readonly #connection: CdpConnection;
  readonly #snapshot: () => Promise<Record<string, unknown>>;

  constructor(
    connection: CdpConnection,
    snapshotProvider: () => Promise<Record<string, unknown>>,
  ) {
    this.#connection = connection;
    this.#snapshot = snapshotProvider;
  }

  async start(): Promise<void> {
    await Promise.all([
      this.#connection.send("Network.enable", { maxPostDataSize: 0 }),
      this.#connection.send("Runtime.enable"),
      this.#connection.send("Page.enable"),
      this.#connection.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      this.#connection.send("Log.enable"),
    ]);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([
      this.#connection.send("Network.disable"),
      this.#connection.send("Runtime.disable"),
      this.#connection.send("Page.disable"),
      this.#connection.send("Log.disable"),
    ]);
  }

  snapshot(): Promise<Record<string, unknown>> {
    return this.#snapshot();
  }

  subscribe(listener: (event: CdpEvent) => void): () => void {
    return this.#connection.onEvent(listener);
  }
}
