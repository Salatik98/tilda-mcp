import type { PageTarget, RecordTarget } from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";

export interface ReferencePageCreateEvidence {
  readonly source: PageTarget;
  readonly created: PageTarget;
  readonly baselinePageIds: readonly string[];
  readonly baselinePageOrder: readonly string[];
  readonly createdPageIds: readonly string[];
  readonly createdPageOrder: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly createdRecordIds: readonly string[];
  readonly recordFamilyParity: true;
  readonly createdUnpublished: true;
}

export interface ReferencePageCleanupEvidence {
  readonly source: PageTarget;
  readonly removedPageId: string;
  readonly activePageIds: readonly string[];
  readonly pageOrder: readonly string[];
  readonly removedPageAbsent: true;
  readonly sourceRecordIds: readonly string[];
}

export interface ReferencePageTransport {
  createFromReference(source: PageTarget): Promise<{
    readonly token: object;
    readonly evidence: ReferencePageCreateEvidence;
  }>;
  cleanupCreatedReference(token: object): Promise<ReferencePageCleanupEvidence>;
}

export interface ReferencePageReceipt {
  readonly kind: "reference_page_receipt";
  readonly source: PageTarget;
  readonly created: PageTarget;
  readonly receiptId: string;
}

const taskLineageEligibleReceipts = new WeakSet<object>();

/** One-shot process proof consumed only by the task-authority lineage bridge. */
export function consumeVerifiedReferencePageReceipt(receipt: ReferencePageReceipt): boolean {
  if (!taskLineageEligibleReceipts.has(receipt)) return false;
  taskLineageEligibleReceipts.delete(receipt);
  return true;
}

const ID = /^[1-9]\d*$/u;

function assertPage(target: PageTarget): void {
  if (target.kind !== "page" || !ID.test(target.projectId) || !ID.test(target.pageId)) {
    throw new TildaEngineError("REFERENCE_TARGET_INVALID", "Reference page target is invalid.");
  }
}

function hasCanonicalIds(ids: readonly string[], allowEmpty = false): boolean {
  return (allowEmpty || ids.length > 0) &&
    ids.every((id) => ID.test(id)) &&
    new Set(ids).size === ids.length;
}

/** Process-owned receipt controller. Failed cleanup consumes the receipt before dispatch. */
export class ReferencePageLifecycleController {
  readonly #tokens = new WeakMap<object, object>();

  constructor(readonly transport: ReferencePageTransport) {}

  async createPageFromReference(source: PageTarget): Promise<{
    readonly receipt: ReferencePageReceipt;
    readonly evidence: ReferencePageCreateEvidence;
  }> {
    assertPage(source);
    const created = await this.transport.createFromReference(source);
    assertPage(created.evidence.source);
    assertPage(created.evidence.created);
    if (
      created.evidence.source.projectId !== source.projectId ||
      created.evidence.source.pageId !== source.pageId ||
      created.evidence.created.projectId !== source.projectId ||
      created.evidence.created.pageId === source.pageId ||
      created.evidence.recordFamilyParity !== true ||
      created.evidence.createdUnpublished !== true ||
      !hasCanonicalIds(created.evidence.baselinePageIds) ||
      !hasCanonicalIds(created.evidence.baselinePageOrder) ||
      !hasCanonicalIds(created.evidence.createdPageIds) ||
      !hasCanonicalIds(created.evidence.createdPageOrder) ||
      created.evidence.baselinePageIds.length !== created.evidence.baselinePageOrder.length ||
      created.evidence.createdPageIds.length !== created.evidence.createdPageOrder.length ||
      created.evidence.createdPageIds.length !== created.evidence.baselinePageIds.length + 1 ||
      !created.evidence.baselinePageIds.includes(source.pageId) ||
      !created.evidence.createdPageIds.includes(created.evidence.created.pageId) ||
      created.evidence.baselinePageIds.some((pageId) => !created.evidence.createdPageIds.includes(pageId)) ||
      created.evidence.sourceRecordIds.length === 0 ||
      !hasCanonicalIds(created.evidence.sourceRecordIds) ||
      !hasCanonicalIds(created.evidence.createdRecordIds) ||
      created.evidence.createdRecordIds.length !== created.evidence.sourceRecordIds.length ||
      created.evidence.createdRecordIds.some((recordId) => created.evidence.sourceRecordIds.includes(recordId)) ||
      created.evidence.createdPageIds.filter(
        (pageId) => !created.evidence.baselinePageIds.includes(pageId),
      ).length !== 1 ||
      created.evidence.createdPageIds.filter(
        (pageId) => !created.evidence.baselinePageIds.includes(pageId),
      )[0] !== created.evidence.created.pageId
    ) {
      throw new TildaEngineError(
        "REFERENCE_CREATE_UNVERIFIED",
        "Transport did not prove one same-project unpublished reference clone.",
      );
    }
    const receipt = Object.freeze({
      kind: "reference_page_receipt" as const,
      source: Object.freeze({ ...source }),
      created: Object.freeze({ ...created.evidence.created }),
      receiptId: crypto.randomUUID(),
    });
    this.#tokens.set(receipt, created.token);
    taskLineageEligibleReceipts.add(receipt);
    return { receipt, evidence: created.evidence };
  }

