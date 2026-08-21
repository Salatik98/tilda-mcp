import type {
  AdapterSessionFactory,
  BoundAdapterSession,
  DispatchReceipt,
  PageSettingsData,
  StandardRecordData,
  T123RecordData,
  ZeroRecordData,
} from "../adapters/session.js";
import type {
  ElementTarget,
  ExactTarget,
  PageTarget,
  RecordTarget,
} from "../core/contracts.js";
import { canonicalHash } from "../research/hash.js";
import type {
  CapabilityLearningProvider,
  CapabilityLearningSession,
  LearnCapabilityRequest,
  LearningStepEvidence,
  LearningTrace,
  LearningTransport,
} from "./contracts.js";

const ID = /^[1-9]\d*$/u;
const ELEMENT_ID = /^[A-Za-z0-9_.-]{1,160}$/u;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u;
const BASIC_ZERO_TYPES = new Set(["text", "image", "shape", "button", "html"]);
const IDENTITY_FIELDS = new Set([
  "elem_id",
  "type",
  "elem_type",
  "id",
  "uid",
  "uuid",
  "recordid",
  "pageid",
]);
const STANDARD_IDENTITY_FIELDS = new Set([
  "id",
  "tpl",
  "type",
  "recordid",
  "pageid",
  "projectid",
  "recordtype",
  "recordcode",
  "code",
]);
const STANDARD_FIELDS = ["title", "buttontitle"] as const;
const ZERO_SPECIAL_FIELDS = new Set(["left-res-480"]);
const TRACE_CHANNELS = ["dom", "runtime", "network"] as const;
const SUPPORTED_ACTIONS = new Set(["edit", "configure"]);

export class AdapterSessionLearningError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterSessionLearningError";
    this.code = code;
  }
}

interface StandardOperation {
  readonly kind: "standard";
  readonly capability: "standard.field.patch";
  readonly family: "standard";
  readonly target: RecordTarget;
  readonly targetRole: "copy" | "test-object";
}

interface T123Operation {
  readonly kind: "t123";
  readonly capability: "t123.code.replace";
  readonly family: "t123";
  readonly target: RecordTarget;
  readonly targetRole: "copy" | "test-object";
}

interface ZeroOperation {
  readonly kind: "zero";
  readonly capability: "zero.property.patch";
  readonly family: "zero";
  readonly target: ElementTarget;
  readonly targetRole: "copy" | "test-object";
}

interface PageSeoOperation {
  readonly kind: "page-seo";
  readonly capability: "page.seo.patch";
  readonly family: "page";
  readonly target: PageTarget;
  readonly targetRole: "copy" | "test-object";
}

type Operation = StandardOperation | T123Operation | ZeroOperation | PageSeoOperation;

type ReadState =
  | { readonly kind: "standard"; readonly data: StandardRecordData }
  | { readonly kind: "t123"; readonly data: T123RecordData }
  | { readonly kind: "zero"; readonly data: ZeroRecordData }
  | { readonly kind: "page-seo"; readonly data: PageSettingsData };

interface Snapshot {
  readonly kind: Operation["kind"];
  readonly hash: string;
  readonly state: ReadState;
  readonly field?: string;
  readonly changedPath: string;
  readonly marker: string;
}

