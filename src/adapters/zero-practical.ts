import { TildaEngineError } from "../core/contracts.js";
import { canonicalHash } from "../research/hash.js";

const ELEMENT_KEY = /^(?:0|[1-9]\d*)$/u;
const ELEMENT_ID = /^[1-9]\d*$/u;
const admittedReceipts = new WeakSet<object>();

export interface CreatedZeroShapeReceipt {
  readonly recordId: string;
  readonly elementId: string;
  readonly sourceElementId: string;
  readonly admittedAfterHash: string;
  readonly evidence: "LIVE_READBACK_EXACT_SHAPE_CLONE";
}
export interface ZeroModelPlan {
  readonly model: Record<string, unknown>;
  readonly changedPaths: readonly string[];
  readonly evidence:
    | "LIVE_REPRODUCED"
    | "DERIVED_EXACT_CREATED_SHAPE_REQUIRES_ONE_BOUNDED_COPY_ACCEPTANCE";
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function model(value: unknown): Record<string, unknown> {
  const current = object(value, "Zero clean model");
  if (!["groups", "meta", "timestamp"].every((key) => Object.hasOwn(current, key))) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Zero clean model metadata is incomplete.");
  }
  const keys = Object.keys(current).filter((key) => ELEMENT_KEY.test(key));
  if (keys.length === 0) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Zero clean model has no elements.");
  }
  const ids = new Set<string>();
  for (const key of keys) {
    const element = object(current[key], `Zero element ${key}`);
    if (typeof element.elem_id !== "string" || !ELEMENT_ID.test(element.elem_id) || ids.has(element.elem_id)) {
      throw new TildaEngineError("INVALID_ADAPTER_STATE", "Zero element identity is invalid.");
    }
    ids.add(element.elem_id);
  }
  return current;
}

function elements(value: unknown): Array<{ readonly key: string; readonly value: Record<string, unknown> }> {
  const current = model(value);
  return Object.keys(current)
    .filter((key) => ELEMENT_KEY.test(key))
    .map((key) => ({ key, value: object(current[key], `Zero element ${key}`) }));
}

function exactElement(value: unknown, elementId: string) {
  const matches = elements(value).filter(({ value: element }) => element.elem_id === elementId);
  if (matches.length !== 1) {
    throw new TildaEngineError("ELEMENT_IDENTITY_MISMATCH", "Exact Zero element is missing or duplicated.");
  }
  return matches[0]!;
}

function typeOf(element: Record<string, unknown>): unknown {
  return element.type ?? element.elem_type;
}

function numeric(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TildaEngineError("ZERO_GEOMETRY_INVALID", `${field} must be numeric.`);
  }
  return parsed;
}

function preserveRepresentation(original: unknown, value: number): string | number {
  return typeof original === "string" ? String(value) : value;
}

function assertReceipt(receipt: CreatedZeroShapeReceipt, recordId: string): void {
  if (!admittedReceipts.has(receipt) || receipt.recordId !== recordId) {
    throw new TildaEngineError(
      "CREATED_TARGET_RECEIPT_REJECTED",
      "Created Zero element receipt is not an admitted same-process exact readback.",
    );
  }
}

/** Existing-element writes remain limited to the two exact EXP-12/14 leaves. */
export function planProvenZeroLeafPatch(input: {
  readonly model: unknown;
  readonly elementId: string;
  readonly path: "link" | "left-res-480";
  readonly expectedCurrentValue: string | number;
  readonly value: string | number;
}): ZeroModelPlan {
  const next = structuredClone(model(input.model));
  const element = exactElement(next, input.elementId).value;
  const valid =
    (typeOf(element) === "text" && input.path === "link" && typeof input.value === "string") ||
    (typeOf(element) === "shape" && input.path === "left-res-480" && typeof input.value === "number");
  if (!valid) {
    throw new TildaEngineError("FIELD_OUT_OF_SCOPE", "Zero family/path pair lacks live write evidence.");
  }
  if (element[input.path] !== input.expectedCurrentValue) {
    throw new TildaEngineError("STALE_TARGET", "Zero leaf changed before planning.");
  }
  if (input.value === input.expectedCurrentValue) {
    throw new TildaEngineError("NO_CHANGES", "Requested Zero leaf already matches live state.");
  }
  element[input.path] = input.value;
  return Object.freeze({
    model: next,
    changedPaths: Object.freeze([`${input.elementId}.${input.path}`]),
    evidence: "LIVE_REPRODUCED",
  });
}

/**
 * Admit a clone only after reread proves EXP-13's exact delta: one new shape,
 * no original/non-element change, and clone-only identity/geometry/z changes.
 */
