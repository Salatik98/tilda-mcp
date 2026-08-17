import type {
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ElementTarget,
  ExactTarget,
  PlannedMutation,
  ZeroLeafPatch,
  ZeroResponsivePatch,
  ZeroShapeClone,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import { canonicalHash } from "../research/hash.js";
import type { AdapterSessionFactory, ZeroRecordData } from "./session.js";
import { assertPlainRecord, cloneJson, exactReceipt } from "./helpers.js";

interface ZeroPayload {
  model: unknown;
  serverCanonicalHash?: string;
}

const ZERO_ELEMENT_KEY = /^(?:0|[1-9]\d*)$/u;
const ZERO_ELEMENT_ID = /^[1-9]\d*$/u;

function keyedModel(model: unknown): Record<string, unknown> {
  const record = assertPlainRecord(model, "Zero clean model");
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        /^\d+$/u.test(key) &&
        (!ZERO_ELEMENT_KEY.test(key) || !Number.isSafeInteger(Number(key))),
    )
  ) {
    throw new TildaEngineError(
      "INVALID_ADAPTER_STATE",
      "Zero clean model contains a non-canonical numeric element key.",
    );
  }
  if (!["groups", "meta", "timestamp"].every((key) => Object.hasOwn(record, key))) {
    throw new TildaEngineError(
      "INVALID_ADAPTER_STATE",
      "Zero clean model is missing reproduced metadata.",
    );
  }
  const elementKeys = keys.filter((key) => ZERO_ELEMENT_KEY.test(key));
  if (elementKeys.length === 0) {
    throw new TildaEngineError(
      "INVALID_ADAPTER_STATE",
      "Zero clean model has no hydrated numeric elements.",
    );
  }
  const ids = new Set<string>();
  for (const key of elementKeys) {
    const element = assertPlainRecord(record[key], "Zero element " + key);
    if (typeof element.elem_id !== "string" || !ZERO_ELEMENT_ID.test(element.elem_id)) {
      throw new TildaEngineError(
        "INVALID_ADAPTER_STATE",
        "Zero clean model contains a non-canonical element identity.",
      );
    }
    if (ids.has(element.elem_id)) {
      throw new TildaEngineError(
        "INVALID_ADAPTER_STATE",
        "Zero clean model contains duplicate element identities.",
      );
    }
    ids.add(element.elem_id);
  }
  return record;
}

function payloadOf(adapterState: AdapterState): ZeroPayload {
  const payload = assertPlainRecord(adapterState.payload, "Zero payload");
  if (!("model" in payload)) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Clean Zero model is missing.");
  }
  if (payload.serverCanonicalHash !== undefined && typeof payload.serverCanonicalHash !== "string") {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", "Zero server hash is invalid.");
  }
  return {
    model: keyedModel(payload.model),
    ...(typeof payload.serverCanonicalHash === "string"
      ? { serverCanonicalHash: payload.serverCanonicalHash }
      : {}),
  };
}

function zeroState(modelValue: unknown, summary: string): AdapterState {
  const model = cloneJson(modelValue);
  const semanticModel = cloneJson(keyedModel(model));
  delete semanticModel.timestamp;
  const revision = canonicalHash(semanticModel);
  return {
    hash: canonicalHash({ model: semanticModel }),
    payload: { model },
    summary,
    revision,
  };
}

function toState(data: ZeroRecordData): AdapterState {
  return zeroState(data.model, "Clean Zero runtime model");
}

function elementObjects(model: unknown): Record<string, unknown>[] {
  const record = keyedModel(model);
  return Object.keys(record)
    .filter((key) => ZERO_ELEMENT_KEY.test(key))
    .map((key) => assertPlainRecord(record[key], "Zero element " + key));
}

function exactElement(model: unknown, elementId: string): Record<string, unknown> {
  const matches = elementObjects(model).filter((element) => element.elem_id === elementId);
  if (matches.length !== 1) {
    throw new TildaEngineError(
      "ELEMENT_IDENTITY_MISMATCH",
      "Exact Zero element was missing or duplicated in the clean model.",
    );
  }
  return matches[0]!;
}

function assertShape(element: Record<string, unknown>): void {
  const type = element.type ?? element.elem_type;
  if (type !== "shape") {
    throw new TildaEngineError("ELEMENT_TYPE_MISMATCH", "Zero clone/breakpoint v1 supports shape only.");
  }
}

function nextElementId(model: unknown): string {
  const ids = new Set(elementObjects(model).map((element) => String(element.elem_id)));
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = String(Date.now() + offset);
    if (!ids.has(candidate)) return candidate;
  }
  throw new TildaEngineError("ELEMENT_ID_UNAVAILABLE", "Could not allocate a unique lab element ID.");
}

function nextElementKey(model: unknown): string {
  const record = keyedModel(model);
  const keys = Object.keys(record).filter((key) => ZERO_ELEMENT_KEY.test(key));
  const next = Math.max(...keys.map((key) => Number(key))) + 1;
  if (!Number.isSafeInteger(next)) {
    throw new TildaEngineError("ZERO_MODEL_AMBIGUOUS", "Could not allocate a numeric Zero element key.");
  }
  return String(next);
}

