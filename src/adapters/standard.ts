import type {
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ExactTarget,
  PlannedMutation,
  StandardFieldPatch,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import { isSafeStandardContentField } from "../core/standard-field-safety.js";
import type { AdapterSessionFactory, StandardRecordData } from "./session.js";
import { assertPlainRecord, cloneJson, exactReceipt, state } from "./helpers.js";

interface StandardPayload {
  record: Record<string, unknown>;
  recordType: string;
  recordCode: string;
  ambiguousFields: readonly string[];
}

function payloadOf(adapterState: AdapterState): StandardPayload {
  const payload = assertPlainRecord(adapterState.payload, "standard payload");
  const record = assertPlainRecord(payload.record, "standard record");
  if (typeof payload.recordType !== "string" || typeof payload.recordCode !== "string") {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Standard identity is missing.");
  }
  if (
    !Array.isArray(payload.ambiguousFields) ||
    payload.ambiguousFields.some((field) => typeof field !== "string")
  ) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Standard ambiguity metadata is invalid.");
  }
  return {
    record,
    recordType: payload.recordType,
    recordCode: payload.recordCode,
    ambiguousFields: [...payload.ambiguousFields] as string[],
  };
}

function toState(data: StandardRecordData): AdapterState {
  return state(
    {
      record: cloneJson(data.record),
      recordType: data.recordType,
      recordCode: data.recordCode,
      ambiguousFields: [...(data.ambiguousFields ?? [])],
    },
    `${data.recordCode}/${data.recordType} standard record`,
  );
}

const RECORD_TYPE = /^[1-9]\d{0,31}$/u;
const RECORD_CODE = /^[A-Z][A-Z0-9]{1,31}$/u;

function assertExpectedIdentity(recordType: string, recordCode: string): void {
  if (!RECORD_TYPE.test(recordType) || !RECORD_CODE.test(recordCode)) {
    throw new TildaEngineError(
      "RECORD_IDENTITY_INVALID",
      "Expected standard record identity strings are not canonical.",
    );
  }
}

export class StandardFieldAdapter implements ChangeAdapter {
  readonly id = "standard-field-v1";
  readonly capabilities = ["standard.field.patch"] as const;

  constructor(readonly sessions: AdapterSessionFactory) {}

  supports(request: ChangeRequest): request is StandardFieldPatch {
    return request.operation === "standard.field.patch";
  }

  async read(target: ExactTarget): Promise<AdapterState> {
    if (target.kind !== "record") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Standard adapter requires a record target.");
    }
    return this.sessions.withSession(async (session) => toState(await session.readStandard(target)));
  }

  plan(before: AdapterState, request: ChangeRequest): PlannedMutation {
    if (!this.supports(request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Standard adapter cannot plan this request.");
    }
    const prior = payloadOf(before);
    assertExpectedIdentity(request.expectedIdentity.recordType, request.expectedIdentity.recordCode);
    if (
      prior.recordType !== request.expectedIdentity.recordType ||
      prior.recordCode !== request.expectedIdentity.recordCode
    ) {
      throw new TildaEngineError("RECORD_IDENTITY_MISMATCH", "Standard family identity changed.");
    }
    if (!isSafeStandardContentField(request.field)) {
      throw new TildaEngineError(
        "FIELD_OUT_OF_SCOPE",
        "Standard field is not a safe generic content field.",
      );
    }
    if (prior.ambiguousFields.includes(request.field)) {
      throw new TildaEngineError("FIELD_OUT_OF_SCOPE", "Standard field is ambiguous in the exact record.");
    }
    if (!Object.hasOwn(prior.record, request.field)) {
      throw new TildaEngineError("FIELD_OUT_OF_SCOPE", "Standard field is absent from the exact record.");
    }
    if (typeof prior.record[request.field] !== "string") {
      throw new TildaEngineError(
        "FIELD_OUT_OF_SCOPE",
        "Standard field must be an existing own top-level string.",
      );
    }
    if (prior.record[request.field] === request.value) {
      throw new TildaEngineError("NO_CHANGES", "Requested standard field already matches live state.");
    }
    const next = cloneJson(prior);
    next.record[request.field] = request.value;
    const intended = state(next, `${request.field} patched on ${prior.recordCode}`);
    return {
      adapter: this.id,
      capability: "standard.field.patch",
      request,
      expectedBeforeHash: before.hash,
      ...(before.revision === undefined ? {} : { expectedBeforeRevision: before.revision }),
      expectedAfterHash: intended.hash,
      intendedState: intended,
      changedPaths: [`record.${request.field}`],
      summary: `Patch one exact top-level string field on ${prior.recordCode}.`,
    };
  }

  async apply(plan: PlannedMutation): Promise<AdapterState> {
    if (!this.supports(plan.request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Invalid standard plan.");
    }
    const request = plan.request;
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readStandard(request.target));
      if (fresh.hash !== plan.expectedBeforeHash) {
        throw new TildaEngineError("STALE_TARGET", "Standard record changed before dispatch.");
      }
      if (plan.expectedBeforeRevision !== undefined && fresh.revision !== plan.expectedBeforeRevision) {
        throw new TildaEngineError("STALE_REVISION", "Standard revision changed before dispatch.");
      }
      exactReceipt(
        await session.writeStandard(request.target, request.field, request.value),
      );
      return toState(await session.readStandard(request.target));
    });
  }

  async restore(target: ExactTarget, snapshot: AdapterState): Promise<AdapterState> {
    if (target.kind !== "record") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Standard restore requires record target.");
    }
    const prior = payloadOf(snapshot);
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readStandard(target));
      const current = payloadOf(fresh);
      if (
        current.recordType !== prior.recordType ||
        current.recordCode !== prior.recordCode
      ) {
        throw new TildaEngineError("RECORD_IDENTITY_MISMATCH", "Standard identity changed before restore.");
      }
      const keys = new Set([...Object.keys(prior.record), ...Object.keys(current.record)]);
      const changed = [...keys].filter(
        (key) => JSON.stringify(prior.record[key]) !== JSON.stringify(current.record[key]),
      );
      if (changed.length !== 1) {
        throw new TildaEngineError(
          "SNAPSHOT_MISMATCH",
          "Standard restore requires exactly one changed top-level field.",
        );
      }
      const field = changed[0]!;
      if (
        !isSafeStandardContentField(field) ||
        !Object.hasOwn(prior.record, field) ||
        !Object.hasOwn(current.record, field) ||
        typeof prior.record[field] !== "string" ||
        typeof current.record[field] !== "string"
      ) {
        throw new TildaEngineError(
          "SNAPSHOT_MISMATCH",
          "Standard restore difference is not one existing own top-level string field.",
        );
      }
      const value = prior.record[field];
      exactReceipt(await session.writeStandard(target, field, value));
      return toState(await session.readStandard(target));
    });
  }
}
