import { canonicalHash } from "../research/hash.js";
import type { AdapterState } from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";

export function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new TildaEngineError("UNCLONEABLE_STATE", "Adapter state is not safely cloneable.");
  }
}

export function state(payload: unknown, summary: string, revision?: string): AdapterState {
  return {
    hash: canonicalHash(payload),
    payload,
    summary,
    ...(revision === undefined ? {} : { revision }),
  };
}

export function assertPlainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} has an unsafe prototype.`);
  }
  return value as Record<string, unknown>;
}

export function exactReceipt(receipt: { requestDispatched: boolean; acknowledgement: string }): void {
  if (!receipt.requestDispatched || receipt.acknowledgement !== "acknowledged") {
    throw new TildaEngineError(
      "WRITE_ACKNOWLEDGEMENT_MISSING",
      "The adapter did not receive an exact write acknowledgement; no retry is allowed.",
    );
  }
}