function fail(code: string, message: string): never {
  throw new AdapterSessionLearningError(code, message);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("LEARNING_READ_REJECTED", `${label} is not a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("LEARNING_READ_REJECTED", `${label} is not a plain object.`);
  }
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function targetKey(target: ExactTarget): string {
  switch (target.kind) {
    case "project":
      return `project:${target.projectId}`;
    case "page":
      return `page:${target.projectId}:${target.pageId}`;
    case "record":
      return `record:${target.projectId}:${target.pageId}:${target.recordId}`;
    case "element":
      return `element:${target.projectId}:${target.pageId}:${target.recordId}:${target.elementId}`;
  }
}

function assertExactTarget(target: ExactTarget): void {
  if (!ID.test(target.projectId)) fail("LEARNING_TARGET_INVALID", "Learning target project ID is invalid.");
  if (target.kind !== "project" && !ID.test(target.pageId)) {
    fail("LEARNING_TARGET_INVALID", "Learning target page ID is invalid.");
  }
  if ((target.kind === "record" || target.kind === "element") && !ID.test(target.recordId)) {
    fail("LEARNING_TARGET_INVALID", "Learning target record ID is invalid.");
  }
  if (target.kind === "element" && !ELEMENT_ID.test(target.elementId)) {
    fail("LEARNING_TARGET_INVALID", "Learning target element ID is invalid.");
  }
}

function operationFor(request: LearnCapabilityRequest): Operation {
  assertExactTarget(request.target);
  if (request.mode !== "copy-test") {
    fail("LEARNING_MODE_BLOCKED", "The adapter-session provider only supports copy-test learning.");
  }
  if (!SUPPORTED_ACTIONS.has(request.action)) {
    fail("LEARNING_ACTION_UNSUPPORTED", "Only the bounded edit/configure learning actions are supported.");
  }
  if (request.targetRole !== "copy" && request.targetRole !== "test-object") {
    fail("LEARNING_TARGET_ROLE_INVALID", "Learning requires an exact copy or test-object target.");
  }
  if (request.dryRun) {
    fail("LEARNING_DRY_RUN_NOT_OPENED", "Dry-run learning must be handled before opening a mutation provider.");
  }

  if (request.family === "standard" && request.capability === "standard.field.patch" && request.target.kind === "record") {
    return { kind: "standard", capability: request.capability, family: request.family, target: clone(request.target), targetRole: request.targetRole };
  }
  if (request.family === "t123" && request.capability === "t123.code.replace" && request.target.kind === "record") {
    return { kind: "t123", capability: request.capability, family: request.family, target: clone(request.target), targetRole: request.targetRole };
  }
  if (request.family === "zero" && request.capability === "zero.property.patch" && request.target.kind === "element") {
    return { kind: "zero", capability: request.capability, family: request.family, target: clone(request.target), targetRole: request.targetRole };
  }
  if (request.family === "page" && request.capability === "page.seo.patch" && request.target.kind === "page") {
    return { kind: "page-seo", capability: request.capability, family: request.family, target: clone(request.target), targetRole: request.targetRole };
  }
  fail("LEARNING_CAPABILITY_UNSUPPORTED", "This family/capability/target combination has no bounded learning adapter.");
}

function markerFromHash(hash: string): string {
  return `__tilda_copy_test_${hash.slice(7, 23)}__`;
}

function traceFor(
  operation: Operation,
  phase: LearningStepEvidence["phase"],
  beforeHash: string,
  changedPath: string,
  eventCount: number,
): LearningTrace {
  const suffix = beforeHash.slice(7, 23);
  return {
    phase,
    traceId: `learn-${phase}-${suffix}`,
    channels: [...TRACE_CHANNELS],
    eventCount,
    digest: canonicalHash({
      adapter: "adapter-session-learning-v1",
      capability: operation.capability,
      phase,
      changedPath,
      eventCount,
      transport: operation.kind === "zero" ? "editor_runtime" : "authenticated_request",
    }),
  };
}

function transportFor(operation: Operation): LearningTransport {
  return operation.kind === "zero" ? "editor_runtime" : "authenticated_request";
}

function standardField(data: StandardRecordData): string {
  const record = plainRecord(data.record, "Standard record");
  const ambiguous = new Set(data.ambiguousFields ?? []);
  const knownCandidates = STANDARD_FIELDS.filter(
    (field) => Object.hasOwn(record, field) && typeof record[field] === "string" && !ambiguous.has(field),
  );
  if (knownCandidates.length === 1) return knownCandidates[0]!;
  if (knownCandidates.length > 1) {
    fail("LEARNING_STANDARD_FIELD_AMBIGUOUS", "The exact standard record has no single proven title field.");
  }
  const candidates = Object.keys(record)
    .filter((field) => SAFE_FIELD.test(field) && !STANDARD_IDENTITY_FIELDS.has(field) && !ambiguous.has(field))
    .filter((field) => typeof record[field] === "string")
    .sort();
  if (candidates.length !== 1) {
    fail("LEARNING_STANDARD_FIELD_AMBIGUOUS", "The exact standard record has no single unambiguous existing string field.");
  }
  return candidates[0]!;
}

function pageMetaIndex(data: PageSettingsData): number {
  const matches = data.fields
    .map(([name], index) => (name === "meta_descr" ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    fail("LEARNING_PAGE_SEO_AMBIGUOUS", "The exact page settings form lacks one unique meta_descr field.");
  }
  return matches[0]!;
}

function zeroElements(model: unknown): Array<{ readonly key: string; readonly element: Record<string, unknown> }> {
  const current = plainRecord(model, "Zero model");
  const result = Object.keys(current)
    .filter((key) => /^(?:0|[1-9]\d*)$/u.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => ({ key, element: plainRecord(current[key], `Zero element ${key}`) }));
  if (result.length === 0) fail("LEARNING_ZERO_ELEMENT_MISSING", "The exact Zero model has no elements.");
  return result;
}

function exactZeroElement(model: unknown, elementId: string): { readonly key: string; readonly element: Record<string, unknown> } {
  const matches = zeroElements(model).filter(({ element }) => element.elem_id === elementId);
  if (matches.length !== 1) fail("LEARNING_ZERO_ELEMENT_MISSING", "The exact Zero element is missing or duplicated.");
  return matches[0]!;
}

function zeroProperty(model: unknown, elementId: string): string {
  const element = exactZeroElement(model, elementId).element;
  const type = String(element.type ?? element.elem_type ?? "");
  if (!BASIC_ZERO_TYPES.has(type)) {
    fail("LEARNING_ZERO_TYPE_UNSUPPORTED", "The exact Zero element is not a supported basic element.");
  }
  const candidates = Object.keys(element)
    .filter((key) => (SAFE_FIELD.test(key) || ZERO_SPECIAL_FIELDS.has(key)) && !IDENTITY_FIELDS.has(key))
    .filter((key) => typeof element[key] === "string" || typeof element[key] === "number" || typeof element[key] === "boolean")
    .sort();
  if (candidates.length === 0) {
    fail("LEARNING_ZERO_PROPERTY_MISSING", "The exact Zero element has no existing writable primitive property.");
  }
  const preferred = ["text", "link", "left-res-480", "left", "top", "zindex", "title", "url", "href", "html"];
  return preferred.find((key) => candidates.includes(key)) ?? candidates[0]!;
}

function stateHash(state: ReadState): string {
  switch (state.kind) {
    case "standard":
      return canonicalHash({
        recordType: state.data.recordType,
        recordCode: state.data.recordCode,
        record: state.data.record,
      });
    case "t123":
      return canonicalHash({ code: state.data.code });
    case "zero":
      return canonicalHash(state.data.model);
    case "page-seo":
      return canonicalHash({ fields: state.data.fields, published: state.data.published });
  }
}

function withoutStandardField(record: unknown, field: string): Record<string, unknown> {
  const copy = clone(plainRecord(record, "Standard record"));
  delete copy[field];
  return copy;
}

function withoutPageMeta(fields: readonly (readonly [string, string])[]): readonly (readonly [string, string])[] {
  return fields.filter(([name]) => name !== "meta_descr");
}

function withoutZeroProperty(model: unknown, elementId: string, property: string): unknown {
  const copy = clone(plainRecord(model, "Zero model"));
  const found = exactZeroElement(copy, elementId);
  delete found.element[property];
  return copy;
}

function nextZeroValue(value: string | number | boolean, marker: string): string | number | boolean {
  if (typeof value === "string") {
    if (value.includes(marker)) fail("LEARNING_MARKER_COLLISION", "The deterministic Zero marker already exists in the selected value.");
    return `${value}${marker}`;
  }
  if (typeof value === "boolean") return !value;
  const delta = (Number.parseInt(marker.slice(-7, -5), 16) % 9) + 1;
  const next = value + delta;
  if (!Number.isFinite(next)) fail("LEARNING_ZERO_VALUE_UNSAFE", "The deterministic Zero numeric marker is not finite.");
  return next;
}

function acknowledged(receipt: DispatchReceipt): void {
  if (!receipt.requestDispatched || receipt.acknowledgement !== "acknowledged" || receipt.publishObserved) {
    fail("LEARNING_WRITE_UNACKNOWLEDGED", "The fixed adapter write was not acknowledged; no retry is allowed.");
  }
}

function sameIdentity(before: StandardRecordData, after: StandardRecordData): void {
  if (before.recordType !== after.recordType || before.recordCode !== after.recordCode) {
    fail("LEARNING_IDENTITY_CHANGED", "The standard record identity changed during copy-test learning.");
  }
}

function changedPathFor(operation: Operation, field?: string): string {
  switch (operation.kind) {
    case "standard":
      return `record.${field ?? "field"}`;
    case "t123":
      return "record.code";
    case "zero":
      return `${operation.target.elementId}.${field ?? "property"}`;
    case "page-seo":
      return "page.meta_descr";
  }
}

class AdapterSessionLearningSession implements CapabilityLearningSession {
  readonly adapterId = "adapter-session-learning-v1";
  readonly transport: LearningTransport;
  #before: Snapshot | undefined;
  #after: Snapshot | undefined;
  #intendedHash: string | undefined;
  #usedBefore = false;
  #usedAfter = false;
  #usedReplay = false;
  #usedRestore = false;

  constructor(
    readonly sessions: AdapterSessionFactory,
    readonly operation: Operation,
  ) {
    this.transport = transportFor(operation);
  }

  async captureBefore(): Promise<LearningStepEvidence> {
    if (this.#usedBefore) fail("LEARNING_PHASE_REUSED", "The before phase can run only once.");
    this.#usedBefore = true;
    const state = await this.#read();
    const field = this.#fieldFor(state);
    const snapshot = this.#snapshot(state, field);
    this.#before = snapshot;
    return this.#evidence("before", snapshot, [], 1);
  }

  async performTestAction(): Promise<LearningStepEvidence> {
    if (this.#usedAfter) fail("LEARNING_PHASE_REUSED", "The test action can run only once.");
    this.#usedAfter = true;
    const before = this.#requireBefore();
    const current = await this.#readSnapshot(before.field);
    if (current.hash !== before.hash) fail("LEARNING_STALE_BASELINE", "The exact copy-test object changed before the test mutation.");
    const after = await this.#applyFromCurrent(current, before.marker);
    this.#after = after;
    return this.#evidence("after", after, [after.changedPath], 3);
  }

  async replayRecipe(): Promise<LearningStepEvidence> {
    if (this.#usedReplay) fail("LEARNING_PHASE_REUSED", "The replay phase can run only once.");
    this.#usedReplay = true;
    const before = this.#requireBefore();
    const after = this.#after;
    if (after === undefined) fail("LEARNING_REPLAY_UNAVAILABLE", "Replay requires a completed bounded test mutation.");
    await this.#restoreToBaseline(after.hash);
    const current = await this.#readSnapshot(before.field);
    if (current.hash !== before.hash) fail("LEARNING_REPLAY_BASELINE_MISMATCH", "Replay could not reread the exact baseline.");
    const replay = await this.#applyFromCurrent(current, before.marker);
    if (replay.hash !== after.hash || replay.changedPath !== after.changedPath) {
      fail("LEARNING_REPLAY_MISMATCH", "The fixed replay did not reproduce the exact semantic delta.");
    }
    return this.#evidence("replay", replay, [replay.changedPath], 5);
  }

  async restoreBaseline(): Promise<LearningStepEvidence> {
    if (this.#usedRestore) fail("LEARNING_PHASE_REUSED", "The restore phase can run only once.");
    this.#usedRestore = true;
    const before = this.#requireBefore();
    const current = await this.#readSnapshot(before.field);
    if (current.hash !== before.hash) {
      if (this.#intendedHash === undefined || current.hash !== this.#intendedHash) {
        fail("LEARNING_RESTORE_GUARD", "The current exact target is neither the known test state nor the baseline; restore is blocked.");
      }
      await this.#write(before);
      const restored = await this.#readSnapshot(before.field);
      if (restored.hash !== before.hash) fail("LEARNING_RESTORE_MISMATCH", "The exact baseline hash was not restored.");
      return this.#evidence("restore", restored, [], 3);
    }
    return this.#evidence("restore", current, [], 1);
  }

  async #read(): Promise<ReadState> {
    return this.sessions.withSession(async (session) => {
      switch (this.operation.kind) {
        case "standard":
          return { kind: "standard" as const, data: clone(await session.readStandard(this.operation.target)) };
        case "t123":
          return { kind: "t123" as const, data: clone(await session.readT123(this.operation.target)) };
        case "zero":
          return { kind: "zero" as const, data: clone(await session.readZero(this.operation.target)) };
        case "page-seo":
          return { kind: "page-seo" as const, data: clone(await session.readPageSettings(this.operation.target)) };
      }
    });
  }

  async #readSnapshot(field?: string): Promise<Snapshot> {
    const state = await this.#read();
    return this.#snapshot(state, field ?? this.#fieldFor(state));
  }

  #fieldFor(state: ReadState): string | undefined {
    if (state.kind === "standard") return standardField(state.data);
    if (state.kind === "zero") return zeroProperty(state.data.model, this.operation.kind === "zero" ? this.operation.target.elementId : "");
    if (state.kind === "page-seo") {
      pageMetaIndex(state.data);
      return "meta_descr";
    }
    return undefined;
  }

  #snapshot(state: ReadState, field?: string): Snapshot {
    const changedPath = changedPathFor(this.operation, field);
    const marker = markerFromHash(stateHash(state));
    return {
      kind: this.operation.kind,
      hash: stateHash(state),
      state,
      ...(field === undefined ? {} : { field }),
      changedPath,
      marker,
    };
  }

  #requireBefore(): Snapshot {
    if (this.#before === undefined) fail("LEARNING_BEFORE_REQUIRED", "The before state must be captured first.");
    return this.#before;
  }

  async #applyFromCurrent(current: Snapshot, marker: string): Promise<Snapshot> {
    const before = this.#requireBefore();
    const intended = this.#intendedSnapshot(current, marker);
    this.#intendedHash = intended.hash;
    await this.#write(intended);
    const after = await this.#readSnapshot(before.field);
    this.#assertExpectedDelta(current, after, intended);
    return after;
  }

  #intendedSnapshot(current: Snapshot, marker: string): Snapshot {
    switch (this.operation.kind) {
      case "standard": {
        const data = current.state.kind === "standard" ? current.state.data : fail("LEARNING_STATE_KIND", "Standard state mismatch.");
        const field = current.field ?? standardField(data);
        const record = plainRecord(data.record, "Standard record");
        const prior = record[field];
        if (typeof prior !== "string") fail("LEARNING_STANDARD_FIELD_MISSING", "The selected standard field is not a string.");
        if (prior.includes(marker)) fail("LEARNING_MARKER_COLLISION", "The deterministic standard marker already exists in the selected value.");
        const next = clone(data);
        const nextRecord = plainRecord(next.record, "Standard record");
        nextRecord[field] = `${prior}${marker}`;
        const state: ReadState = { kind: "standard", data: next };
        return { kind: this.operation.kind, hash: stateHash(state), state, field, changedPath: changedPathFor(this.operation, field), marker };
      }
      case "t123": {
        const data = current.state.kind === "t123" ? current.state.data : fail("LEARNING_STATE_KIND", "T123 state mismatch.");
        if (data.code.includes(marker)) fail("LEARNING_MARKER_COLLISION", "The deterministic T123 marker already exists in the code.");
        const next: T123RecordData = { ...clone(data), code: `${data.code}\n<!-- tilda-copy-test:${marker} -->` };
        const state: ReadState = { kind: "t123", data: next };
        return { kind: this.operation.kind, hash: stateHash(state), state, changedPath: changedPathFor(this.operation), marker };
      }
      case "zero": {
        const data = current.state.kind === "zero" ? current.state.data : fail("LEARNING_STATE_KIND", "Zero state mismatch.");
        const field = current.field ?? zeroProperty(data.model, this.operation.target.elementId);
        const next = clone(data);
        const found = exactZeroElement(next.model, this.operation.target.elementId);
        const value = found.element[field];
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          fail("LEARNING_ZERO_PROPERTY_UNSUPPORTED", "The selected Zero property is not a supported primitive.");
        }
        found.element[field] = nextZeroValue(value, marker);
        const state: ReadState = { kind: "zero", data: next };
        return { kind: this.operation.kind, hash: stateHash(state), state, field, changedPath: changedPathFor(this.operation, field), marker };
      }
      case "page-seo": {
        const data = current.state.kind === "page-seo" ? current.state.data : fail("LEARNING_STATE_KIND", "Page settings state mismatch.");
        const index = pageMetaIndex(data);
        const value = data.fields[index]![1];
        if (value.includes(marker)) fail("LEARNING_MARKER_COLLISION", "The deterministic SEO marker already exists in meta_descr.");
        const fields = data.fields.map((entry, entryIndex) =>
          entryIndex === index ? ([entry[0], `${value}${marker}`] as const) : ([entry[0], entry[1]] as const),
        );
        const next: PageSettingsData = { ...clone(data), fields };
        const state: ReadState = { kind: "page-seo", data: next };
        return { kind: this.operation.kind, hash: stateHash(state), state, field: "meta_descr", changedPath: changedPathFor(this.operation), marker };
      }
    }
  }

  async #write(snapshot: Snapshot): Promise<void> {
    await this.sessions.withSession(async (session: BoundAdapterSession) => {
      switch (this.operation.kind) {
        case "standard": {
          if (snapshot.state.kind !== "standard" || snapshot.field === undefined) fail("LEARNING_STATE_KIND", "Standard write state mismatch.");
          const record = plainRecord(snapshot.state.data.record, "Standard record");
          const value = record[snapshot.field];
          if (typeof value !== "string") fail("LEARNING_STANDARD_FIELD_MISSING", "The selected standard field is not a string.");
          acknowledged(await session.writeStandard(this.operation.target, snapshot.field, value));
          return;
        }
        case "t123":
          if (snapshot.state.kind !== "t123") fail("LEARNING_STATE_KIND", "T123 write state mismatch.");
          acknowledged(await session.writeT123(this.operation.target, snapshot.state.data.code));
          return;
        case "zero":
          if (snapshot.state.kind !== "zero") fail("LEARNING_STATE_KIND", "Zero write state mismatch.");
          acknowledged(await session.writeZero(this.operation.target, snapshot.state.data.model));
          return;
        case "page-seo":
          if (snapshot.state.kind !== "page-seo") fail("LEARNING_STATE_KIND", "Page settings write state mismatch.");
          acknowledged(await session.writePageSettings(this.operation.target, snapshot.state.data.fields));
          return;
      }
    });
  }

  async #restoreToBaseline(expectedHash: string): Promise<void> {
    const before = this.#requireBefore();
    const current = await this.#readSnapshot(before.field);
    if (current.hash !== expectedHash) fail("LEARNING_RESTORE_GUARD", "Replay restore did not start from the known test state.");
    await this.#write(before);
    const restored = await this.#readSnapshot(before.field);
    if (restored.hash !== before.hash) fail("LEARNING_RESTORE_MISMATCH", "Replay could not restore the exact baseline before applying once.");
  }

  #assertExpectedDelta(current: Snapshot, after: Snapshot, intended: Snapshot): void {
    if (after.hash !== intended.hash || after.changedPath !== intended.changedPath) {
      fail("LEARNING_READBACK_MISMATCH", "The fixed adapter reread did not match the intended bounded state.");
    }
    switch (this.operation.kind) {
      case "standard": {
        if (current.state.kind !== "standard" || after.state.kind !== "standard" || current.field === undefined) fail("LEARNING_STATE_KIND", "Standard readback state mismatch.");
        sameIdentity(current.state.data, after.state.data);
        if (canonicalHash(withoutStandardField(current.state.data.record, current.field)) !== canonicalHash(withoutStandardField(after.state.data.record, current.field))) {
          fail("LEARNING_DELTA_TOO_WIDE", "The standard copy-test changed an unrequested field.");
        }
        const beforeValue = plainRecord(current.state.data.record, "Standard record")[current.field];
        const afterValue = plainRecord(after.state.data.record, "Standard record")[current.field];
        if (beforeValue === afterValue) fail("LEARNING_NO_MUTATION", "The standard copy-test did not change its selected field.");
        return;
      }
      case "t123":
        if (current.state.kind !== "t123" || after.state.kind !== "t123" || after.state.data.code === current.state.data.code || !after.state.data.code.includes(intended.marker)) {
          fail("LEARNING_T123_READBACK", "The T123 copy-test did not produce the expected inert marker delta.");
        }
        return;
      case "zero": {
        if (current.state.kind !== "zero" || after.state.kind !== "zero" || current.field === undefined) fail("LEARNING_STATE_KIND", "Zero readback state mismatch.");
        if (canonicalHash(withoutZeroProperty(current.state.data.model, this.operation.target.elementId, current.field)) !== canonicalHash(withoutZeroProperty(after.state.data.model, this.operation.target.elementId, current.field))) {
          fail("LEARNING_DELTA_TOO_WIDE", "The Zero copy-test changed more than one existing element property.");
        }
        const beforeValue = exactZeroElement(current.state.data.model, this.operation.target.elementId).element[current.field];
        const afterValue = exactZeroElement(after.state.data.model, this.operation.target.elementId).element[current.field];
        if (beforeValue === afterValue) fail("LEARNING_NO_MUTATION", "The Zero copy-test did not change its selected property.");
        return;
      }
      case "page-seo":
        if (current.state.kind !== "page-seo" || after.state.kind !== "page-seo") fail("LEARNING_STATE_KIND", "Page settings readback state mismatch.");
        if (canonicalHash(withoutPageMeta(current.state.data.fields)) !== canonicalHash(withoutPageMeta(after.state.data.fields))) {
          fail("LEARNING_DELTA_TOO_WIDE", "The SEO copy-test changed a page setting other than meta_descr.");
        }
        if (current.state.data.fields[pageMetaIndex(current.state.data)]![1] === after.state.data.fields[pageMetaIndex(after.state.data)]![1]) {
          fail("LEARNING_NO_MUTATION", "The SEO copy-test did not change meta_descr.");
        }
        return;
    }
  }

  #evidence(
    phase: LearningStepEvidence["phase"],
    snapshot: Snapshot,
    changedPaths: readonly string[],
    eventCount: number,
  ): LearningStepEvidence {
    const target = this.operation.target;
    return {
      phase,
      target: clone(target),
      targetRole: this.operation.targetRole,
      stateHash: snapshot.hash,
      changedPaths: [...changedPaths],
      trace: traceFor(this.operation, phase, this.#requireBefore().hash, snapshot.changedPath, eventCount),
    };
  }
}

export interface AdapterSessionLearningProviderOptions {
  readonly sessions: AdapterSessionFactory;
}

/**
 * Bounded copy-test provider backed only by the already-typed adapter session
 * seam. It intentionally has no browser, URL, JavaScript, selector, or raw
 * trace input. Every read and write acquires a fresh adapter session. Non-dry
 * callers must enter through CapabilityLearningWorkflow, which holds the
 * durable execution claim and one managed task-execution pin across all four
 * phases; this provider deliberately cannot mint or replace task authority.
 */
export class AdapterSessionCapabilityLearningProvider implements CapabilityLearningProvider {
  readonly #sessions: AdapterSessionFactory;

  constructor(options: AdapterSessionLearningProviderOptions) {
    this.#sessions = options.sessions;
  }

  async open(request: LearnCapabilityRequest): Promise<CapabilityLearningSession> {
    const operation = operationFor(request);
    return new AdapterSessionLearningSession(this.#sessions, operation);
  }
}

export function capabilityLearningTargetKey(target: ExactTarget): string {
  return targetKey(target);
}
