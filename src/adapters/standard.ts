import type {
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ExactTarget,
  PlannedMutation,
  StandardFieldPatch,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import type { AdapterSessionFactory, StandardRecordData } from "./session.js";
import { assertPlainRecord, cloneJson, exactReceipt, state } from "./helpers.js";

interface StandardPayload {
  record: Record<string, unknown>;
  recordType: string;
  recordCode: string;
}

function payloadOf(adapterState: AdapterState): StandardPayload {
  const payload = assertPlainRecord(adapterState.payload, "standard payload");
  const record = assertPlainRecord(payload.record, "standard record");
  if (typeof payload.recordType !== "string" || typeof payload.recordCode !== "string") {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Standard identity is missing.");
  }
  return { record, recordType: payload.recordType, recordCode: payload.recordCode };
}

function toState(data: StandardRecordData): AdapterState {
  return state(
    {
      record: cloneJson(data.record),
      recordType: data.recordType,
      recordCode: data.recordCode,
    },
    `${data.recordCode}/${data.recordType} standard record`,
  );
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
    if (
      prior.recordType !== request.expectedIdentity.recordType ||
      prior.recordCode !== request.expectedIdentity.recordCode
    ) {
      throw new TildaEngineError("RECORD_IDENTITY_MISMATCH", "Standard family identity changed.");
    }
    const allowed =
      (prior.recordType === "128" && prior.recordCode === "TL04" && request.field === "title") ||
      (prior.recordType === "778" && prior.recordCode === "ST310N" && request.field === "buttontitle");
    if (!allowed) {
      throw new TildaEngineError("FIELD_OUT_OF_SCOPE", "Field is not proven for this standard family.");
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
      summary: `Patch ${request.field} on exact ${prior.recordCode} lab record.`,
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
    const field =
      prior.recordCode === "TL04" && prior.recordType === "128"
        ? "title"
        : prior.recordCode === "ST310N" && prior.recordType === "778"
          ? "buttontitle"
          : null;
    if (field === null || typeof prior.record[field] !== "string") {
      throw new TildaEngineError("SNAPSHOT_MISMATCH", "Standard snapshot is outside v1 scope.");
    }
    const value = prior.record[field] as string;
    return this.sessions.withSession(async (session) => {
      exactReceipt(await session.writeStandard(target, field, value));
      return toState(await session.readStandard(target));
    });
  }
}
