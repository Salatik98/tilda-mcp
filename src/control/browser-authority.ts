import { randomUUID } from "node:crypto";

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
  type ExactPageHeadCodeRead,
  type ExactPageSettingsRead,
  type FixedBrowserDispatchResult,
  type FixedPageLifecycleResult,
  type FixedZeroWritePreflightResult,
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
  | "ROOT_RESTORE_FAILED";

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
  ): Promise<ExactEditorRecordRead>;
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

function assertSupportedZeroTransition(
  current: Record<string, unknown>,
  intendedValue: unknown,
): Record<string, unknown> {
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
  let accepted = false;
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
      accepted =
        (changedKeys.length === 1 &&
          changedKeys[0] === "link" &&
          type(change.before) === "text" &&
          (typeof change.after.link === "string" ||
            (typeof change.before.link === "string" && !Object.hasOwn(change.after, "link")))) ||
        (changedKeys.length === 1 &&
          changedKeys[0] === "left-res-480" &&
          type(change.before) === "shape" &&
          typeof change.after["left-res-480"] === "number" &&
          Number.isFinite(change.after["left-res-480"]));
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
              type(element) === "shape" &&
              jsonEqual(stripCloneFields(element), stripCloneFields(clone)),
          );
        accepted =
          addedKey === expectedKey &&
          allCommonValuesEqual(before, after, currentParts.keys) &&
          type(clone) === "shape" &&
          ZERO_ELEMENT_ID.test(id(clone)) &&
          !currentParts.ids.has(id(clone)) &&
          sources.length === 1 &&
          runtimeGeometryIsFinite(clone);
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
              type(element) === "shape" &&
              jsonEqual(stripCloneFields(element), stripCloneFields(removed)),
          );
        accepted =
          removedKey === expectedKey &&
          allCommonValuesEqual(after, before, intendedParts.keys) &&
          type(removed) === "shape" &&
          ZERO_ELEMENT_ID.test(id(removed)) &&
          !intendedParts.ids.has(id(removed)) &&
          sources.length === 1 &&
          runtimeGeometryIsFinite(removed);
      }
    }
  }
  if (!accepted) {
    throw new BrowserAuthorityError(
      "WRITE_IDENTITY_REJECTED",
      "Zero write must be exactly one reproduced text link, shape left-res-480, appended shape clone, or its strict inverse removal.",
    );
  }
  return after;
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
    leaseTtlMs: number,
  ) {
    const acquiredAtMs = dependencies.now();
    const bindingExpiry = Date.parse(binding.captureContext.expiresAt ?? "");
    this.#expiresAtMs = Math.min(
      acquiredAtMs + leaseTtlMs,
      Number.isFinite(bindingExpiry) ? bindingExpiry : acquiredAtMs,
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
      readZeroModel: (target: LabRecordTarget, timeoutMs?: number) =>
        this.#readRecord(target, "zero", timeoutMs),
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
      ) => this.#writeZeroModel(target, intendedCleanElementsData, timeoutMs),
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
    });
  }

  assertFresh(): void {
    if (this.#closed) {
      throw new BrowserAuthorityError("AUTHORITY_CLOSED", "Browser authority lease is closed.");
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
      try {
        assertLabPageTarget(this.config, exactTarget, this.binding.inventory);
      } catch (error) {
        throw new BrowserAuthorityError(
          "TARGET_REJECTED",
          error instanceof Error ? error.message : "Page target guard rejected the operation.",
          { cause: error },
        );
      }
      return this.session.readEditorPage(exactTarget, normalizeAdapterTimeout(timeoutMs));
    });
  }

  async #readRecord(
    target: LabRecordTarget,
    kind: "standard" | "t123" | "zero",
    timeoutMs: number | undefined,
  ): Promise<ExactEditorRecordRead> {
    return this.#runAdapterOperation(async () => {
      let exactTarget: LabRecordTarget;
      try {
        exactTarget = assertLabRecordTarget(this.config, target, this.binding.inventory);
      } catch (error) {
        throw new BrowserAuthorityError(
          "TARGET_REJECTED",
          error instanceof Error ? error.message : "Record target guard rejected the operation.",
          { cause: error },
        );
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

  async #writeStandard(
    target: LabRecordTarget,
    field: StandardWritableField,
    value: string,
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    if (field !== "title" && field !== "buttontitle") {
      throw new BrowserAuthorityError(
        "WRITE_IDENTITY_REJECTED",
        "Standard write supports only title or buttontitle.",
      );
    }
    const boundedValue = assertBoundedWriteValue(value, "Standard field value");
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      const exactTarget = this.#guardRecordTarget(target);
      const page = await this.session.readEditorPage(
        exactTarget,
        normalizeAdapterTimeout(timeoutMs),
      );
      const identity = this.#exactRecordIdentity(page, exactTarget);
      const identityAllowed =
        (field === "title" &&
          identity.recordType === "128" &&
          identity.recordCode === "TL04") ||
        (field === "buttontitle" &&
          identity.recordType === "778" &&
          identity.recordCode === "ST310N");
      if (!identityAllowed) {
        throw new BrowserAuthorityError(
          "WRITE_IDENTITY_REJECTED",
          "Current record identity is not proved for the requested standard field contract.",
        );
      }
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      const result = await this.session.writeStandard(
        exactTarget,
        field,
        boundedValue,
        normalizeAdapterTimeout(timeoutMs),
      );
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
      const exactTarget = this.#guardRecordTarget(target);
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
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      const result = await this.session.writeT123(
        exactTarget,
        boundedCode,
        normalizeAdapterTimeout(timeoutMs),
      );
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #preflightZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number | undefined,
  ): Promise<FixedZeroWritePreflightResult> {
    return this.#runAdapterOperation(async () => {
      const exactTarget = this.#guardRecordTarget(target);
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
      const intended = assertSupportedZeroTransition(current, intendedCleanElementsData);
      this.assertFresh();
      return this.session.preflightZeroModel(exactTarget, intended, boundedTimeout);
    });
  }

  async #writeZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number | undefined,
  ): Promise<FixedDispatchReceipt> {
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      const exactTarget = this.#guardRecordTarget(target);
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
      const intended = assertSupportedZeroTransition(current, intendedCleanElementsData);
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      const result = await this.session.writeZeroModel(
        exactTarget,
        intended,
        boundedTimeout,
      );
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #readPageSettings(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactPageSettingsRead> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#guardPageTarget(exactTarget);
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
      this.#guardPageTarget(exactTarget);
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
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      const result = await this.session.writePageSettings(
        exactTarget,
        intended,
        boundedTimeout,
      );
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #readPageHeadCode(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<ExactPageHeadCodeRead> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#guardPageTarget(exactTarget);
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
      this.#guardPageTarget(exactTarget);
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
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      const result = await this.session.writePageHeadCode(
        exactTarget,
        boundedCode,
        boundedExpectedCode,
        boundedTimeout,
      );
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
      this.#guardPageTarget(exactTarget);
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
      this.assertFresh();
      const operationId = this.#consumeMutationSlot();
      const result = action === "publish"
        ? await this.session.publishPage(exactTarget, boundedTimeout)
        : await this.session.unpublishPage(exactTarget, boundedTimeout);
      return this.#dispatchReceipt(operationId, result);
    });
  }

  async #runFixedPageLifecycle(
    target: LabPageTarget,
    timeoutMs: number | undefined,
  ): Promise<FixedPageLifecycleResult> {
    const exactTarget = exactPlainPageTarget(target);
    return this.#runAdapterOperation(async () => {
      this.#assertMutationSlotAvailable();
      this.#guardPageTarget(exactTarget);
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
      this.assertFresh();
      this.#consumeMutationSlot();
      return this.session.runFixedPageLifecycle(exactTarget, boundedTimeout);
    });
  }

  #guardPageTarget(target: LabPageTarget): void {
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

  #guardRecordTarget(target: LabRecordTarget): LabRecordTarget {
    try {
      return assertLabRecordTarget(this.config, target, this.binding.inventory);
    } catch (error) {
      throw new BrowserAuthorityError(
        "TARGET_REJECTED",
        error instanceof Error ? error.message : "Record target guard rejected the operation.",
        { cause: error },
      );
    }
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
    leaseTtlMs: number,
  ) {
    const acquiredAtMs = dependencies.now();
    const bindingExpiry = Date.parse(binding.captureContext.expiresAt ?? "");
    this.#expiresAtMs = Math.min(
      acquiredAtMs + leaseTtlMs,
      Number.isFinite(bindingExpiry) ? bindingExpiry : acquiredAtMs,
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
      assertClassifiedReadPageTarget(this.config, exactTarget, this.binding.inventory);
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
      assertClassifiedReadPageTarget(this.config, exactTarget, this.binding.inventory);
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
      assertClassifiedReadPageTarget(this.config, exactTarget, this.binding.inventory);
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
    const binding = await dependencies.captureBinding(config, session, options);
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
    const authority = new LoopbackBrowserAuthorityLease(
      binding,
      config,
      session,
      processLeaseToken,
      dependencies,
      normalizeLeaseTtl(options.leaseTtlMs),
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
    const binding = await dependencies.captureBinding(config, session, options);
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
    const authority = new LoopbackBrowserReadAuthorityLease(
      binding,
      config,
      session,
      processLeaseToken,
      dependencies,
      normalizeLeaseTtl(options.leaseTtlMs),
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
