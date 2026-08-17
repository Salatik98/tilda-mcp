import type {
  AdapterSessionFactory,
  BoundAdapterSession,
  DispatchReceipt,
  PageHeadCodeData,
  PageSettingsData,
  PublicationData,
  StandardRecordData,
  T123RecordData,
  ZeroRecordData,
} from "../adapters/session.js";
import type { PageLifecycleTransport } from "../adapters/page-lifecycle.js";
import type { ElementTarget, PageTarget, RecordTarget } from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import type { LabPageTarget, LabRecordTarget, ResearchConfig } from "../research/config.js";
import type { ExactEditorRecordRead } from "../research/browser-session.js";
import { canonicalHash } from "../research/hash.js";
import {
  withLoopbackBrowserAuthority,
  type FixedDispatchReceipt,
  type LoopbackBrowserAuthority,
} from "./browser-authority.js";

function labPage(target: PageTarget | RecordTarget | ElementTarget): LabPageTarget {
  return { projectId: target.projectId, pageId: target.pageId };
}

function labRecord(target: RecordTarget | ElementTarget): LabRecordTarget {
  return {
    projectId: target.projectId,
    pageId: target.pageId,
    recordId: target.recordId,
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TildaEngineError("ADAPTER_RESPONSE_REJECTED", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

const ZERO_ELEMENT_KEY = /^(?:0|[1-9]\d*)$/u;
const ZERO_ELEMENT_ID = /^[1-9]\d*$/u;

function cleanZeroModel(value: unknown): Record<string, unknown> {
  const model = object(value, "Zero cleanElementsData");
  const prototype = Object.getPrototypeOf(model) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TildaEngineError(
      "ADAPTER_RESPONSE_REJECTED",
      "Zero cleanElementsData must be a plain keyed object.",
    );
  }
  const keys = Object.keys(model);
  if (
    keys.some(
      (key) =>
        /^\d+$/u.test(key) &&
        (!ZERO_ELEMENT_KEY.test(key) || !Number.isSafeInteger(Number(key))),
    )
  ) {
    throw new TildaEngineError(
      "ADAPTER_RESPONSE_REJECTED",
      "Zero cleanElementsData contains a non-canonical numeric element key.",
    );
  }
  if (!["groups", "meta", "timestamp"].every((key) => Object.hasOwn(model, key))) {
    throw new TildaEngineError(
      "ADAPTER_RESPONSE_REJECTED",
      "Zero cleanElementsData is missing reproduced metadata.",
    );
  }
  const elementKeys = keys.filter((key) => ZERO_ELEMENT_KEY.test(key));
  if (elementKeys.length === 0) {
    throw new TildaEngineError(
      "ADAPTER_RESPONSE_REJECTED",
      "Zero cleanElementsData has no hydrated numeric elements.",
    );
  }
  const ids = new Set<string>();
  for (const key of elementKeys) {
    const element = object(model[key], "Zero element " + key);
    if (typeof element.elem_id !== "string" || !ZERO_ELEMENT_ID.test(element.elem_id)) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Zero cleanElementsData contains a non-canonical element identity.",
      );
    }
    if (ids.has(element.elem_id)) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Zero cleanElementsData contains duplicate element identities.",
      );
    }
    ids.add(element.elem_id);
  }
  return model;
}

function recordFromRead(
  read: ExactEditorRecordRead,
  options: { requireWritableField?: boolean } = {},
): Record<string, unknown> {
  const payload = object(read.payload, "Tilda response");
  if (!("tpl" in payload)) {
    throw new TildaEngineError("ADAPTER_RESPONSE_REJECTED", "Tilda response lacks tpl identity.");
  }
  const record = object(payload.record, "Tilda record");
  if (
    String(record.id ?? "") !== read.target.recordId ||
    String(record.pageid ?? "") !== read.target.pageId
  ) {
    throw new TildaEngineError(
      "ADAPTER_TARGET_MISMATCH",
      "Tilda response record does not match the exact page/record target.",
    );
  }
  const cloned = structuredClone(record);
  if (options.requireWritableField === true) {
    const writable = read.writableField;
    const expectedField =
      read.identity.recordType === "128" && read.identity.recordCode === "TL04"
        ? "title"
        : read.identity.recordType === "778" && read.identity.recordCode === "ST310N"
          ? "buttontitle"
          : null;
    if (
      expectedField === null ||
      writable === undefined ||
      writable.name !== expectedField ||
      typeof writable.value !== "string" ||
      (writable.representation !== "rendered_inner_html" &&
        writable.representation !== "absent_empty")
    ) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Tilda standard read lacks the exact rendered writable field.",
      );
    }
    if (Object.hasOwn(cloned, expectedField) && cloned[expectedField] !== writable.value) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Tilda settings and rendered field disagree.",
      );
    }
    cloned[expectedField] = writable.value;
  }
  return cloned;
}

