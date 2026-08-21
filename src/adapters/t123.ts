import type {
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ExactTarget,
  PlannedMutation,
  T123CodeReplace,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import type { AdapterSessionFactory, T123RecordData } from "./session.js";
import { assertPlainRecord, cloneJson, exactReceipt, state } from "./helpers.js";
import { planT123CodeEdit } from "./t123-code-helper.js";

interface T123Payload {
  record: Record<string, unknown>;
  code: string;
}

function payloadOf(adapterState: AdapterState): T123Payload {
  const payload = assertPlainRecord(adapterState.payload, "T123 payload");
  const record = assertPlainRecord(payload.record, "T123 record");
  if (typeof payload.code !== "string") {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "T123 code is missing.");
  }
  return { record, code: payload.code };
}

function toState(data: T123RecordData): AdapterState {
  const record = cloneJson(data.record) as Record<string, unknown>;
  record.code = data.code;
  return state(
    { record, code: data.code },
    "T123 full record and decoded code",
  );
}

export class T123CodeAdapter implements ChangeAdapter {
  readonly id = "t123-code-v1";
  readonly capabilities = ["t123.code.replace"] as const;

  constructor(readonly sessions: AdapterSessionFactory) {}

  supports(request: ChangeRequest): request is T123CodeReplace {
    return request.operation === "t123.code.replace";
  }

  async read(target: ExactTarget): Promise<AdapterState> {
    if (target.kind !== "record") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "T123 adapter requires a record target.");
    }
    return this.sessions.withSession(async (session) => toState(await session.readT123(target)));
  }

  plan(before: AdapterState, request: ChangeRequest): PlannedMutation {
    if (!this.supports(request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "T123 adapter cannot plan this request.");
    }
    const prior = payloadOf(before);
    const edit = planT123CodeEdit(prior.code, request.edit);
    const next = cloneJson(prior);
    next.code = edit.code;
    next.record.code = edit.code;
    const intended = state(next, "T123 full code replacement");
    return {
      adapter: this.id,
      capability: "t123.code.replace",
      request,
      expectedBeforeHash: before.hash,
      ...(before.revision === undefined ? {} : { expectedBeforeRevision: before.revision }),
      expectedAfterHash: intended.hash,
      intendedState: intended,
      changedPaths: ["record.code"],
      summary: `Apply a bounded ${edit.kind} edit to the decoded T123 code.`,
    };
  }

  async apply(plan: PlannedMutation): Promise<AdapterState> {
    if (!this.supports(plan.request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Invalid T123 plan.");
    }
    const request = plan.request;
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readT123(request.target));
      if (fresh.hash !== plan.expectedBeforeHash) {
        throw new TildaEngineError("STALE_TARGET", "T123 record changed before dispatch.");
      }
      if (plan.expectedBeforeRevision !== undefined && fresh.revision !== plan.expectedBeforeRevision) {
        throw new TildaEngineError("STALE_REVISION", "T123 revision changed before dispatch.");
      }
      exactReceipt(await session.writeT123(request.target, payloadOf(plan.intendedState).code));
      return toState(await session.readT123(request.target));
    });
  }

  async restore(target: ExactTarget, snapshot: AdapterState): Promise<AdapterState> {
    if (target.kind !== "record") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "T123 restore requires record target.");
    }
    const prior = payloadOf(snapshot);
    return this.sessions.withSession(async (session) => {
      exactReceipt(await session.writeT123(target, prior.code));
      return toState(await session.readT123(target));
    });
  }
}