  async cleanupCreatedReference(receipt: ReferencePageReceipt): Promise<ReferencePageCleanupEvidence> {
    const token = this.#tokens.get(receipt);
    if (token === undefined || !Object.isFrozen(receipt)) {
      throw new TildaEngineError(
        "REFERENCE_RECEIPT_REJECTED",
        "Cleanup requires an unconsumed process-owned reference receipt.",
      );
    }
    // Consume before remote dispatch. Ambiguous cleanup is never blind-retried.
    this.#tokens.delete(receipt);
    const evidence = await this.transport.cleanupCreatedReference(token);
    if (
      evidence.source.projectId !== receipt.source.projectId ||
      evidence.source.pageId !== receipt.source.pageId ||
      evidence.removedPageId !== receipt.created.pageId ||
      evidence.removedPageAbsent !== true ||
      evidence.activePageIds.includes(receipt.created.pageId)
    ) {
      throw new TildaEngineError(
        "REFERENCE_CLEANUP_UNVERIFIED",
        "Cleanup did not prove exact receipt-bound clone absence.",
      );
    }
    return evidence;
  }
}

export type KnownTemplateId = "128" | "778" | "131" | "396";

export interface KnownTemplateAddTransport {
  addKnownTemplate(page: PageTarget, templateId: KnownTemplateId): Promise<{
    readonly token: object;
    readonly created: RecordTarget;
    readonly recordType: string;
    readonly recordCode: string;
    readonly beforeRecordIds: readonly string[];
    readonly afterRecordIds: readonly string[];
  }>;
}

export interface KnownTemplateRecordReceipt {
  readonly kind: "known_template_record_receipt";
  readonly target: RecordTarget;
  readonly templateId: KnownTemplateId;
  readonly recordType: string;
  readonly recordCode: string;
}

export class KnownTemplateAddController {
  readonly #tokens = new WeakMap<object, object>();

  constructor(readonly transport: KnownTemplateAddTransport) {}

  async add(page: PageTarget, templateId: KnownTemplateId): Promise<KnownTemplateRecordReceipt> {
    assertPage(page);
    const result = await this.transport.addKnownTemplate(page, templateId);
    const expected = {
      "128": { recordType: "128", recordCode: "TL04" },
      "778": { recordType: "778", recordCode: "ST310N" },
      "131": { recordType: "131", recordCode: "T123" },
      "396": { recordType: "396", recordCode: "T396" },
    }[templateId];
    if (
      result.created.projectId !== page.projectId ||
      result.created.pageId !== page.pageId ||
      !ID.test(result.created.recordId) ||
      result.afterRecordIds.length !== result.beforeRecordIds.length + 1 ||
      !hasCanonicalIds(result.beforeRecordIds, true) ||
      !hasCanonicalIds(result.afterRecordIds, true) ||
      result.beforeRecordIds.includes(result.created.recordId) ||
      !result.afterRecordIds.includes(result.created.recordId) ||
      result.beforeRecordIds.some((recordId) => !result.afterRecordIds.includes(recordId)) ||
      result.recordType !== expected.recordType ||
      result.recordCode !== expected.recordCode
    ) {
      throw new TildaEngineError(
        "KNOWN_TEMPLATE_ADD_UNVERIFIED",
        "Known-template add did not prove one exact created record.",
      );
    }
    const receipt = Object.freeze({
      kind: "known_template_record_receipt" as const,
      target: Object.freeze({ ...result.created }),
      templateId,
      recordType: result.recordType,
      recordCode: result.recordCode,
    });
    this.#tokens.set(receipt, result.token);
    return receipt;
  }
}
