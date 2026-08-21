import { randomUUID } from "node:crypto";

import type { ChangeOperation, ElementTarget, PageTarget, RecordTarget } from "../core/contracts.js";
import { isSafeStandardContentField } from "../core/standard-field-safety.js";
import type { TaskAuthorityGuard } from "../core/task-authority.js";
import {
  isLoopbackCdpWebSocketUrl,
  listCdpTargets,
  type CdpTarget,
} from "../research/cdp-client.js";
import {
  createLoopbackCdpTrustedBrowserSession,
  type AuthorityOwnedLoopbackBrowserSession,
  type EditorRecordIdentity,
  type ExactEditorPageSnapshot,
  type ExactEditorRecordRead,
  type ExactRecordHoverControlReveal,
  type ExactPageHeadCodeRead,
  type ExactPageSettingsRead,
  type FixedBrowserDispatchResult,
  type FixedPageLifecycleResult,
  type FixedReferencePageCleanupResult,
  type FixedZeroWritePreflightResult,
  type KnownObservedTemplateId,
  type KnownTemplateAddPreflight,
  type RenderedBlockLibraryIndex,
  type StandardWritableField,
} from "../research/browser-session.js";
import {
  assertLabPageTarget,
  assertLabRecordTarget,
  type LabPageTarget,
  type LabRecordTarget,
  type LiveInventory,
  type ResearchConfig,
} from "../research/config.js";
import {
  captureTrustedLiveBindingWithSession,
  isFreshTrustedBindingCapture,
  type TrustedBindingCapture,
  type TrustedBindingEstablished,
  type TrustedCaptureOptions,
} from "../research/inventory.js";

const MAX_ADAPTER_TIMEOUT_MS = 12_000;
const DEFAULT_LEASE_TTL_MS = 30_000;

export type BrowserAuthorityFailureCode =
  | "AUTHORITY_BUSY"
  | "EXACT_ROOT_TARGET_NOT_FOUND"
  | "EXACT_ROOT_TARGET_AMBIGUOUS"
  | "BINDING_BLOCKED"
  | "BINDING_STALE"
  | "AUTHORITY_CLOSED"
  | "AUTHORITY_EXPIRED"
  | "CONCURRENT_ADAPTER_OPERATION"
  | "TARGET_REJECTED"
  | "WRITE_IDENTITY_REJECTED"
  | "STALE_TARGET"
  | "MUTATION_SLOT_CONSUMED"
  | "AUTHORITY_OPERATION_IN_PROGRESS"
  | "ROOT_RESTORE_FAILED"
  | "AUTHORITY_EDITOR_TARGET_MISMATCH"
  | "AUTHORITY_RECORD_CONTROL_KEY_REJECTED"
  | "AUTHORITY_RECORD_TARGET_MISMATCH"
  | "AUTHORITY_RECORD_IDENTITY_CHANGED"
  | "AUTHORITY_RECORD_UI_CONTROL_MISSING"
  | "AUTHORITY_RECORD_HOVER_HANDLER_REJECTED"
  | "AUTHORITY_RECORD_CONTROL_NOT_REVEALED"
  | "AUTHORITY_RECORD_CONTROL_OWNERSHIP_REJECTED";

const RECORD_CONTROL_PROBE_FAILURE_CODES = new Set<BrowserAuthorityFailureCode>([
  "TARGET_REJECTED",
  "WRITE_IDENTITY_REJECTED",
]);

const RECORD_CONTROL_PROBE_ERROR_MAP = new Map<string, BrowserAuthorityFailureCode>([
  ["AUTHORITY_EDITOR_TARGET_MISMATCH", "AUTHORITY_EDITOR_TARGET_MISMATCH"],
  ["AUTHORITY_RECORD_CONTROL_KEY_REJECTED", "AUTHORITY_RECORD_CONTROL_KEY_REJECTED"],
  ["AUTHORITY_RECORD_TARGET_MISMATCH", "AUTHORITY_RECORD_TARGET_MISMATCH"],
  ["AUTHORITY_RECORD_IDENTITY_CHANGED", "AUTHORITY_RECORD_IDENTITY_CHANGED"],
  ["AUTHORITY_RECORD_UI_CONTROL_MISSING", "AUTHORITY_RECORD_UI_CONTROL_MISSING"],
  ["AUTHORITY_RECORD_HOVER_HANDLER_REJECTED", "AUTHORITY_RECORD_HOVER_HANDLER_REJECTED"],
  ["AUTHORITY_RECORD_CONTROL_NOT_REVEALED", "AUTHORITY_RECORD_CONTROL_NOT_REVEALED"],
  ["AUTHORITY_RECORD_CONTROL_OWNERSHIP_REJECTED", "AUTHORITY_RECORD_CONTROL_OWNERSHIP_REJECTED"],
]);

export class BrowserAuthorityError extends Error {
  constructor(
    readonly code: BrowserAuthorityFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserAuthorityError";
  }
}

function throwRecordControlProbeError(error: unknown): never {
  if (error instanceof BrowserAuthorityError && RECORD_CONTROL_PROBE_FAILURE_CODES.has(error.code)) {
    throw error;
  }
  const message = error instanceof Error ? error.message : "";
  const probeCode = [...RECORD_CONTROL_PROBE_ERROR_MAP.keys()].find((code) =>
    message.includes(code),
  );
  const mapped = probeCode === undefined
    ? undefined
    : RECORD_CONTROL_PROBE_ERROR_MAP.get(probeCode);
  if (mapped !== undefined) {
    throw new BrowserAuthorityError(
      mapped,
      `Hover-control probe failed closed at ${probeCode}.`,
      { cause: error },
    );
  }
  throw error;
}

export interface BrowserAuthorityMetadata {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly cdpTargetId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly transport: "loopback_cdp";
  readonly accountFingerprint: string;
  readonly inventoryHash: string;
}

/**
 * Public in-memory adapter seam. Every operation is fixed, target-bound, and
 * guarded against the inventory captured by this exact lease. There is no
 * arbitrary URL, JavaScript, CDP send, or evaluate entry point.
 */