export function decodeT123Once(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#039;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function dispatch(receipt: FixedDispatchReceipt): DispatchReceipt {
  return {
    operationId: receipt.operationId,
    requestDispatched: receipt.dispatched,
    acknowledgement: receipt.ack === "http_ok" ? "acknowledged" : "rejected",
    publishObserved: false,
  };
}

export class AuthorityBoundAdapterSession implements BoundAdapterSession {
  readonly leaseId: string;
  readonly sessionId: string;

  constructor(
    readonly authority: LoopbackBrowserAuthority,
    readonly publicDomain?: string,
  ) {
    this.leaseId = authority.metadata.leaseId;
    this.sessionId = authority.metadata.sessionId;
  }

  async readStandard(target: RecordTarget): Promise<StandardRecordData> {
    const read = await this.authority.adapter.readStandardSettings(labRecord(target));
    return {
      record: recordFromRead(read, { requireWritableField: true }),
      recordType: read.identity.recordType,
      recordCode: read.identity.recordCode,
    };
  }

  async writeStandard(target: RecordTarget, field: "title" | "buttontitle", value: string) {
    return dispatch(await this.authority.adapter.writeStandard(labRecord(target), field, value));
  }

  async readT123(target: RecordTarget): Promise<T123RecordData> {
    const read = await this.authority.adapter.readT123Content(labRecord(target));
    if (read.identity.recordType !== "131" || read.identity.recordCode !== "T123") {
      throw new TildaEngineError("RECORD_IDENTITY_MISMATCH", "Exact record is not T123 / 131.");
    }
    const record = recordFromRead(read);
    if (Object.hasOwn(record, "code") && typeof record.code !== "string") {
      throw new TildaEngineError("ADAPTER_RESPONSE_REJECTED", "T123 response code is not text.");
    }
    const transportCode = typeof record.code === "string" ? record.code : "";
    return { record, code: decodeT123Once(transportCode) };
  }

  async writeT123(target: RecordTarget, code: string) {
    return dispatch(await this.authority.adapter.writeT123(labRecord(target), code));
  }

  async readZero(target: RecordTarget | ElementTarget): Promise<ZeroRecordData> {
    const read = await this.authority.adapter.readZeroModel(labRecord(target));
    if (read.identity.recordType !== "396" || read.identity.recordCode !== "T396") {
      throw new TildaEngineError("RECORD_IDENTITY_MISMATCH", "Exact record is not T396 / 396.");
    }
    const payload = object(read.payload, "Zero runtime payload");
    return { model: structuredClone(cleanZeroModel(payload.cleanElementsData)) };
  }

  async writeZero(target: RecordTarget | ElementTarget, cleanModel: unknown): Promise<DispatchReceipt> {
    return dispatch(
      await this.authority.adapter.writeZeroModel(labRecord(target), cleanModel),
    );
  }