function appendClone(
  model: unknown,
  cloneKey: string,
  clone: Record<string, unknown>,
): void {
  const record = keyedModel(model);
  if (!ZERO_ELEMENT_KEY.test(cloneKey) || Object.hasOwn(record, cloneKey)) {
    throw new TildaEngineError("ZERO_MODEL_AMBIGUOUS", "Clone key is not a new numeric Zero element key.");
  }
  record[cloneKey] = clone;
}

function planZero(before: AdapterState, request: ZeroLeafPatch | ZeroResponsivePatch | ZeroShapeClone): PlannedMutation {
  const prior = payloadOf(before);
  const model = cloneJson(prior.model);
  keyedModel(model);
  const element = exactElement(model, request.target.elementId);
  const changedPaths: string[] = [];
  if (request.operation === "zero.leaf.patch") {
    const type = element.type ?? element.elem_type;
    if (type !== "text") {
      throw new TildaEngineError("ELEMENT_TYPE_MISMATCH", "Zero link v1 supports text elements only.");
    }
    element.link = request.value;
    changedPaths.push(`${request.target.elementId}.link`);
  } else if (request.operation === "zero.responsive.patch") {
    assertShape(element);
    element[request.path] = request.value;
    changedPaths.push(`${request.target.elementId}.${request.path}`);
  } else {
    assertShape(element);
    const clone = cloneJson(element);
    clone.elem_id = nextElementId(model);
    const originalLeft = clone.left;
    const originalTop = clone.top;
    const left = typeof originalLeft === "number" ? originalLeft : Number(originalLeft ?? 0);
    const top = typeof originalTop === "number" ? originalTop : Number(originalTop ?? 0);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      throw new TildaEngineError("ZERO_GEOMETRY_INVALID", "Shape geometry is not numeric.");
    }
    const nextLeft = left + request.offset.left;
    const nextTop = top + request.offset.top;
    clone.left = typeof originalLeft === "string" ? String(nextLeft) : nextLeft;
    clone.top = typeof originalTop === "string" ? String(nextTop) : nextTop;
    const zValues = elementObjects(model).map((candidate) => Number(candidate.zindex ?? 0));
    clone.zindex = Math.max(0, ...zValues.filter(Number.isFinite)) + 1;
    appendClone(model, nextElementKey(model), clone);
    changedPaths.push(`elements.+${String(clone.elem_id)}`);
  }
  const intended = zeroState(model, "Patched clean Zero runtime model");
  return {
    adapter: "zero-model-v1",
    capability: request.operation,
    request,
    expectedBeforeHash: before.hash,
    ...(before.revision === undefined ? {} : { expectedBeforeRevision: before.revision }),
    expectedAfterHash: intended.hash,
    intendedState: intended,
    changedPaths,
    summary: `Apply ${request.operation} on one exact lab Zero element.`,
  };
}

export class ZeroModelAdapter implements ChangeAdapter {
  readonly id = "zero-model-v1";
  readonly capabilities = ["zero.leaf.patch", "zero.responsive.patch", "zero.shape.clone"] as const;

  constructor(readonly sessions: AdapterSessionFactory) {}

  supports(
    request: ChangeRequest,
  ): request is ZeroLeafPatch | ZeroResponsivePatch | ZeroShapeClone {
    return request.operation.startsWith("zero.");
  }

  async read(target: ExactTarget): Promise<AdapterState> {
    if (target.kind !== "record" && target.kind !== "element") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Zero adapter requires record or element target.");
    }
    return this.sessions.withSession(async (session) => toState(await session.readZero(target)));
  }

  plan(before: AdapterState, request: ChangeRequest): PlannedMutation {
    if (!this.supports(request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Zero adapter cannot plan this request.");
    }
    return planZero(before, request);
  }

  async apply(plan: PlannedMutation): Promise<AdapterState> {
    if (!this.supports(plan.request)) {
      throw new TildaEngineError("CAPABILITY_UNSUPPORTED", "Invalid Zero plan.");
    }
    const request = plan.request;
    return this.sessions.withSession(async (session) => {
      const fresh = toState(await session.readZero(request.target));
      if (fresh.hash !== plan.expectedBeforeHash) {
        throw new TildaEngineError("STALE_TARGET", "Zero model changed before dispatch.");
      }
      if (plan.expectedBeforeRevision !== undefined && fresh.revision !== plan.expectedBeforeRevision) {
        throw new TildaEngineError("STALE_REVISION", "Zero server revision changed before dispatch.");
      }
      const intended = payloadOf(plan.intendedState);
      exactReceipt(await session.writeZero(request.target, intended.model));
      return toState(await session.readZero(request.target));
    });
  }

  async restore(target: ExactTarget, snapshot: AdapterState): Promise<AdapterState> {
    if (target.kind !== "record" && target.kind !== "element") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Zero restore requires record or element target.");
    }
    const prior = payloadOf(snapshot);
    return this.sessions.withSession(async (session) => {
      exactReceipt(await session.writeZero(target, prior.model));
      return toState(await session.readZero(target));
    });
  }
}