export interface LoopbackCdpAdapterPort {
  readEditorPage(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorPageSnapshot>;
  readStandardSettings(
    target: LabRecordTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorRecordRead>;
  readT123Content(
    target: LabRecordTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorRecordRead>;
  readZeroModel(
    target: LabRecordTarget,
    timeoutMs?: number,
    authorizationElementId?: string,
  ): Promise<ExactEditorRecordRead>;
  revealExactRecordControl(
    target: LabRecordTarget,
    controlKey: string,
    timeoutMs?: number,
  ): Promise<ExactRecordHoverControlReveal>;
  readRenderedBlockLibrary(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<RenderedBlockLibraryIndex>;
  preflightKnownTemplateAdd(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs?: number,
  ): Promise<KnownTemplateAddPreflight>;
  writeStandard(
    target: LabRecordTarget,
    field: StandardWritableField,
    value: string,
    timeoutMs?: number,
  ): Promise<FixedDispatchReceipt>;
  writeT123(
    target: LabRecordTarget,
    code: string,
    timeoutMs?: number,
  ): Promise<FixedDispatchReceipt>;
  writeZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs?: number,
    authorizationElementId?: string,
  ): Promise<FixedDispatchReceipt>;
  preflightZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs?: number,
  ): Promise<FixedZeroWritePreflightResult>;
  readPageSettings(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<ExactPageSettingsRead>;
  writePageSettings(
    target: LabPageTarget,
    intendedFields: readonly (readonly [string, string])[],
    timeoutMs?: number,
  ): Promise<FixedDispatchReceipt>;
  readPageHeadCode(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<ExactPageHeadCodeRead>;
  writePageHeadCode(
    target: LabPageTarget,
    intendedCode: string,
    expectedCurrentCode: string,
    timeoutMs?: number,
  ): Promise<FixedDispatchReceipt>;
  publishPage(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<FixedDispatchReceipt>;
  unpublishPage(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<FixedDispatchReceipt>;
  runFixedPageLifecycle(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<FixedPageLifecycleResult>;
  createPageFromReference(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<CreatedReferencePageReceipt>;
  cleanupReferencePage(
    receipt: CreatedReferencePageReceipt,
    timeoutMs?: number,
  ): Promise<FixedReferencePageCleanupResult>;
  addKnownTemplate(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs?: number,
  ): Promise<CreatedKnownTemplateRecordReceipt>;
}

export interface CreatedReferencePageReceipt {
  readonly kind: "created_reference_page";
  readonly receiptId: string;
  readonly accountFingerprint: string;
  readonly sourceTarget: LabPageTarget;
  readonly createdTarget: LabPageTarget;
  readonly baselineActivePageIds: readonly string[];
  readonly baselinePageOrder: readonly string[];
  readonly createdActivePageIds: readonly string[];
  readonly createdPageOrder: readonly string[];
  readonly sourceRecords: readonly EditorRecordIdentity[];
  readonly createdRecords: readonly EditorRecordIdentity[];
  readonly consumed: false;
}

export interface CreatedKnownTemplateRecordReceipt {
  readonly kind: "created_known_template_record";
  readonly receiptId: string;
  readonly accountFingerprint: string;
  readonly target: LabRecordTarget;
  readonly templateId: KnownObservedTemplateId;
  readonly identity: EditorRecordIdentity;
  readonly beforeRecordIds: readonly string[];
  readonly afterRecordIds: readonly string[];
  readonly consumed: false;
}

/**
 * Opaque mutation observation. Standard/T123 additionally require Tilda's exact
 * trimmed `OK` application acknowledgement; every adapter must still reread and
 * verify the exact semantic state.
 */
export interface FixedDispatchReceipt {
  readonly operationId: string;
  readonly dispatched: true;
  readonly ack: "http_ok" | "http_rejected";
  readonly requestBodyPersisted: false;
}

export interface LoopbackBrowserAuthority {
  readonly metadata: BrowserAuthorityMetadata;
  readonly binding: TrustedBindingEstablished;
  readonly inventory: LiveInventory;
  readonly adapter: LoopbackCdpAdapterPort;
  assertFresh(): void;
  close(): Promise<void>;
}

/** Frozen query-only seam. It deliberately contains no mutation operation. */
export interface LoopbackCdpReadOnlyPort {
  readEditorPage(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorPageSnapshot>;
  readStandardSettings(
    target: LabRecordTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorRecordRead>;
  readT123Content(
    target: LabRecordTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorRecordRead>;
  readZeroServerRepresentation(
    target: LabRecordTarget,
    timeoutMs?: number,
  ): Promise<ExactEditorRecordRead>;
  readPageHeadCode(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<ExactPageHeadCodeRead>;
  revealExactRecordControl(
    target: LabRecordTarget,
    controlKey: string,
    timeoutMs?: number,
  ): Promise<ExactRecordHoverControlReveal>;
  readRenderedBlockLibrary(
    target: LabPageTarget,
    timeoutMs?: number,
  ): Promise<RenderedBlockLibraryIndex>;
}

export interface LoopbackBrowserReadAuthority {
  readonly metadata: BrowserAuthorityMetadata;
  readonly binding: TrustedBindingEstablished;
  readonly inventory: LiveInventory;
  readonly reader: LoopbackCdpReadOnlyPort;
  assertFresh(): void;
  close(): Promise<void>;
}

export interface AcquireLoopbackBrowserAuthorityOptions extends TrustedCaptureOptions {
  /** Cannot extend the binding capture's shorter process-local expiry. */
  readonly leaseTtlMs?: number;
  /** Optional ephemeral exact-task authority, checked against this lease's fresh binding. */
  readonly taskGuard?: TaskAuthorityGuard;
}

export interface LoopbackBrowserAuthorityDependencies {
  listTargets(cdpUrl: string): Promise<readonly CdpTarget[]>;
  openSession(target: CdpTarget): Promise<AuthorityOwnedLoopbackBrowserSession>;
  captureBinding(
    config: ResearchConfig,
    session: AuthorityOwnedLoopbackBrowserSession,
    options: TrustedCaptureOptions,
  ): Promise<TrustedBindingCapture>;
  isFreshBinding(capture: TrustedBindingCapture | null): capture is TrustedBindingEstablished;
  now(): number;
  randomId(): string;
}

const defaultDependencies: LoopbackBrowserAuthorityDependencies = {
  listTargets: listCdpTargets,
  openSession: createLoopbackCdpTrustedBrowserSession,
  captureBinding: (config, session, options) =>
    captureTrustedLiveBindingWithSession(config, session, options, "caller_owned"),
  isFreshBinding: isFreshTrustedBindingCapture,
  now: Date.now,
  randomId: randomUUID,
};

let activeProcessLeaseToken: object | null = null;
const createdReferencePageReceipts = new WeakSet<object>();
const createdKnownTemplateRecordReceipts = new WeakSet<object>();

const MAX_WRITE_VALUE_BYTES = 5_000_000;

function isExactProjectsRootTarget(target: CdpTarget): boolean {
  if (
    target.type !== "page" ||
    target.id.trim() === "" ||
    target.webSocketDebuggerUrl === undefined ||
    !isLoopbackCdpWebSocketUrl(target.webSocketDebuggerUrl)
  ) {
    return false;
  }
  try {
    const url = new URL(target.url);
    return (
      url.protocol === "https:" &&
      url.hostname === "tilda.ru" &&
      url.pathname === "/projects/" &&
      url.search === "" &&
      url.hash === "" &&
      !url.searchParams.has("projectid") &&
      !url.searchParams.has("projectId")
    );
  } catch {
    return false;
  }
}

function selectOnlyProjectsRootTarget(targets: readonly CdpTarget[]): CdpTarget {
  const matches = targets.filter(isExactProjectsRootTarget);
  if (matches.length === 0) {
    throw new BrowserAuthorityError(
      "EXACT_ROOT_TARGET_NOT_FOUND",
      "Open exactly one authenticated top-level https://tilda.ru/projects/ tab in the dedicated loopback CDP browser.",
    );
  }
  if (matches.length !== 1) {
    throw new BrowserAuthorityError(
      "EXACT_ROOT_TARGET_AMBIGUOUS",
      "More than one exact top-level Tilda projects tab is open; close duplicates before acquiring authority.",
    );
  }
  return matches[0]!;
}

function normalizeAdapterTimeout(value: number | undefined): number {
  if (value === undefined) return MAX_ADAPTER_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      "Adapter timeout must be a positive integer.",
    );
  }
  return Math.min(value, MAX_ADAPTER_TIMEOUT_MS);
}

function normalizeLeaseTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LEASE_TTL_MS) {
    throw new BrowserAuthorityError(
      "BINDING_STALE",
      "Authority lease TTL must be between 1 and 30000 milliseconds.",
    );
  }
  return value;
}

function assertBoundedWriteValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new BrowserAuthorityError("TARGET_REJECTED", `${field} must be a string.`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_WRITE_VALUE_BYTES) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      `${field} exceeds the fixed 5000000-byte adapter limit.`,
    );
  }
  return value;
}

function exactPlainPageTarget(value: LabPageTarget): LabPageTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserAuthorityError("TARGET_REJECTED", "Page target must be an exact object.");
  }
  let keys: readonly PropertyKey[];
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      "Page target could not be inspected safely.",
      { cause: error },
    );
  }
  const expected = ["projectId", "pageId"] as const;
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  ) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      "Page target must contain exactly projectId and pageId as own data properties.",
    );
  }
  const ownString = (key: (typeof expected)[number]): string => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        `Page target ${key} must be an own string data property.`,
      );
    }
    return descriptor.value;
  };
  return Object.freeze({ projectId: ownString("projectId"), pageId: ownString("pageId") });
}

function taskPageTarget(target: LabPageTarget): PageTarget {
  return { kind: "page", projectId: target.projectId, pageId: target.pageId };
}

function taskRecordTarget(target: LabRecordTarget): RecordTarget {
  return {
    kind: "record",
    projectId: target.projectId,
    pageId: target.pageId,
    recordId: target.recordId,
  };
}

function taskElementTarget(target: LabRecordTarget, elementId: string): ElementTarget {
  return { ...taskRecordTarget(target), kind: "element", elementId };
}

function assertTaskGuardBinding(
  guard: TaskAuthorityGuard | undefined,
  binding: TrustedBindingEstablished,
): void {
  if (guard === undefined) return;
  const receipt = guard.receipt();
  if (
    receipt.accountFingerprint !== binding.accountFingerprint ||
    receipt.inventoryHash !== binding.inventoryHash
  ) {
    throw new BrowserAuthorityError(
      "BINDING_STALE",
      "Task authority does not match the fresh browser account and inventory binding.",
    );
  }
}

function exactPlainRecordTarget(value: LabRecordTarget): LabRecordTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserAuthorityError("TARGET_REJECTED", "Record target must be an exact object.");
  }
  let keys: readonly PropertyKey[];
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new BrowserAuthorityError("TARGET_REJECTED", "Record target could not be inspected safely.", {
      cause: error,
    });
  }
  const expected = ["projectId", "pageId", "recordId"] as const;
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  ) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      "Record target must contain exactly projectId, pageId, and recordId as own properties.",
    );
  }
  const ownString = (key: (typeof expected)[number]): string => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new BrowserAuthorityError("TARGET_REJECTED", `Record target ${key} must be an own string data property.`);
    }
    return descriptor.value;
  };
  const target = Object.freeze({
    projectId: ownString("projectId"),
    pageId: ownString("pageId"),
    recordId: ownString("recordId"),
  });
  if (![target.projectId, target.pageId, target.recordId].every((id) => /^[1-9]\d*$/u.test(id))) {
    throw new BrowserAuthorityError("TARGET_REJECTED", "Record target IDs must be canonical decimals.");
  }
  return target;
}

function assertClassifiedReadPageTarget(
  config: ResearchConfig,
  target: LabPageTarget,
  inventory: LiveInventory,
): void {
  if (!/^[1-9]\d*$/u.test(target.projectId) || !/^[1-9]\d*$/u.test(target.pageId)) {
    throw new BrowserAuthorityError("TARGET_REJECTED", "Read target IDs must be canonical decimals.");
  }
  const classified =
    config.readOnlyProjectIds?.includes(target.projectId) === true ||
    config.labProjectIds?.includes(target.projectId) === true;
  if (!classified || !inventory.projectIds.includes(target.projectId)) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      "Read target project is not classified in the bound live inventory.",
    );
  }
  const ownedPages = inventory.pageOwnership[target.projectId];
  if (ownedPages === undefined || !ownedPages.includes(target.pageId)) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      "Read target page is not owned by the exact bound project.",
    );
  }
}