  async readPageSettings(target: PageTarget): Promise<PageSettingsData> {
    const exactTarget = labPage(target);
    const settings = await this.authority.adapter.readPageSettings(exactTarget);
    const editor = await this.authority.adapter.readEditorPage(exactTarget);
    if (editor.published === null) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Exact pagepublished editor global is unavailable.",
      );
    }
    return {
      fields: settings.fields.map(([name, value]) => [name, value] as const),
      changed: editor.changed ?? canonicalHash(settings.fields),
      published: editor.published,
    };
  }

  async writePageSettings(
    target: PageTarget,
    fields: readonly (readonly [string, string])[],
  ): Promise<DispatchReceipt> {
    return dispatch(
      await this.authority.adapter.writePageSettings(labPage(target), fields),
    );
  }

  async readPageHeadCode(target: PageTarget): Promise<PageHeadCodeData> {
    const exactTarget = labPage(target);
    const head = await this.authority.adapter.readPageHeadCode(exactTarget);
    const editor = await this.authority.adapter.readEditorPage(exactTarget);
    if (editor.published === null) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Exact pagepublished editor global is unavailable.",
      );
    }
    return {
      code: head.code,
      changed: editor.changed ?? canonicalHash(head.code),
      published: editor.published,
    };
  }

  async writePageHeadCode(
    target: PageTarget,
    code: string,
    expectedCurrentCode: string,
  ): Promise<DispatchReceipt> {
    return dispatch(
      await this.authority.adapter.writePageHeadCode(
        labPage(target),
        code,
        expectedCurrentCode,
      ),
    );
  }

  async readPublication(target: PageTarget): Promise<PublicationData> {
    const editor = await this.authority.adapter.readEditorPage(labPage(target));
    if (editor.published === null || !editor.editorLoadedAnchor || editor.records.length === 0) {
      throw new TildaEngineError(
        "ADAPTER_RESPONSE_REJECTED",
        "Exact page publication globals and record identities are unavailable.",
      );
    }
    return {
      changed: editor.changed ?? canonicalHash(editor.records),
      published: editor.published,
      pageUrl: editor.href,
      publicUrl: this.publicDomain === undefined ? "" : `https://${this.publicDomain}/`,
    };
  }

  async publish(target: PageTarget): Promise<DispatchReceipt> {
    return dispatch(await this.authority.adapter.publishPage(labPage(target)));
  }

  async unpublish(target: PageTarget): Promise<DispatchReceipt> {
    return dispatch(await this.authority.adapter.unpublishPage(labPage(target)));
  }
}

export class LoopbackAdapterSessionFactory implements AdapterSessionFactory {
  constructor(readonly config: ResearchConfig) {}

  async withSession<T>(action: (session: BoundAdapterSession) => Promise<T>): Promise<T> {
    return withLoopbackBrowserAuthority(this.config, async (authority) =>
      action(new AuthorityBoundAdapterSession(
        authority,
        this.config.publicTestDomains?.length === 1
          ? this.config.publicTestDomains[0]
          : undefined,
      )),
    );
  }
}

/** One opaque EXP-16 transaction; no generic duplicate/sort/delete methods escape. */
export class LoopbackPageLifecycleTransport implements PageLifecycleTransport {
  constructor(readonly config: ResearchConfig) {}

  async duplicateVerifyReorderRestoreCleanup(target: PageTarget) {
    return withLoopbackBrowserAuthority(this.config, async (authority) => {
      const evidence = await authority.adapter.runFixedPageLifecycle(labPage(target));
      return {
        baseline: {
          source: { ...target },
          activePageIds: evidence.baseline.activePageIds,
          pageOrder: evidence.baseline.pageOrder,
          sourceRecordIds: evidence.baseline.sourceRecordIds,
          sourcePublished: evidence.baseline.sourcePublished,
          sourceChanged: evidence.baseline.sourceChanged,
        },
        restored: {
          source: { ...target },
          activePageIds: evidence.restored.activePageIds,
          pageOrder: evidence.restored.pageOrder,
          sourceRecordIds: evidence.restored.sourceRecordIds,
          sourcePublished: evidence.restored.sourcePublished,
          sourceChanged: evidence.restored.sourceChanged,
          temporaryPageId: evidence.restored.temporaryPageId,
          temporaryPageAbsent: evidence.restored.temporaryPageAbsent,
          pageOrderRestored: evidence.restored.pageOrderRestored,
          sourceUnchanged: evidence.restored.sourceUnchanged,
          exactBaselineRestored: evidence.restored.exactBaselineRestored,
        },
      };
    });
  }
}
