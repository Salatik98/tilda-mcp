import { describe, expect, it, vi } from "vitest";

import {
  KnownTemplateAddController,
  ReferencePageLifecycleController,
  type KnownTemplateAddTransport,
  type ReferencePageTransport,
} from "../../src/adapters/reference-page-lifecycle.js";

const SOURCE = Object.freeze({
  kind: "page" as const,
  projectId: "9101",
  pageId: "9201",
});
const CREATED = Object.freeze({ ...SOURCE, pageId: "9203" });

function referenceTransport(): ReferencePageTransport & {
  createFromReference: ReturnType<typeof vi.fn>;
  cleanupCreatedReference: ReturnType<typeof vi.fn>;
} {
  const token = Object.freeze({ transport: "opaque" });
  return {
    createFromReference: vi.fn(async () => ({
      token,
      evidence: {
        source: SOURCE,
        created: CREATED,
        baselinePageIds: ["9199", SOURCE.pageId, "9202"],
        baselinePageOrder: ["9199", SOURCE.pageId, "9202"],
        createdPageIds: ["9199", SOURCE.pageId, CREATED.pageId, "9202"],
        createdPageOrder: ["9199", SOURCE.pageId, CREATED.pageId, "9202"],
        sourceRecordIds: ["1001", "1002"],
        createdRecordIds: ["2001", "2002"],
        recordFamilyParity: true as const,
        createdUnpublished: true as const,
      },
    })),
    cleanupCreatedReference: vi.fn(async () => ({
      source: SOURCE,
      removedPageId: CREATED.pageId,
      activePageIds: ["9199", SOURCE.pageId, "9202"],
      pageOrder: ["9199", SOURCE.pageId, "9202"],
      removedPageAbsent: true as const,
      sourceRecordIds: ["1001", "1002"],
    })),
  };
}

describe("reference page and known-template controllers", () => {
  it("supports a multi-page same-project reference clone and exact one-shot cleanup", async () => {
    const transport = referenceTransport();
    const controller = new ReferencePageLifecycleController(transport);
    const created = await controller.createPageFromReference(SOURCE);
    expect(created.evidence.baselinePageIds).toHaveLength(3);
    expect(created.receipt).toMatchObject({ source: SOURCE, created: CREATED });
    await expect(controller.cleanupCreatedReference(created.receipt)).resolves.toMatchObject({
      removedPageId: CREATED.pageId,
      removedPageAbsent: true,
    });
    expect(transport.cleanupCreatedReference).toHaveBeenCalledTimes(1);
    await expect(controller.cleanupCreatedReference(created.receipt)).rejects.toMatchObject({
      code: "REFERENCE_RECEIPT_REJECTED",
    });
    expect(transport.cleanupCreatedReference).toHaveBeenCalledTimes(1);
  });

  it("rejects a forged cleanup receipt before transport", async () => {
    const transport = referenceTransport();
    const controller = new ReferencePageLifecycleController(transport);
    await expect(controller.cleanupCreatedReference(Object.freeze({
      kind: "reference_page_receipt",
      source: SOURCE,
      created: CREATED,
      receiptId: crypto.randomUUID(),
    }))).rejects.toMatchObject({ code: "REFERENCE_RECEIPT_REJECTED" });
    expect(transport.cleanupCreatedReference).not.toHaveBeenCalled();
  });

  it("returns an opaque exact created-record receipt for known templates", async () => {
    const token = Object.freeze({ token: "record" });
    const transport: KnownTemplateAddTransport = {
      addKnownTemplate: vi.fn(async () => ({
        token,
        created: { ...SOURCE, kind: "record" as const, recordId: "9306" },
        recordType: "128",
        recordCode: "TL04",
        beforeRecordIds: ["1001", "1002"],
        afterRecordIds: ["1001", "1002", "9306"],
      })),
    };
    const controller = new KnownTemplateAddController(transport);
    await expect(controller.add(SOURCE, "128")).resolves.toMatchObject({
      kind: "known_template_record_receipt",
      target: { recordId: "9306" },
      templateId: "128",
    });
  });
});