function exactJsonData(value: unknown, field: string): unknown {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 50_000 || depth > 64) {
      throw new BrowserAuthorityError("TARGET_REJECTED", `${field} is too complex.`);
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains a non-finite number.`);
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains a non-plain array.`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.some((key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))
        ) ||
        keys.length !== candidate.length + 1
      ) {
        throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains a sparse or extended array.`);
      }
      const result: unknown[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains an accessor or hidden value.`);
        }
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    if (typeof candidate !== "object") {
      throw new BrowserAuthorityError("TARGET_REJECTED", `${field} is not plain JSON data.`);
    }
    const prototype = Object.getPrototypeOf(candidate) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains a non-plain object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") {
        throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains a symbol key.`);
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new BrowserAuthorityError("TARGET_REJECTED", `${field} contains an accessor or hidden value.`);
      }
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const cloned = visit(value, 0);
  const serialized = JSON.stringify(cloned);
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength > MAX_WRITE_VALUE_BYTES
  ) {
    throw new BrowserAuthorityError(
      "TARGET_REJECTED",
      `${field} exceeds the fixed 5000000-byte adapter limit.`,
    );
  }
  return cloned;
}

function exactFormFields(
  value: readonly (readonly [string, string])[],
  field: string,
): readonly (readonly [string, string])[] {
  const cloned = exactJsonData(value, field);
  if (!Array.isArray(cloned)) {
    throw new BrowserAuthorityError("TARGET_REJECTED", `${field} must be an ordered array.`);
  }
  const fields = cloned.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        `${field} must contain only exact string pairs.`,
      );
    }
    return Object.freeze([entry[0], entry[1]] as const);
  });
  return Object.freeze(fields);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const ZERO_ELEMENT_KEY = /^(?:0|[1-9]\d*)$/u;
const ZERO_ELEMENT_ID = /^[1-9]\d*$/u;

interface ZeroCleanModelParts {
  readonly model: Record<string, unknown>;
  readonly keys: readonly string[];
  readonly elementKeys: readonly string[];
  readonly ids: ReadonlySet<string>;
}

function exactZeroModel(value: unknown, field: string): ZeroCleanModelParts {
  const model = plainRecord(value);
  if (model === null) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      `${field} must be a plain keyed object.`,
    );
  }
  const keys = Object.keys(model);
  for (const key of keys) {
    if (
      /^\d+$/u.test(key) &&
      (!ZERO_ELEMENT_KEY.test(key) || !Number.isSafeInteger(Number(key)))
    ) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        `${field} contains a non-canonical numeric element key.`,
      );
    }
  }
  if (!["groups", "meta", "timestamp"].every((key) => Object.hasOwn(model, key))) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      `${field} is missing the reproduced groups/meta/timestamp metadata.`,
    );
  }
  const elementKeys = keys.filter((key) => ZERO_ELEMENT_KEY.test(key));
  if (elementKeys.length === 0) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      `${field} must contain at least one hydrated numeric element.`,
    );
  }
  const ids = new Set<string>();
  for (const key of elementKeys) {
    const element = plainRecord(model[key]);
    if (element === null) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        `${field} contains a non-object numeric element.`,
      );
    }
    if (typeof element.elem_id !== "string" || !ZERO_ELEMENT_ID.test(element.elem_id)) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        `${field} contains a non-canonical element identity.`,
      );
    }
    if (ids.has(element.elem_id)) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        `${field} contains duplicate element identities.`,
      );
    }
    ids.add(element.elem_id);
  }
  return { model, keys, elementKeys, ids };
}

function exactZeroCleanModel(read: ExactEditorRecordRead): Record<string, unknown> {
  const payload = plainRecord(exactJsonData(read.payload, "Zero runtime payload"));
  if (payload === null || !Object.hasOwn(payload, "cleanElementsData")) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Zero runtime did not return cleanElementsData from the bound child frame.",
    );
  }
  return exactZeroModel(payload.cleanElementsData, "Zero cleanElementsData").model;
}

function exactStandardStringField(read: ExactEditorRecordRead, field: string): string {
  if (!isSafeStandardContentField(field)) {
    throw new BrowserAuthorityError("WRITE_IDENTITY_REJECTED", "Standard field name is invalid.");
  }
  if ((read.ambiguousRenderedFields ?? []).includes(field)) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Standard field is duplicated in the rendered exact record.",
    );
  }
  const payload = plainRecord(exactJsonData(read.payload, "Standard settings payload"));
  const record = payload === null ? null : plainRecord(payload.record);
  if (record === null) {
    throw new BrowserAuthorityError("WRITE_IDENTITY_REJECTED", "Standard settings record is missing.");
  }
  const raw = Object.hasOwn(record, field) ? record[field] : undefined;
  if (raw !== undefined && typeof raw !== "string") {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Standard field exists but is not a top-level string.",
    );
  }
  const rendered = (read.renderedFields ?? []).filter((candidate) => candidate.name === field);
  if (rendered.length > 1 || rendered.some((candidate) => typeof candidate.value !== "string")) {
    throw new BrowserAuthorityError("WRITE_IDENTITY_REJECTED", "Rendered standard field is ambiguous.");
  }
  const renderedValue = rendered[0]?.value ??
    (read.writableField?.name === field ? read.writableField.value : undefined);
  if (typeof raw === "string" && renderedValue !== undefined && raw !== renderedValue) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Standard settings and rendered field values disagree.",
    );
  }
  const value = typeof raw === "string" ? raw : renderedValue;
  if (value === undefined) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Standard field is absent from the fresh exact record read.",
    );
  }
  return value;
}

interface ValidatedZeroTransition {
  readonly model: Record<string, unknown>;
  readonly operation: ChangeOperation;
  readonly elementId: string;
}

function assertSupportedZeroTransition(
  current: Record<string, unknown>,
  intendedValue: unknown,
): ValidatedZeroTransition {
  const currentParts = exactZeroModel(current, "Current Zero cleanElementsData");
  const intendedData = exactJsonData(intendedValue, "Intended Zero clean runtime model");
  const intendedParts = exactZeroModel(intendedData, "Intended Zero cleanElementsData");
  // Tilda refreshes this service-level field while hydrating the runtime
  // model.  Rebind only that field to the freshly read value; all element
  // data and other metadata (including unknown fields) remain caller-owned
  // transition inputs and are checked below without normalization.
  intendedParts.model.timestamp = currentParts.model.timestamp;
  const before = currentParts.model;
  const after = intendedParts.model;
  const sameKeySet = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((key) => right.includes(key));
  const isElementKey = (key: string): boolean => ZERO_ELEMENT_KEY.test(key);
  const id = (element: Record<string, unknown>): string =>
    typeof element.elem_id === "string" ? element.elem_id : "";
  const type = (element: Record<string, unknown>): unknown =>
    element.type ?? element.elem_type;
  const basicElementTypes = new Set(["text", "image", "shape", "button", "html"]);
  const primitiveKind = (value: unknown): "string" | "number" | "boolean" | "null" | null => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") {
      return typeof value as "string" | "boolean";
    }
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    return null;
  };
  const canonicalProperty = (value: string): boolean =>
    /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(value) &&
    !["elem_id", "type", "elem_type"].includes(value);
  const stripCloneFields = (element: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(element).filter(
        ([key]) => !["elem_id", "left", "top", "zindex"].includes(key),
      ),
    );
  const geometryIsFinite = (element: Record<string, unknown>): boolean =>
    [element.left, element.top, element.zindex].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    );
  const runtimeGeometryIsFinite = (element: Record<string, unknown>): boolean =>
    [element.left, element.top, element.zindex].every((value) =>
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" &&
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) &&
        Number.isFinite(Number(value))),
    );
  const allCommonValuesEqual = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    keys: readonly string[],
  ): boolean =>
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  const maxNumericKey = (keys: readonly string[]): number =>
    Math.max(...keys.map((key) => Number(key)));
  let authorization: Omit<ValidatedZeroTransition, "model"> | null = null;
  if (sameKeySet(currentParts.keys, intendedParts.keys)) {
    const changed: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> = [];
    let metadataChanged = false;
    for (const key of currentParts.keys) {
      const beforeElement = before[key];
      const afterElement = after[key];
      if (isElementKey(key)) {
        const beforeRecord = plainRecord(beforeElement);
        const afterRecord = plainRecord(afterElement);
        if (beforeRecord === null || afterRecord === null || id(beforeRecord) !== id(afterRecord)) {
          throw new BrowserAuthorityError(
            "WRITE_IDENTITY_REJECTED",
            "Zero element order or identity changed.",
          );
        }
        if (!jsonEqual(beforeRecord, afterRecord)) {
          changed.push({ before: beforeRecord, after: afterRecord });
        }
      } else if (!jsonEqual(beforeElement, afterElement)) {
        metadataChanged = true;
      }
    }
    if (!metadataChanged && changed.length === 1) {
      const change = changed[0]!;
      const keys = new Set([...Object.keys(change.before), ...Object.keys(change.after)]);
      const changedKeys = [...keys].filter(
        (key) => !jsonEqual(change.before[key], change.after[key]),
      );
      const property = changedKeys[0];
      const currentType = type(change.before);
      const genericPrimitivePatch =
        changedKeys.length === 1 &&
        property !== undefined &&
        canonicalProperty(property) &&
        basicElementTypes.has(String(currentType)) &&
        type(change.after) === currentType &&
        Object.hasOwn(change.before, property) &&
        Object.hasOwn(change.after, property) &&
        primitiveKind(change.before[property]) !== null &&
        primitiveKind(change.before[property]) === primitiveKind(change.after[property]);
      const legacyLinkPatch =
        changedKeys.length === 1 &&
          changedKeys[0] === "link" &&
          type(change.before) === "text" &&
          (typeof change.after.link === "string" ||
            (typeof change.before.link === "string" && !Object.hasOwn(change.after, "link")));
      const legacyResponsivePatch =
        changedKeys.length === 1 &&
          changedKeys[0] === "left-res-480" &&
          type(change.before) === "shape" &&
          typeof change.after["left-res-480"] === "number" &&
          Number.isFinite(change.after["left-res-480"]);
      if (genericPrimitivePatch || legacyLinkPatch || legacyResponsivePatch) {
        authorization = {
          operation: legacyLinkPatch
            ? "zero.leaf.patch"
            : legacyResponsivePatch
              ? "zero.responsive.patch"
              : "zero.property.patch",
          elementId: id(change.before),
        };
      }
    }
  } else {
    const addedKeys = intendedParts.elementKeys.filter(
      (key) => !currentParts.elementKeys.includes(key),
    );
    const removedKeys = currentParts.elementKeys.filter(
      (key) => !intendedParts.elementKeys.includes(key),
    );
    const currentMetadataKeys = currentParts.keys.filter((key) => !isElementKey(key));
    const intendedMetadataKeys = intendedParts.keys.filter((key) => !isElementKey(key));
    const metadataUnchanged =
      currentMetadataKeys.length === intendedMetadataKeys.length &&
      currentMetadataKeys.every(
        (key) => Object.hasOwn(after, key) && jsonEqual(before[key], after[key]),
      );
    if (addedKeys.length === 1 && removedKeys.length === 0 && metadataUnchanged) {
      const addedKey = addedKeys[0]!;
      const expectedKey = String(maxNumericKey(currentParts.elementKeys) + 1);
      const clone = plainRecord(after[addedKey]);
      if (clone !== null) {
        const sources = currentParts.elementKeys
          .map((key) => plainRecord(before[key]))
          .filter(
            (element): element is Record<string, unknown> =>
              element !== null &&
              basicElementTypes.has(String(type(element))) &&
              type(element) === type(clone) &&
              jsonEqual(stripCloneFields(element), stripCloneFields(clone)),
          );
        const accepted =
          addedKey === expectedKey &&
          allCommonValuesEqual(before, after, currentParts.keys) &&
          basicElementTypes.has(String(type(clone))) &&
          ZERO_ELEMENT_ID.test(id(clone)) &&
          !currentParts.ids.has(id(clone)) &&
          sources.length === 1 &&
          runtimeGeometryIsFinite(clone);
        if (accepted) {
          authorization = {
            operation: type(clone) === "shape" ? "zero.shape.clone" : "zero.element.clone",
            elementId: id(sources[0]!),
          };
        }
      }
    } else if (addedKeys.length === 0 && removedKeys.length === 1 && metadataUnchanged) {
      const removedKey = removedKeys[0]!;
      const expectedKey = String(maxNumericKey(currentParts.elementKeys));
      const removed = plainRecord(before[removedKey]);
      if (removed !== null) {
        const sources = intendedParts.elementKeys
          .map((key) => plainRecord(after[key]))
          .filter(
            (element): element is Record<string, unknown> =>
              element !== null &&
              basicElementTypes.has(String(type(element))) &&
              type(element) === type(removed) &&
              jsonEqual(stripCloneFields(element), stripCloneFields(removed)),
          );
        const accepted =
          removedKey === expectedKey &&
          allCommonValuesEqual(after, before, intendedParts.keys) &&
          basicElementTypes.has(String(type(removed))) &&
          ZERO_ELEMENT_ID.test(id(removed)) &&
          !intendedParts.ids.has(id(removed)) &&
          sources.length === 1 &&
          runtimeGeometryIsFinite(removed);
        if (accepted) {
          authorization = {
            operation: type(removed) === "shape" ? "zero.shape.clone" : "zero.element.clone",
            elementId: id(sources[0]!),
          };
        }
      }
    }
  }
  if (authorization === null || !ZERO_ELEMENT_ID.test(authorization.elementId)) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Zero write must be one existing primitive property patch, one supported basic-element clone, or its strict inverse removal.",
    );
  }
  return { model: after, ...authorization };
}

function assertMetaDescriptionTransition(
  current: readonly (readonly [string, string])[],
  intendedValue: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  const intended = exactFormFields(intendedValue, "Intended page settings form");
  if (current.length !== intended.length) {
    throw new BrowserAuthorityError("WRITE_IDENTITY_REJECTED", "Page settings form shape changed.");
  }
  let metaDescriptionChanges = 0;
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = intended[index]!;
    if (before[0] !== after[0]) {
      throw new BrowserAuthorityError("WRITE_IDENTITY_REJECTED", "Page settings field order changed.");
    }
    if (before[1] !== after[1]) {
      if (before[0] !== "meta_descr") {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Only the reproduced meta_descr page setting may change.",
        );
      }
      metaDescriptionChanges += 1;
    }
  }
  if (
    current.filter(([name]) => name === "meta_descr").length !== 1 ||
    metaDescriptionChanges !== 1
  ) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Page settings write requires exactly one changed meta_descr field.",
    );
  }
  return intended;
}

class LoopbackBrowserAuthorityLease implements LoopbackBrowserAuthority {
  readonly metadata: BrowserAuthorityMetadata;
  readonly inventory: LiveInventory;
  readonly adapter: LoopbackCdpAdapterPort;
  readonly #expiresAtMs: number;
  #closed = false;
  #adapterOperationActive = false;
  #mutationSlotConsumed = false;

  constructor(
    readonly binding: TrustedBindingEstablished,
    private readonly config: ResearchConfig,
    private readonly session: AuthorityOwnedLoopbackBrowserSession,
    private readonly processLeaseToken: object,
    private readonly dependencies: LoopbackBrowserAuthorityDependencies,
    private readonly taskGuard: TaskAuthorityGuard | undefined,
    leaseTtlMs: number,
  ) {
    const acquiredAtMs = dependencies.now();
    const bindingExpiry = Date.parse(binding.captureContext.expiresAt ?? "");
    const taskExpiry = Date.parse(taskGuard?.receipt().expiresAt ?? "");
    this.#expiresAtMs = Math.min(
      acquiredAtMs + leaseTtlMs,
      Number.isFinite(bindingExpiry) ? bindingExpiry : acquiredAtMs,
      Number.isFinite(taskExpiry) ? taskExpiry : acquiredAtMs + leaseTtlMs,
    );
    this.inventory = binding.inventory;
    this.metadata = Object.freeze({
      leaseId: dependencies.randomId(),
      sessionId: session.sessionId,
      cdpTargetId: binding.captureContext.cdpTargetId ?? "",
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      expiresAt: new Date(this.#expiresAtMs).toISOString(),
      transport: "loopback_cdp",
      accountFingerprint: binding.accountFingerprint,
      inventoryHash: binding.inventoryHash,
    });
    this.adapter = Object.freeze({
      readEditorPage: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readPage(target, timeoutMs),
      readStandardSettings: (target: LabRecordTarget, timeoutMs?: number) =>
        this.#readRecord(target, "standard", timeoutMs),
      readT123Content: (target: LabRecordTarget, timeoutMs?: number) =>
        this.#readRecord(target, "t123", timeoutMs),
      readZeroModel: (
        target: LabRecordTarget,
        timeoutMs?: number,
        authorizationElementId?: string,
      ) => this.#readRecord(target, "zero", timeoutMs, authorizationElementId),
      revealExactRecordControl: (
        target: LabRecordTarget,
        controlKey: string,
        timeoutMs?: number,
      ) => this.#revealExactRecordControl(target, controlKey, timeoutMs),
      readRenderedBlockLibrary: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readRenderedBlockLibrary(target, timeoutMs),
      preflightKnownTemplateAdd: (
        target: LabPageTarget,
        templateId: KnownObservedTemplateId,
        timeoutMs?: number,
      ) => this.#preflightKnownTemplateAdd(target, templateId, timeoutMs),
      writeStandard: (
        target: LabRecordTarget,
        field: StandardWritableField,
        value: string,
        timeoutMs?: number,
      ) => this.#writeStandard(target, field, value, timeoutMs),
      writeT123: (target: LabRecordTarget, code: string, timeoutMs?: number) =>
        this.#writeT123(target, code, timeoutMs),
      writeZeroModel: (
        target: LabRecordTarget,
        intendedCleanElementsData: unknown,
        timeoutMs?: number,
        authorizationElementId?: string,
      ) => this.#writeZeroModel(
        target,
        intendedCleanElementsData,
        timeoutMs,
        authorizationElementId,
      ),
      preflightZeroModel: (
        target: LabRecordTarget,
        intendedCleanElementsData: unknown,
        timeoutMs?: number,
      ) => this.#preflightZeroModel(target, intendedCleanElementsData, timeoutMs),
      readPageSettings: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readPageSettings(target, timeoutMs),
      writePageSettings: (
        target: LabPageTarget,
        intendedFields: readonly (readonly [string, string])[],
        timeoutMs?: number,
      ) => this.#writePageSettings(target, intendedFields, timeoutMs),
      readPageHeadCode: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readPageHeadCode(target, timeoutMs),
      writePageHeadCode: (
        target: LabPageTarget,
        intendedCode: string,
        expectedCurrentCode: string,
        timeoutMs?: number,
      ) => this.#writePageHeadCode(target, intendedCode, expectedCurrentCode, timeoutMs),
      publishPage: (target: LabPageTarget, timeoutMs?: number) =>
        this.#writePublication(target, "publish", timeoutMs),
      unpublishPage: (target: LabPageTarget, timeoutMs?: number) =>
        this.#writePublication(target, "unpublish", timeoutMs),
      runFixedPageLifecycle: (target: LabPageTarget, timeoutMs?: number) =>
        this.#runFixedPageLifecycle(target, timeoutMs),
      createPageFromReference: (target: LabPageTarget, timeoutMs?: number) =>
        this.#createPageFromReference(target, timeoutMs),
      cleanupReferencePage: (receipt: CreatedReferencePageReceipt, timeoutMs?: number) =>
        this.#cleanupReferencePage(receipt, timeoutMs),
      addKnownTemplate: (
        target: LabPageTarget,
        templateId: KnownObservedTemplateId,
        timeoutMs?: number,
      ) => this.#addKnownTemplate(target, templateId, timeoutMs),
    });
  }

  assertFresh(): void {
    if (this.#closed) {
      throw new BrowserAuthorityError("AUTHORITY_CLOSED", "Browser authority lease is closed.");
    }
    if (this.taskGuard !== undefined) {
      // receipt() rechecks expiry and the manager-owned revocation token. This
      // is deliberately repeated at the mutation boundary so replacing or
      // clearing a task while an adapter performs its fresh reread cannot let
      // the old lease dispatch afterward.
      const task = this.taskGuard.receipt();
      if (
        task.accountFingerprint !== this.metadata.accountFingerprint ||
        task.inventoryHash !== this.metadata.inventoryHash
      ) {
        throw new BrowserAuthorityError(
          "BINDING_STALE",
          "Task authority no longer matches this exact browser binding.",
        );
      }
    }
    if (
      activeProcessLeaseToken !== this.processLeaseToken ||
      this.binding.captureContext.cdpTargetId === null ||
      this.binding.captureContext.cdpTargetId !== this.session.sessionId ||
      this.metadata.cdpTargetId !== this.session.sessionId ||
      !this.dependencies.isFreshBinding(this.binding)
    ) {
      throw new BrowserAuthorityError(
        "BINDING_STALE",
        "The same-process binding no longer belongs to this exact browser session.",
      );
    }
    if (this.dependencies.now() > this.#expiresAtMs) {
      throw new BrowserAuthorityError(
        "AUTHORITY_EXPIRED",
        "Browser authority lease expired; acquire a fresh exact-tab binding before continuing.",
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#adapterOperationActive) {
      throw new BrowserAuthorityError(
        "AUTHORITY_OPERATION_IN_PROGRESS",
        "Cannot close browser authority while an adapter operation is in progress.",
      );
    }
    this.#closed = true;
    let restoreError: unknown = null;
    try {
      await this.session.restoreRoot(MAX_ADAPTER_TIMEOUT_MS);
    } catch (error) {
      restoreError = error;
    } finally {
      try {
        await this.session.close();
      } finally {
        if (activeProcessLeaseToken === this.processLeaseToken) {
          activeProcessLeaseToken = null;
        }
      }
    }
    if (restoreError !== null) {
      throw new BrowserAuthorityError(
        "ROOT_RESTORE_FAILED",
        "The authority session closed but the exact projects root could not be restored.",
        { cause: restoreError },
      );
    }
  }

  async #readPage(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactEditorPageSnapshot> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertReadPageTarget(exactTarget);
      return this.session.readEditorPage(exactTarget, normalizeAdapterTimeout(timeoutMs));
    });
  }

  async #readRecord(
    target: LabRecordTarget,
    kind: "standard" | "t123" | "zero",
    timeoutMs: number | undefined,
    authorizationElementId?: string,
  ): Promise<ExactEditorRecordRead> {
    const exactTarget = exactPlainRecordTarget(target);
    return this.#runAdapterOperation(async () => {
      if (kind === "zero" && authorizationElementId !== undefined) {
        this.#assertReadElementTarget(exactTarget, authorizationElementId);
      } else {
        this.#assertReadRecordTarget(exactTarget);
      }
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      if (kind === "standard") {
        return this.session.readStandardSettings(exactTarget, boundedTimeout);
      }
      if (kind === "t123") {
        return this.session.readT123Content(exactTarget, boundedTimeout);
      }
      return this.session.readZeroModel(exactTarget, boundedTimeout);
    });
  }

  async #revealExactRecordControl(
    target: LabRecordTarget,
    controlKey: string,
    timeoutMs: number | undefined,
  ): Promise<ExactRecordHoverControlReveal> {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(controlKey)) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        "Record control key must be a bounded property identifier.",
      );
    }
    return this.#runAdapterOperation(async () => {
      const exactTarget = exactPlainRecordTarget(target);
      this.#assertReadRecordTarget(exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const page = await this.session.readEditorPage(exactTarget, boundedTimeout);
      const identity = this.#exactRecordIdentity(page, exactTarget);
      let reveal: ExactRecordHoverControlReveal;
      try {
        reveal = await this.session.revealExactRecordControl(
          exactTarget,
          identity,
          controlKey,
          boundedTimeout,
        );
      } catch (error) {
        throwRecordControlProbeError(error);
      }
      if (
        reveal.target.projectId !== exactTarget.projectId ||
        reveal.target.pageId !== exactTarget.pageId ||
        reveal.target.recordId !== exactTarget.recordId ||
        reveal.ownerRecordId !== exactTarget.recordId ||
        reveal.controlKey !== controlKey ||
        reveal.connected !== true ||
        reveal.identity.recordId !== identity.recordId ||
        reveal.identity.recordType !== identity.recordType ||
        reveal.identity.recordCode !== identity.recordCode ||
        reveal.identity.recordCategory !== identity.recordCategory
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Hover-revealed control evidence is not owned by the exact record identity.",
        );
      }
      return Object.freeze({
        ...reveal,
        target: exactPlainRecordTarget(reveal.target),
        identity: Object.freeze({ ...reveal.identity }),
      });
    });
  }

  async #readRenderedBlockLibrary(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<RenderedBlockLibraryIndex> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertReadPageTarget(exactTarget);
      const index = await this.session.readRenderedBlockLibrary(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      if (
        index.target.projectId !== exactTarget.projectId ||
        index.target.pageId !== exactTarget.pageId ||
        index.mutationIssued !== false ||
        index.templates.length === 0 ||
        index.templates.length > 2_000 ||
        index.categories.length > 100 ||
        index.categories.some((category) => category.trim() !== category || category.length < 1 || category.length > 128)
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Rendered block-library inspection did not remain bound to the exact page.",
        );
      }
      const identities = new Set<string>();
      for (const template of index.templates) {
        const identity = `${template.templateId}:${template.code}`;
        if (
          !/^[1-9]\d*$/u.test(template.templateId) ||
          !/^[A-Z][A-Z0-9]{1,15}$/u.test(template.code) ||
          identities.has(identity)
        ) {
          throw new BrowserAuthorityError(
            "WRITE_IDENTITY_REJECTED",
            "Rendered block-library template identity is invalid or duplicated.",
          );
        }
        identities.add(identity);
      }
      return Object.freeze({
        target: exactPlainPageTarget(index.target),
        categories: Object.freeze([...index.categories]),
        templates: Object.freeze(index.templates.map((template) => Object.freeze({ ...template }))),
        mutationIssued: false,
      });
    });
  }

  async #preflightKnownTemplateAdd(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs: number | undefined,
  ): Promise<KnownTemplateAddPreflight> {
    if (!["128", "778", "131", "396"].includes(templateId)) {
      throw new BrowserAuthorityError("TARGET_REJECTED", "Template is outside EXP-06 observations.");
    }
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertReadPageTarget(exactTarget);
      const result = await this.session.preflightKnownTemplateAdd(
        exactTarget,
        templateId,
        normalizeAdapterTimeout(timeoutMs),
      );
      if (
        result.target.projectId !== exactTarget.projectId ||
        result.target.pageId !== exactTarget.pageId ||
        result.templateId !== templateId ||
        result.runtimeFunction !== "tp__addRecord" ||
        result.runtimeFunctionHash !== "19510095bc198f51ed297e2ba02291d9e6d3ebc72da7b0724886af7ff60ae5cc" ||
        result.mutationIssued !== false ||
        result.evidence !== "LIVE_OBSERVED_PREFLIGHT_ONLY"
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Known-template add preflight did not match the exact EXP-06 runtime observation.",
        );
      }
      return Object.freeze({ ...result, target: exactPlainPageTarget(result.target) });
    });
  }

  async #writeStandard(
    target: LabRecordTarget,
    field: StandardWritableField,
    value: string,
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    if (!isSafeStandardContentField(field)) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        "Standard write requires a bounded canonical top-level field name.",
      );
    }
    const boundedValue = assertBoundedWriteValue(value, "Standard field value");
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      const exactTarget = exactPlainRecordTarget(target);
      this.#assertChangeRecordTarget("standard.field.patch", exactTarget);
      const page = await this.session.readEditorPage(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      const identity = this.#exactRecordIdentity(page, exactTarget);
      const fresh = await this.session.readStandardSettings(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      if (
        fresh.target.projectId !== exactTarget.projectId ||
        fresh.target.pageId !== exactTarget.pageId ||
        fresh.target.recordId !== exactTarget.recordId ||
        fresh.identity.recordId !== identity.recordId ||
        fresh.identity.recordType !== identity.recordType ||
        fresh.identity.recordCode !== identity.recordCode ||
        fresh.identity.recordCategory !== identity.recordCategory
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Fresh standard field read does not match the exact editor record identity.",
        );
      }
      if (exactStandardStringField(fresh, field) === boundedValue) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Standard field write must change the exact fresh string value.",
        );
      }
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.writeStandard(
          exactTarget,
          field,
          boundedValue,
          normalizeAdapterTimeout(timeoutMs),
        ));
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #writeT123(
    target: LabRecordTarget,
    code: string,
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    const boundedCode = assertBoundedWriteValue(code, "T123 code");
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      const exactTarget = exactPlainRecordTarget(target);
      this.#assertChangeRecordTarget("t123.code.replace", exactTarget);
      const page = await this.session.readEditorPage(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      const identity = this.#exactRecordIdentity(page, exactTarget);
      if (identity.recordType !== "131" || identity.recordCode !== "T123") {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current record identity is not the reproduced T123 / 131 contract.",
        );
      }
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.writeT123(
          exactTarget,
          boundedCode,
          normalizeAdapterTimeout(timeoutMs),
        ));
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #preflightZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number | undefined,
  ): Promise<FixedZeroWritePreflightResult> {
    return this.#runAdapterOperation(async () => {
      const exactTarget = exactPlainRecordTarget(target);
      this.#assertReadRecordTarget(exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const fresh = await this.session.readZeroModel(exactTarget, boundedTimeout);
      if (
        fresh.target.projectId !== exactTarget.projectId ||
        fresh.target.pageId !== exactTarget.pageId ||
        fresh.target.recordId !== exactTarget.recordId ||
        fresh.identity.recordType !== "396" ||
        fresh.identity.recordCode !== "T396"
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current record identity is not the reproduced T396 / 396 runtime contract.",
        );
      }
      const current = exactZeroCleanModel(fresh);
      const intended = assertSupportedZeroTransition(current, intendedCleanElementsData).model;
      this.assertFresh();
      return this.session.preflightZeroModel(exactTarget, intended, boundedTimeout);
    });
  }

  async #writeZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number | undefined,
    authorizationElementId?: string,
  ): Promise<FixedDispatchReceipt> {
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      const exactTarget = exactPlainRecordTarget(target);
      if (this.taskGuard === undefined) this.#assertReadRecordTarget(exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const fresh = await this.session.readZeroModel(exactTarget, boundedTimeout);
      if (
        fresh.target.projectId !== exactTarget.projectId ||
        fresh.target.pageId !== exactTarget.pageId ||
        fresh.target.recordId !== exactTarget.recordId ||
        fresh.identity.recordType !== "396" ||
        fresh.identity.recordCode !== "T396"
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current record identity is not the reproduced T396 / 396 runtime contract.",
        );
      }
      const current = exactZeroCleanModel(fresh);
      const transition = assertSupportedZeroTransition(current, intendedCleanElementsData);
      if (
        authorizationElementId !== undefined &&
        transition.elementId !== authorizationElementId
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Validated Zero transition does not match the exact requested element target.",
        );
      }
      this.#assertChangeElementTarget(
        transition.operation,
        exactTarget,
        transition.elementId,
      );
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.writeZeroModel(
          exactTarget,
          transition.model,
          boundedTimeout,
        ));
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #readPageSettings(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactPageSettingsRead> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertReadPageTarget(exactTarget);
      const read = await this.session.readPageSettings(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      return Object.freeze({
        target: exactPlainPageTarget(read.target),
        fields: exactFormFields(read.fields, "Page settings form"),
      });
    });
  }

  async #writePageSettings(
    target: LabPageTarget,
    intendedFields: readonly (readonly [string, string])[],
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#assertChangePageTarget("page.seo.patch", exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const fresh = await this.session.readPageSettings(exactTarget, boundedTimeout);
      if (
        fresh.target.projectId !== exactTarget.projectId ||
        fresh.target.pageId !== exactTarget.pageId
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current page settings form does not match the exact requested page.",
        );
      }
      const current = exactFormFields(fresh.fields, "Current page settings form");
      const intended = assertMetaDescriptionTransition(current, intendedFields);
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.writePageSettings(
          exactTarget,
          intended,
          boundedTimeout,
        ));
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #readPageHeadCode(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactPageHeadCodeRead> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertReadPageTarget(exactTarget);
      const read = await this.session.readPageHeadCode(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      if (
        read.target.projectId !== exactTarget.projectId ||
        read.target.pageId !== exactTarget.pageId
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current page HEAD surface does not match the exact requested page.",
        );
      }
      return Object.freeze({
        ...read,
        target: exactPlainPageTarget(read.target),
        code: assertBoundedWriteValue(read.code, "Page HEAD code"),
      });
    });
  }

  async #writePageHeadCode(
    target: LabPageTarget,
    intendedCode: string,
    expectedCurrentCode: string,
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    const exactTarget = exactPlainPageTarget(target);
    const boundedCode = assertBoundedWriteValue(intendedCode, "Page HEAD code");
    const boundedExpectedCode = assertBoundedWriteValue(
      expectedCurrentCode,
      "Expected current page HEAD code",
    );
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#assertChangePageTarget("page.head.code.replace", exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const fresh = await this.session.readPageHeadCode(exactTarget, boundedTimeout);
      if (
        fresh.target.projectId !== exactTarget.projectId ||
        fresh.target.pageId !== exactTarget.pageId
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current page HEAD surface does not match the exact requested page.",
        );
      }
      if (fresh.code === boundedCode) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Page HEAD write must change the exact current full code.",
        );
      }
      if (fresh.code !== boundedExpectedCode) {
        throw new BrowserAuthorityError(
          "STALE_TARGET",
          "Page HEAD code changed after the adapter snapshot and before dispatch.",
        );
      }
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.writePageHeadCode(
          exactTarget,
          boundedCode,
          boundedExpectedCode,
          boundedTimeout,
        ));
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #writePublication(
    target: LabPageTarget,
    action: "publish" | "unpublish",
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#assertPublicationTarget(action, exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const fresh = await this.session.readEditorPage(exactTarget, boundedTimeout);
      if (
        fresh.target.projectId !== exactTarget.projectId ||
        fresh.target.pageId !== exactTarget.pageId ||
        fresh.published === null ||
        !fresh.editorLoadedAnchor
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current editor globals do not prove the exact publication page target.",
        );
      }
      const { operationId, result } = await this.#dispatchMutation(() =>
        action === "publish"
          ? this.session.publishPage(exactTarget, boundedTimeout)
          : this.session.unpublishPage(exactTarget, boundedTimeout));
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #createPageFromReference(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<CreatedReferencePageReceipt> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#assertChangePageTarget("page.reference.clone", exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.createPageFromReference(
          exactTarget,
          boundedTimeout,
        ));
      const createdTarget = exactPlainPageTarget(result.created.target);
      const family = (records: readonly EditorRecordIdentity[]) => records.map(
        ({ recordType, recordCode, recordCategory }) => ({ recordType, recordCode, recordCategory }),
      );
      const baselineIds = new Set(result.baseline.activePageIds);
      const inventoryPageIds = this.inventory.pageOwnership[exactTarget.projectId] ?? [];
      const createdDelta = result.created.activePageIds.filter((pageId) => !baselineIds.has(pageId));
      const sourceRecordIds = new Set(result.baseline.sourceRecords.map(({ recordId }) => recordId));
      if (
        result.baseline.target.projectId !== exactTarget.projectId ||
        result.baseline.target.pageId !== exactTarget.pageId ||
        createdTarget.projectId !== exactTarget.projectId ||
        createdTarget.pageId === exactTarget.pageId ||
        result.created.published !== false ||
        result.baseline.activePageIds.length < 1 ||
        result.baseline.activePageIds.length !== inventoryPageIds.length ||
        result.baseline.activePageIds.some((pageId) => !inventoryPageIds.includes(pageId)) ||
        result.baseline.activePageIds.length !== result.baseline.pageOrder.length ||
        result.created.activePageIds.length !== result.created.pageOrder.length ||
        createdDelta.length !== 1 ||
        createdDelta[0] !== createdTarget.pageId ||
        result.created.records.length !== result.baseline.sourceRecords.length ||
        result.created.records.some(({ recordId }) => sourceRecordIds.has(recordId)) ||
        !jsonEqual(family(result.created.records), family(result.baseline.sourceRecords))
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Reference-page duplicate did not prove one exact unpublished parity clone.",
        );
      }
      const freezeRecords = (records: readonly EditorRecordIdentity[]) => Object.freeze(
        records.map((record) => Object.freeze({ ...record })),
      );
      const receipt = Object.freeze({
        kind: "created_reference_page" as const,
        receiptId: operationId,
        accountFingerprint: this.metadata.accountFingerprint,
        sourceTarget: exactTarget,
        createdTarget,
        baselineActivePageIds: Object.freeze([...result.baseline.activePageIds]),
        baselinePageOrder: Object.freeze([...result.baseline.pageOrder]),
        createdActivePageIds: Object.freeze([...result.created.activePageIds]),
        createdPageOrder: Object.freeze([...result.created.pageOrder]),
        sourceRecords: freezeRecords(result.baseline.sourceRecords),
        createdRecords: freezeRecords(result.created.records),
        consumed: false as const,
      });
      createdReferencePageReceipts.add(receipt);
      return receipt;
    });
  }

  async #cleanupReferencePage(
    receipt: CreatedReferencePageReceipt,
    timeoutMs: number | undefined,
  ): Promise<FixedReferencePageCleanupResult> {
    if (!createdReferencePageReceipts.has(receipt) || !Object.isFrozen(receipt)) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        "Reference cleanup requires an unconsumed process-owned creation receipt.",
      );
    }
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      if (receipt.accountFingerprint !== this.metadata.accountFingerprint) {
        throw new BrowserAuthorityError("TARGET_REJECTED", "Reference receipt belongs to another account.");
      }
      const source = exactPlainPageTarget(receipt.sourceTarget);
      const created = exactPlainPageTarget(receipt.createdTarget);
      this.#assertChangePageTarget("page.reference.cleanup", source);
      const ownedPages = this.inventory.pageOwnership[source.projectId] ?? [];
      if (
        created.projectId !== source.projectId ||
        created.pageId === source.pageId ||
        !ownedPages.includes(source.pageId) ||
        !ownedPages.includes(created.pageId)
      ) {
        throw new BrowserAuthorityError(
          "TARGET_REJECTED",
          "Current inventory does not own both receipt-bound reference pages.",
        );
      }
      const { result } = await this.#dispatchMutation(
        () => this.session.cleanupReferencePage(
          source,
          created.pageId,
          receipt.createdActivePageIds,
          receipt.createdPageOrder,
          receipt.sourceRecords,
          receipt.createdRecords,
          normalizeAdapterTimeout(timeoutMs),
        ),
        // Consume before browser invocation. An ambiguous delete may never retry.
        () => createdReferencePageReceipts.delete(receipt),
      );
      return result;
    });
  }

  async #addKnownTemplate(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs: number | undefined,
  ): Promise<CreatedKnownTemplateRecordReceipt> {
    if (!["128", "778", "131", "396"].includes(templateId)) {
      throw new BrowserAuthorityError("TARGET_REJECTED", "Template is outside EXP-06 observations.");
    }
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#assertChangePageTarget("standard.template.add", exactTarget);
      const { operationId, result } = await this.#dispatchMutation(() =>
        this.session.addKnownTemplate(
          exactTarget,
          templateId,
          normalizeAdapterTimeout(timeoutMs),
        ));
      const expectedIdentity = {
        "128": { recordType: "128", recordCode: "TL04" },
        "778": { recordType: "778", recordCode: "ST310N" },
        "131": { recordType: "131", recordCode: "T123" },
        "396": { recordType: "396", recordCode: "T396" },
      }[templateId];
      const beforeIds = result.beforeRecords.map(({ recordId }) => recordId);
      const afterIds = result.afterRecords.map(({ recordId }) => recordId);
      if (
        result.target.projectId !== exactTarget.projectId ||
        result.target.pageId !== exactTarget.pageId ||
        result.templateId !== templateId ||
        result.publishedUnchanged !== true ||
        result.afterRecords.length !== result.beforeRecords.length + 1 ||
        new Set(beforeIds).size !== beforeIds.length ||
        new Set(afterIds).size !== afterIds.length ||
        result.createdRecord.recordType !== expectedIdentity.recordType ||
        result.createdRecord.recordCode !== expectedIdentity.recordCode ||
        !result.afterRecords.some(({ recordId }) => recordId === result.createdRecord.recordId) ||
        result.beforeRecords.some(({ recordId }) => recordId === result.createdRecord.recordId) ||
        result.beforeRecords.some((before) => !result.afterRecords.some(
          (after) => after.recordId === before.recordId && jsonEqual(after, before),
        ))
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Known-template add did not return one exact created-record identity.",
        );
      }
      const receipt = Object.freeze({
        kind: "created_known_template_record" as const,
        receiptId: operationId,
        accountFingerprint: this.metadata.accountFingerprint,
        target: Object.freeze({ ...exactTarget, recordId: result.createdRecord.recordId }),
        templateId,
        identity: Object.freeze({ ...result.createdRecord }),
        beforeRecordIds: Object.freeze(result.beforeRecords.map(({ recordId }) => recordId)),
        afterRecordIds: Object.freeze(result.afterRecords.map(({ recordId }) => recordId)),
        consumed: false as const,
      });
      createdKnownTemplateRecordReceipts.add(receipt);
      return receipt;
    });
  }

  async #runFixedPageLifecycle(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<FixedPageLifecycleResult> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#assertChangePageTarget("page.lifecycle", exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const source = await this.session.readEditorPage(exactTarget, boundedTimeout);
      if (
        source.target.projectId !== exactTarget.projectId ||
        source.target.pageId !== exactTarget.pageId ||
        source.published !== "" ||
        source.records.length === 0 ||
        !source.editorLoadedAnchor
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Fixed page lifecycle requires one exact unpublished nonblank lab source page.",
        );
      }
      const { result } = await this.#dispatchMutation(() =>
        this.session.runFixedPageLifecycle(exactTarget, boundedTimeout));
      return result;
    });
  }

  #assertReadPageTarget(target: LabPageTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertRead(taskPageTarget(target));
      return;
    }
    try {
      assertLabPageTarget(this.config, target, this.binding.inventory);
    } catch (error) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        error instanceof Error ? error.message : "Page target guard rejected the operation.",
        { cause: error },
      );
    }
  }

  #assertReadRecordTarget(target: LabRecordTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertRead(taskRecordTarget(target));
      return;
    }
    try {
      assertLabRecordTarget(this.config, target, this.binding.inventory);
    } catch (error) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        error instanceof Error ? error.message : "Record target guard rejected the operation.",
        { cause: error },
      );
    }
  }

  #assertReadElementTarget(target: LabRecordTarget, elementId: string): void {
    if (!ZERO_ELEMENT_ID.test(elementId)) {
      throw new BrowserAuthorityError("TARGET_REJECTED", "Zero element target is invalid.");
    }
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertRead(taskElementTarget(target, elementId));
      return;
    }
    this.#assertReadRecordTarget(target);
  }

  #assertChangePageTarget(operation: ChangeOperation, target: LabPageTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertChange(operation, taskPageTarget(target));
      return;
    }
    this.#assertReadPageTarget(target);
  }

  #assertChangeRecordTarget(operation: ChangeOperation, target: LabRecordTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertChange(operation, taskRecordTarget(target));
      return;
    }
    this.#assertReadRecordTarget(target);
  }

  #assertChangeElementTarget(
    operation: ChangeOperation,
    target: LabRecordTarget,
    elementId: string,
  ): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertChange(operation, taskElementTarget(target, elementId));
      return;
    }
    this.#assertReadRecordTarget(target);
  }

  #assertPublicationTarget(action: "publish" | "unpublish", target: LabPageTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertPublication(action, taskPageTarget(target));
      return;
    }
    this.#assertReadPageTarget(target);
  }

  #exactRecordIdentity(
    page: ExactEditorPageSnapshot,
    target: LabRecordTarget,
  ): EditorRecordIdentity {
    const matches = page.records.filter((record) => record.recordId === target.recordId);
    if (
      page.target.projectId !== target.projectId ||
      page.target.pageId !== target.pageId ||
      matches.length !== 1
    ) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        "Immediate editor reread did not prove one exact record identity on its parent page.",
      );
    }
    return matches[0]!;
  }

  #consumeMutationSlot(): string {
    this.#assertMutationSlotAvailable();
    // Consume before browser invocation. Any thrown result is ambiguous and is
    // never retried on this lease.
    this.#mutationSlotConsumed = true;
    return this.dependencies.randomId();
  }

  /**
   * Single last-mile boundary shared by every remote mutation surface. A
   * manager-owned task lease prevents successful clear/replace while the
   * browser transaction can still issue one or more fixed remote writes.
   */
  async #dispatchMutation<T>(
    dispatch: () => Promise<T>,
    beforeDispatch: () => void = () => undefined,
  ): Promise<{ readonly operationId: string; readonly result: T }> {
    this.assertFresh();
    const taskLease = this.taskGuard?.beginMutationDispatch();
    try {
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      beforeDispatch();
      const result = await dispatch();
      return { operationId, result };
    } finally {
      taskLease?.release();
    }
  }

  #assertMutationSlotAvailable(): void {
    if (this.#mutationSlotConsumed) {
      throw new BrowserAuthorityError(
        "MUTATION_SLOT_CONSUMED",
        "This authority lease already consumed its one mutation dispatch slot.",
      );
    }
  }

  #dispatchReceipt(
    operationId: string,
    result: FixedBrowserDispatchResult,
  ): FixedDispatchReceipt {
    if (
      result.dispatched !== true ||
      !Number.isSafeInteger(result.status) ||
      result.status < 100 ||
      !Number.isSafeInteger(result.responseBytes) ||
      result.responseBytes < 0 ||
      result.responseBytes > MAX_WRITE_VALUE_BYTES
    ) {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        "Fixed browser write returned an invalid transport observation.",
      );
    }
    return Object.freeze({
      operationId,
      dispatched: true,
      ack: result.httpOk ? "http_ok" : "http_rejected",
      requestBodyPersisted: false,
    });
  }

  async #runAdapterOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertFresh();
    if (this.#adapterOperationActive) {
      throw new BrowserAuthorityError(
        "CONCURRENT_ADAPTER_OPERATION",
        "Only one fixed adapter operation may use the authority lease at a time.",
      );
    }
    this.#adapterOperationActive = true;
    try {
      this.assertFresh();
      return await operation();
    } finally {
      this.#adapterOperationActive = false;
    }
  }
}

class LoopbackBrowserReadAuthorityLease implements LoopbackBrowserReadAuthority {
  readonly metadata: BrowserAuthorityMetadata;
  readonly inventory: LiveInventory;
  readonly reader: LoopbackCdpReadOnlyPort;
  readonly #expiresAtMs: number;
  #closed = false;
  #operationActive = false;

  constructor(
    readonly binding: TrustedBindingEstablished,
    private readonly config: ResearchConfig,
    private readonly session: AuthorityOwnedLoopbackBrowserSession,
    private readonly processLeaseToken: object,
    private readonly dependencies: LoopbackBrowserAuthorityDependencies,
    private readonly taskGuard: TaskAuthorityGuard | undefined,
    leaseTtlMs: number,
  ) {
    const acquiredAtMs = dependencies.now();
    const bindingExpiry = Date.parse(binding.captureContext.expiresAt ?? "");
    const taskExpiry = Date.parse(taskGuard?.receipt().expiresAt ?? "");
    this.#expiresAtMs = Math.min(
      acquiredAtMs + leaseTtlMs,
      Number.isFinite(bindingExpiry) ? bindingExpiry : acquiredAtMs,
      Number.isFinite(taskExpiry) ? taskExpiry : acquiredAtMs + leaseTtlMs,
    );
    this.inventory = binding.inventory;
    this.metadata = Object.freeze({
      leaseId: dependencies.randomId(),
      sessionId: session.sessionId,
      cdpTargetId: binding.captureContext.cdpTargetId ?? "",
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      expiresAt: new Date(this.#expiresAtMs).toISOString(),
      transport: "loopback_cdp",
      accountFingerprint: binding.accountFingerprint,
      inventoryHash: binding.inventoryHash,
    });
    this.reader = Object.freeze({
      readEditorPage: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readPage(target, timeoutMs),
      readStandardSettings: (target: LabRecordTarget, timeoutMs?: number) =>
        this.#readRecord(target, "standard", timeoutMs),
      readT123Content: (target: LabRecordTarget, timeoutMs?: number) =>
        this.#readRecord(target, "t123", timeoutMs),
      readZeroServerRepresentation: (target: LabRecordTarget, timeoutMs?: number) =>
        this.#readRecord(target, "zero_server", timeoutMs),
      readPageHeadCode: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readPageHeadCode(target, timeoutMs),
      revealExactRecordControl: (
        target: LabRecordTarget,
        controlKey: string,
        timeoutMs?: number,
      ) => this.#revealExactRecordControl(target, controlKey, timeoutMs),
      readRenderedBlockLibrary: (target: LabPageTarget, timeoutMs?: number) =>
        this.#readRenderedBlockLibrary(target, timeoutMs),
    });
  }

  assertFresh(): void {
    if (this.#closed) {
      throw new BrowserAuthorityError("AUTHORITY_CLOSED", "Browser read authority lease is closed.");
    }
    if (
      activeProcessLeaseToken !== this.processLeaseToken ||
      this.binding.captureContext.cdpTargetId === null ||
      this.binding.captureContext.cdpTargetId !== this.session.sessionId ||
      this.metadata.cdpTargetId !== this.session.sessionId ||
      !this.dependencies.isFreshBinding(this.binding)
    ) {
      throw new BrowserAuthorityError(
        "BINDING_STALE",
        "The read authority no longer belongs to this exact browser session.",
      );
    }
    if (this.dependencies.now() > this.#expiresAtMs) {
      throw new BrowserAuthorityError("AUTHORITY_EXPIRED", "Browser read authority lease expired.");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#operationActive) {
      throw new BrowserAuthorityError(
        "AUTHORITY_OPERATION_IN_PROGRESS",
        "Cannot close browser read authority while a read is in progress.",
      );
    }
    this.#closed = true;
    let restoreError: unknown = null;
    try {
      await this.session.restoreRoot(MAX_ADAPTER_TIMEOUT_MS);
    } catch (error) {
      restoreError = error;
    } finally {
      try {
        await this.session.close();
      } finally {
        if (activeProcessLeaseToken === this.processLeaseToken) activeProcessLeaseToken = null;
      }
    }
    if (restoreError !== null) {
      throw new BrowserAuthorityError(
        "ROOT_RESTORE_FAILED",
        "The read authority session closed but the exact projects root could not be restored.",
        { cause: restoreError },
      );
    }
  }

  async #readPage(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactEditorPageSnapshot> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#run(async () => {
      this.#assertReadPageTarget(exactTarget);
      return this.session.readEditorPage(exactTarget, normalizeAdapterTimeout(timeoutMs));
    });
  }

  async #readRecord(
    target: LabRecordTarget,
    kind: "standard" | "t123" | "zero_server",
    timeoutMs: number | undefined,
  ): Promise<ExactEditorRecordRead> {
    const exactTarget = exactPlainRecordTarget(target);
    return this.#run(async () => {
      this.#assertReadRecordTarget(exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      if (kind === "standard") {
        return this.session.readStandardSettings(exactTarget, boundedTimeout);
      }
      if (kind === "t123") return this.session.readT123Content(exactTarget, boundedTimeout);
      return this.session.readZeroServerRepresentation(exactTarget, boundedTimeout);
    });
  }

  async #readPageHeadCode(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactPageHeadCodeRead> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#run(async () => {
      this.#assertReadPageTarget(exactTarget);
      const read = await this.session.readPageHeadCode(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      if (
        read.target.projectId !== exactTarget.projectId ||
        read.target.pageId !== exactTarget.pageId
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current page HEAD surface does not match the exact requested page.",
        );
      }
      return Object.freeze({
        ...read,
        target: exactPlainPageTarget(read.target),
        code: assertBoundedWriteValue(read.code, "Page HEAD code"),
      });
    });
  }

  async #revealExactRecordControl(
    target: LabRecordTarget,
    controlKey: string,
    timeoutMs: number | undefined,
  ): Promise<ExactRecordHoverControlReveal> {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(controlKey)) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        "Record control key must be a bounded property identifier.",
      );
    }
    const exactTarget = exactPlainRecordTarget(target);
    return this.#run(async () => {
      this.#assertReadRecordTarget(exactTarget);
      const boundedTimeout = normalizeAdapterTimeout(timeoutMs);
      const page = await this.session.readEditorPage(exactTarget, boundedTimeout);
      const matches = page.records.filter((record) => record.recordId === exactTarget.recordId);
      if (
        page.target.projectId !== exactTarget.projectId ||
        page.target.pageId !== exactTarget.pageId ||
        matches.length !== 1
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Hover-control readback did not prove one exact record identity.",
        );
      }
      const identity = matches[0]!;
      let reveal: ExactRecordHoverControlReveal;
      try {
        reveal = await this.session.revealExactRecordControl(
          exactTarget,
          identity,
          controlKey,
          boundedTimeout,
        );
      } catch (error) {
        throwRecordControlProbeError(error);
      }
      if (
        reveal.target.projectId !== exactTarget.projectId ||
        reveal.target.pageId !== exactTarget.pageId ||
        reveal.target.recordId !== exactTarget.recordId ||
        reveal.ownerRecordId !== exactTarget.recordId ||
        reveal.controlKey !== controlKey ||
        reveal.connected !== true ||
        reveal.identity.recordId !== identity.recordId ||
        reveal.identity.recordType !== identity.recordType ||
        reveal.identity.recordCode !== identity.recordCode ||
        reveal.identity.recordCategory !== identity.recordCategory
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Hover-revealed control evidence is not owned by the exact record identity.",
        );
      }
      return Object.freeze({
        ...reveal,
        target: exactPlainRecordTarget(reveal.target),
        identity: Object.freeze({ ...reveal.identity }),
      });
    });
  }

  async #readRenderedBlockLibrary(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<RenderedBlockLibraryIndex> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#run(async () => {
      this.#assertReadPageTarget(exactTarget);
      const index = await this.session.readRenderedBlockLibrary(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      if (
        index.target.projectId !== exactTarget.projectId ||
        index.target.pageId !== exactTarget.pageId ||
        index.mutationIssued !== false ||
        index.templates.length === 0 ||
        index.templates.length > 2_000 ||
        index.categories.length > 100 ||
        index.categories.some((category) => category.trim() !== category || category.length < 1 || category.length > 128)
      ) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Rendered block-library inspection did not remain bound to the exact page.",
        );
      }
      return Object.freeze({
        target: exactPlainPageTarget(index.target),
        categories: Object.freeze([...index.categories]),
        templates: Object.freeze(index.templates.map((template) => Object.freeze({ ...template }))),
        mutationIssued: false,
      });
    });
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertFresh();
    if (this.#operationActive) {
      throw new BrowserAuthorityError(
        "CONCURRENT_ADAPTER_OPERATION",
        "Only one fixed read may use the browser authority at a time.",
      );
    }
    this.#operationActive = true;
    try {
      this.assertFresh();
      return await operation();
    } finally {
      this.#operationActive = false;
    }
  }

  #assertReadPageTarget(target: LabPageTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertRead(taskPageTarget(target));
      return;
    }
    assertClassifiedReadPageTarget(this.config, target, this.binding.inventory);
  }

  #assertReadRecordTarget(target: LabRecordTarget): void {
    if (this.taskGuard !== undefined) {
      this.taskGuard.assertRead(taskRecordTarget(target));
      return;
    }
    assertClassifiedReadPageTarget(this.config, target, this.binding.inventory);
  }
}

/**
 * Acquire one exact-root, same-connection authority lease. The dependency
 * parameter exists for deterministic unit tests; production callers omit it.
 */
export async function acquireLoopbackBrowserAuthority(
  config: ResearchConfig,
  options: AcquireLoopbackBrowserAuthorityOptions = {},
  dependencies: LoopbackBrowserAuthorityDependencies = defaultDependencies,
): Promise<LoopbackBrowserAuthority> {
  if (activeProcessLeaseToken !== null) {
    throw new BrowserAuthorityError(
      "AUTHORITY_BUSY",
      "Another process-local browser authority lease is active.",
    );
  }
  const { leaseTtlMs, taskGuard, ...captureOptions } = options;
  const processLeaseToken = Object.freeze({ id: dependencies.randomId() });
  activeProcessLeaseToken = processLeaseToken;
  let session: AuthorityOwnedLoopbackBrowserSession | null = null;
  try {
    const target = selectOnlyProjectsRootTarget(await dependencies.listTargets(config.cdpUrl));
    session = await dependencies.openSession(target);
    if (session.sessionId !== target.id || session.transport !== "loopback_cdp") {
      throw new BrowserAuthorityError(
        "BINDING_STALE",
        "Opened browser session does not belong to the selected exact root target.",
      );
    }
    const binding = await dependencies.captureBinding(config, session, captureOptions);
    if (binding.status !== "BOUND") {
      throw new BrowserAuthorityError(
        "BINDING_BLOCKED",
        `${binding.code}: ${binding.message}`,
      );
    }
    if (
      !dependencies.isFreshBinding(binding) ||
      binding.captureContext.cdpTargetId !== target.id ||
      binding.captureContext.cdpTargetId !== session.sessionId
    ) {
      throw new BrowserAuthorityError(
        "BINDING_STALE",
        "Trusted binding is not a fresh process-local capture from the selected exact root session.",
      );
    }
    assertTaskGuardBinding(taskGuard, binding);
    const authority = new LoopbackBrowserAuthorityLease(
      binding,
      config,
      session,
      processLeaseToken,
      dependencies,
      taskGuard,
      normalizeLeaseTtl(leaseTtlMs),
    );
    session = null;
    return authority;
  } catch (error) {
    if (session !== null) {
      await session.restoreRoot(MAX_ADAPTER_TIMEOUT_MS).catch(() => undefined);
      await session.close().catch(() => undefined);
    }
    if (activeProcessLeaseToken === processLeaseToken) activeProcessLeaseToken = null;
    throw error;
  }
}

/** Preferred lifecycle wrapper: exact root restoration and close are mandatory. */
export async function withLoopbackBrowserAuthority<T>(
  config: ResearchConfig,
  action: (authority: LoopbackBrowserAuthority) => Promise<T>,
  options: AcquireLoopbackBrowserAuthorityOptions = {},
  dependencies: LoopbackBrowserAuthorityDependencies = defaultDependencies,
): Promise<T> {
  const authority = await acquireLoopbackBrowserAuthority(config, options, dependencies);
  let actionError: unknown = null;
  try {
    return await action(authority);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try {
      await authority.close();
    } catch (closeError) {
      if (actionError === null) throw closeError;
    }
  }
}

export async function acquireLoopbackBrowserReadAuthority(
  config: ResearchConfig,
  options: AcquireLoopbackBrowserAuthorityOptions = {},
  dependencies: LoopbackBrowserAuthorityDependencies = defaultDependencies,
): Promise<LoopbackBrowserReadAuthority> {
  if (activeProcessLeaseToken !== null) {
    throw new BrowserAuthorityError(
      "AUTHORITY_BUSY",
      "Another process-local browser authority lease is active.",
    );
  }
  const { leaseTtlMs, taskGuard, ...captureOptions } = options;
  const processLeaseToken = Object.freeze({ id: dependencies.randomId() });
  activeProcessLeaseToken = processLeaseToken;
  let session: AuthorityOwnedLoopbackBrowserSession | null = null;
  try {
    const target = selectOnlyProjectsRootTarget(await dependencies.listTargets(config.cdpUrl));
    session = await dependencies.openSession(target);
    if (session.sessionId !== target.id || session.transport !== "loopback_cdp") {
      throw new BrowserAuthorityError(
        "BINDING_STALE",
        "Opened browser session does not belong to the selected exact root target.",
      );
    }
    const binding = await dependencies.captureBinding(config, session, captureOptions);
    if (binding.status !== "BOUND") {
      throw new BrowserAuthorityError("BINDING_BLOCKED", `${binding.code}: ${binding.message}`);
    }
    if (
      !dependencies.isFreshBinding(binding) ||
      binding.captureContext.cdpTargetId !== target.id ||
      binding.captureContext.cdpTargetId !== session.sessionId
    ) {
      throw new BrowserAuthorityError(
        "BINDING_STALE",
        "Trusted binding is not a fresh process-local capture from the selected exact root session.",
      );
    }
    assertTaskGuardBinding(taskGuard, binding);
    const authority = new LoopbackBrowserReadAuthorityLease(
      binding,
      config,
      session,
      processLeaseToken,
      dependencies,
      taskGuard,
      normalizeLeaseTtl(leaseTtlMs),
    );
    session = null;
    return authority;
  } catch (error) {
    if (session !== null) {
      await session.restoreRoot(MAX_ADAPTER_TIMEOUT_MS).catch(() => undefined);
      await session.close().catch(() => undefined);
    }
    if (activeProcessLeaseToken === processLeaseToken) activeProcessLeaseToken = null;
    throw error;
  }
}

export async function withLoopbackBrowserReadAuthority<T>(
  config: ResearchConfig,
  action: (authority: LoopbackBrowserReadAuthority) => Promise<T>,
  options: AcquireLoopbackBrowserAuthorityOptions = {},
  dependencies: LoopbackBrowserAuthorityDependencies = defaultDependencies,
): Promise<T> {
  const authority = await acquireLoopbackBrowserReadAuthority(config, options, dependencies);
  let actionError: unknown = null;
  try {
    return await action(authority);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try {
      await authority.close();
    } catch (closeError) {
      if (actionError === null) throw closeError;
    }
  }
}