export function admitExactShapeClone(input: {
  readonly recordId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly sourceElementId: string;
}): CreatedZeroShapeReceipt {
  if (!ELEMENT_ID.test(input.recordId)) {
    throw new TildaEngineError("CREATED_TARGET_RECEIPT_REJECTED", "Record identity is invalid.");
  }
  const before = model(input.before);
  const after = model(input.after);
  const beforeElements = elements(before);
  const afterElements = elements(after);
  const beforeIds = new Set(beforeElements.map(({ value }) => String(value.elem_id)));
  const added = afterElements.filter(({ value }) => !beforeIds.has(String(value.elem_id)));
  if (added.length !== 1 || afterElements.length !== beforeElements.length + 1) {
    throw new TildaEngineError("CREATED_TARGET_RECEIPT_REJECTED", "Readback did not add exactly one element.");
  }
  const source = exactElement(before, input.sourceElementId).value;
  const clone = added[0]!.value;
  if (typeOf(source) !== "shape" || typeOf(clone) !== "shape") {
    throw new TildaEngineError("CREATED_TARGET_RECEIPT_REJECTED", "Exact clone receipt supports shapes only.");
  }
  for (const { value } of beforeElements) {
    const readback = exactElement(after, String(value.elem_id)).value;
    if (canonicalHash(readback) !== canonicalHash(value)) {
      throw new TildaEngineError("CREATED_TARGET_RECEIPT_REJECTED", "An original Zero element changed.");
    }
  }
  const beforeMeta = structuredClone(before);
  const afterMeta = structuredClone(after);
  for (const { key } of beforeElements) delete beforeMeta[key];
  for (const { key } of afterElements) delete afterMeta[key];
  if (canonicalHash(beforeMeta) !== canonicalHash(afterMeta)) {
    throw new TildaEngineError("CREATED_TARGET_RECEIPT_REJECTED", "Zero metadata changed during clone.");
  }
  const normalizedSource = { ...source };
  const normalizedClone = { ...clone };
  for (const key of ["elem_id", "left", "top", "zindex"]) {
    delete normalizedSource[key];
    delete normalizedClone[key];
  }
  if (canonicalHash(normalizedSource) !== canonicalHash(normalizedClone)) {
    throw new TildaEngineError("CREATED_TARGET_RECEIPT_REJECTED", "Clone changed non-geometry fields.");
  }
  const receipt = Object.freeze({
    recordId: input.recordId,
    elementId: String(clone.elem_id),
    sourceElementId: input.sourceElementId,
    admittedAfterHash: canonicalHash(after),
    evidence: "LIVE_READBACK_EXACT_SHAPE_CLONE" as const,
  });
  admittedReceipts.add(receipt);
  return receipt;
}

export function planCreatedShapeMove(input: {
  readonly recordId: string;
  readonly model: unknown;
  readonly receipt: CreatedZeroShapeReceipt;
  readonly expectedElementHash: string;
  readonly delta: { readonly left: number; readonly top: number };
}): ZeroModelPlan {
  assertReceipt(input.receipt, input.recordId);
  const next = structuredClone(model(input.model));
  const element = exactElement(next, input.receipt.elementId).value;
  if (typeOf(element) !== "shape" || canonicalHash(element) !== input.expectedElementHash) {
    throw new TildaEngineError("STALE_TARGET", "Created shape changed before move planning.");
  }
  element.left = preserveRepresentation(element.left, numeric(element.left, "left") + input.delta.left);
  element.top = preserveRepresentation(element.top, numeric(element.top, "top") + input.delta.top);
  return Object.freeze({
    model: next,
    changedPaths: Object.freeze([
      `${input.receipt.elementId}.left`,
      `${input.receipt.elementId}.top`,
    ]),
    evidence: "DERIVED_EXACT_CREATED_SHAPE_REQUIRES_ONE_BOUNDED_COPY_ACCEPTANCE",
  });
}

export function planCreatedShapeDelete(input: {
  readonly recordId: string;
  readonly model: unknown;
  readonly receipt: CreatedZeroShapeReceipt;
  readonly expectedElementHash: string;
}): ZeroModelPlan {
  assertReceipt(input.receipt, input.recordId);
  const next = structuredClone(model(input.model));
  const found = exactElement(next, input.receipt.elementId);
  if (canonicalHash(found.value) !== input.expectedElementHash) {
    throw new TildaEngineError("STALE_TARGET", "Created shape changed before cleanup planning.");
  }
  delete next[found.key];
  return Object.freeze({
    model: next,
    changedPaths: Object.freeze([`elements.-${input.receipt.elementId}`]),
    evidence: "LIVE_REPRODUCED",
  });
}
