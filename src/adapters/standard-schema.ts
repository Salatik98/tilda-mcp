import { TildaEngineError } from "../core/contracts.js";
import { isSafeStandardContentField } from "../core/standard-field-safety.js";

export type StandardFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object";

export interface StandardFieldInspection {
  readonly name: string;
  readonly kind: StandardFieldKind;
  readonly writable: boolean;
  readonly evidence: "SCHEMA_DRIVEN_EXACT_STRING" | "READ_ONLY_UNPROVEN_WRITE";
}

export interface StandardRecordInspection {
  readonly recordType: string;
  readonly recordCode: string;
  readonly fields: readonly StandardFieldInspection[];
  readonly patchMechanism: "saverecord_onlythisfield" | "none";
}

export interface StandardRecordPatchPlan {
  readonly record: Record<string, unknown>;
  readonly changedPath: string;
  readonly mechanism: "saverecord_onlythisfield";
  readonly evidence: "SCHEMA_DRIVEN_EXACT_STRING";
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function fieldKind(value: unknown): StandardFieldKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value as "string" | "number" | "boolean";
  }
  return "object";
}

/**
 * Inspect every top-level record field without rebuilding the undocumented
 * record shape. Write support is advertised only for exact own string leaves.
 */
export function inspectStandardRecord(
  recordType: string,
  recordCode: string,
  value: unknown,
): StandardRecordInspection {
  const record = plainRecord(value, "Standard record");
  const hasWritableString = Object.entries(record).some(
    ([name, value]) => typeof value === "string" && isSafeStandardContentField(name),
  );
  return Object.freeze({
    recordType,
    recordCode,
    fields: Object.freeze(
      Object.keys(record).sort().map((name) => Object.freeze({
        name,
        kind: fieldKind(record[name]),
        writable: typeof record[name] === "string" && isSafeStandardContentField(name),
        evidence: typeof record[name] === "string" && isSafeStandardContentField(name)
          ? "SCHEMA_DRIVEN_EXACT_STRING"
          : "READ_ONLY_UNPROVEN_WRITE",
      })),
    ),
    patchMechanism: hasWritableString ? "saverecord_onlythisfield" : "none",
  });
}

/**
 * Plan one exact schema-discovered string field patch. structuredClone preserves all
 * unknown raw fields; a missing or stale field fails closed.
 */
export function planStandardRecordPatch(input: {
  readonly recordType: string;
  readonly recordCode: string;
  readonly record: unknown;
  readonly field: string;
  readonly expectedCurrentValue: string;
  readonly value: string;
}): StandardRecordPatchPlan {
  if (
    !/^[1-9]\d{0,31}$/u.test(input.recordType) ||
    !/^[A-Z][A-Z0-9]{1,31}$/u.test(input.recordCode) ||
    !isSafeStandardContentField(input.field)
  ) {
    throw new TildaEngineError(
      "FIELD_OUT_OF_SCOPE",
      "Standard identity or field name is not canonical.",
    );
  }
  const prior = plainRecord(input.record, "Standard record");
  if (!Object.hasOwn(prior, input.field) || typeof prior[input.field] !== "string") {
    throw new TildaEngineError(
      "INVALID_ADAPTER_STATE",
      "The proven standard field is absent or not represented as text.",
    );
  }
  if (prior[input.field] !== input.expectedCurrentValue) {
    throw new TildaEngineError("STALE_TARGET", "The standard field changed before planning.");
  }
  if (input.value === input.expectedCurrentValue) {
    throw new TildaEngineError("NO_CHANGES", "Requested standard field already matches live state.");
  }
  const next = structuredClone(prior);
  next[input.field] = input.value;
  return Object.freeze({
    record: next,
    changedPath: `record.${input.field}`,
    mechanism: "saverecord_onlythisfield",
    evidence: "SCHEMA_DRIVEN_EXACT_STRING",
  });
}
