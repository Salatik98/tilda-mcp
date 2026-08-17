import type {
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ExactTarget,
  PageSeoPatch,
  PlannedMutation,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import type { AdapterSessionFactory, PageSettingsData } from "./session.js";
import { assertPlainRecord, cloneJson, exactReceipt, state } from "./helpers.js";

interface PageSettingsPayload {
  fields: Array<[string, string]>;
}

function payloadOf(adapterState: AdapterState): PageSettingsPayload {
  const payload = assertPlainRecord(adapterState.payload, "page settings payload");
  if (!Array.isArray(payload.fields)) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Page settings snapshot is invalid.");
  }
  const fields = payload.fields.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new TildaEngineError("INVALID_ADAPTER_STATE", "Page form entry is invalid.");
    }
    return [entry[0], entry[1]] as [string, string];
  });
  return { fields };
}

function toState(data: PageSettingsData): AdapterState {
  return state(
    { fields: data.fields.map(([key, value]) => [key, value]) },
    "Full page settings form with editor revision",
    `${data.changed}:${data.published}`,
  );
}

export class PageSettingsAdapter implements ChangeAdapter {
  readonly id = "page-settings-v1";
  readonly capabilities = ["page.seo.patch"] as const;

  constructor(readonly sessions: AdapterSessionFactory) {}

  supports(request: ChangeRequest): request is PageSeoPatch {
    return request.operation === "page.seo.patch";
  }

  async read(target: ExactTarget): Promise<AdapterState> {
    if (target.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page settings requires a page target.");
    }
    return this.sessions.withSession(async (session) =>
      toState(await session.readPageSettings(target)),
    );
  }

  plan(before: AdapterState, request: ChangeRequest): PlannedMutation {
    if (!this.supports(request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Page settings cannot plan this request.");
    }
    const prior = payloadOf(before);
    const matches = prior.fields
      .map(([key], index) => ({ key, index }))
      .filter(({ key }) => key === request.field);
    if (matches.length !== 1) {
      throw new TildaEngineError(
        "PAGE_FORM_AMBIGUOUS",
        "Expected one exact meta_descr field in the full page form.",
      );
    }
    const next = cloneJson(prior);
    next.fields[matches[0]!.index] = [request.field, request.value];
    const intended = state(next, "Page meta description patched", before.revision);
    return {
      adapter: this.id,
      capability: "page.seo.patch",
      request,
      expectedBeforeHash: before.hash,
      ...(before.revision === undefined ? {} : { expectedBeforeRevision: before.revision }),
      expectedAfterHash: intended.hash,
      intendedState: intended,
      changedPaths: [`form.${request.field}`],
      summary: "Patch meta_descr while preserving every other page-form field.",
    };
  }

  async apply(plan: PlannedMutation): Promise<AdapterState> {
    if (!this.supports(plan.request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Invalid page settings plan.");
    }
    const request = plan.request;
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readPageSettings(request.target));
      if (fresh.hash !== plan.expectedBeforeHash) {
        throw new TildaEngineError("STALE_TARGET", "Page settings changed before dispatch.");
      }
      if (plan.expectedBeforeRevision !== undefined && fresh.revision !== plan.expectedBeforeRevision) {
        throw new TildaEngineError("STALE_REVISION", "Page editor revision changed before dispatch.");
      }
      const intended = payloadOf(plan.intendedState);
      exactReceipt(await session.writePageSettings(request.target, intended.fields));
      return toState(await session.readPageSettings(request.target));
    });
  }

  async restore(target: ExactTarget, snapshot: AdapterState): Promise<AdapterState> {
    if (target.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page restore requires a page target.");
    }
    const prior = payloadOf(snapshot);
    return this.sessions.withSession(async (session) => {
      exactReceipt(await session.writePageSettings(target, prior.fields));
      return toState(await session.readPageSettings(target));
    });
  }
}
