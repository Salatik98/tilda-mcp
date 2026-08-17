import type {
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ExactTarget,
  PageHeadCodeReplace,
  PlannedMutation,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import type { AdapterSessionFactory, PageHeadCodeData } from "./session.js";
import { assertPlainRecord, exactReceipt, state } from "./helpers.js";

interface PageHeadCodePayload {
  code: string;
  published: string;
}

function payloadOf(adapterState: AdapterState): PageHeadCodePayload {
  const payload = assertPlainRecord(adapterState.payload, "page HEAD code payload");
  if (typeof payload.code !== "string") {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Page HEAD code snapshot is invalid.");
  }
  if (typeof payload.published !== "string") {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Page publication state is invalid.");
  }
  return { code: payload.code, published: payload.published };
}

function toState(data: PageHeadCodeData): AdapterState {
  return state(
    { code: data.code, published: data.published },
    "Full page-specific HEAD code",
    data.changed,
  );
}

export class PageHeadCodeAdapter implements ChangeAdapter {
  readonly id = "page-head-code-v1";
  readonly capabilities = ["page.head.code.replace"] as const;

  constructor(readonly sessions: AdapterSessionFactory) {}

  supports(request: ChangeRequest): request is PageHeadCodeReplace {
    return request.operation === "page.head.code.replace";
  }

  async read(target: ExactTarget): Promise<AdapterState> {
    if (target.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page HEAD code requires a page target.");
    }
    return this.sessions.withSession(async (session) => toState(await session.readPageHeadCode(target)));
  }

  plan(before: AdapterState, request: ChangeRequest): PlannedMutation {
    if (!this.supports(request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Page HEAD adapter cannot plan this request.");
    }
    const prior = payloadOf(before);
    if (prior.code === request.code) {
      throw new TildaEngineError("NO_CHANGES", "Requested page HEAD code already matches live state.");
    }
    const intended = state(
      { code: request.code, published: prior.published },
      "Full page-specific HEAD code replacement",
      before.revision,
    );
    return {
      adapter: this.id,
      capability: "page.head.code.replace",
      request,
      expectedBeforeHash: before.hash,
      ...(before.revision === undefined ? {} : { expectedBeforeRevision: before.revision }),
      expectedAfterHash: intended.hash,
      intendedState: intended,
      changedPaths: ["page.headcode"],
      summary: "Replace page-specific HEAD code on the exact lab page without publishing.",
    };
  }

  async apply(plan: PlannedMutation): Promise<AdapterState> {
    if (!this.supports(plan.request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Invalid page HEAD code plan.");
    }
    const request = plan.request;
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readPageHeadCode(request.target));
      if (fresh.hash !== plan.expectedBeforeHash) {
        throw new TildaEngineError("STALE_TARGET", "Page HEAD code changed before dispatch.");
      }
      if (plan.expectedBeforeRevision !== undefined && fresh.revision !== plan.expectedBeforeRevision) {
        throw new TildaEngineError("STALE_REVISION", "Page editor revision changed before HEAD dispatch.");
      }
      exactReceipt(
        await session.writePageHeadCode(request.target, request.code, payloadOf(fresh).code),
      );
      const first = toState(await session.readPageHeadCode(request.target));
      const confirmed = toState(await session.readPageHeadCode(request.target));
      if (
        first.hash !== plan.expectedAfterHash ||
        confirmed.hash !== plan.expectedAfterHash ||
        first.hash !== confirmed.hash
      ) {
        throw new TildaEngineError(
          "HEAD_WRITE_VERIFICATION_AMBIGUOUS",
          "Two bounded rereads did not prove the exact HEAD code and unchanged publication state; automatic restore is unsafe.",
        );
      }
      return confirmed;
    });
  }

  async restore(target: ExactTarget, snapshot: AdapterState): Promise<AdapterState> {
    if (target.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page HEAD restore requires a page target.");
    }
    const prior = payloadOf(snapshot);
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readPageHeadCode(target));
      exactReceipt(
        await session.writePageHeadCode(target, prior.code, payloadOf(fresh).code),
      );
      const first = toState(await session.readPageHeadCode(target));
      const confirmed = toState(await session.readPageHeadCode(target));
      if (
        first.hash !== snapshot.hash ||
        confirmed.hash !== snapshot.hash ||
        first.hash !== confirmed.hash
      ) {
        throw new TildaEngineError(
          "HEAD_RESTORE_VERIFICATION_AMBIGUOUS",
          "Two bounded rereads did not prove exact HEAD restoration and unchanged publication state.",
        );
      }
      return confirmed;
    });
  }
}
