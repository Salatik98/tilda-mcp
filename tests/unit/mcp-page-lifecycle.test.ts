import { describe, expect, it, vi } from "vitest";

import type {
  KnownTemplateRecordReceipt,
  ReferencePageReceipt,
} from "../../src/adapters/reference-page-lifecycle.js";
import { EngineTildaMcpService } from "../../src/mcp/engine-service.js";
import { pageLifecycleInputSchema } from "../../src/mcp/server.js";
import type { TildaChangeSetEngine } from "../../src/core/engine.js";
import { TaskAuthorityManager } from "../../src/core/task-authority-manager.js";
import type { ResearchConfig } from "../../src/research/config.js";
import { hashLiveInventory } from "../../src/research/config.js";
import type { TrustedBindingEstablished } from "../../src/research/inventory.js";

const PAGE = { kind: "page" as const, projectId: "9101", pageId: "9201" };
const PAGE_2 = { kind: "page" as const, projectId: "9101", pageId: "9202" };
const PROJECT = { kind: "project" as const, projectId: PAGE.projectId };

function binding(): TrustedBindingEstablished {
  const inventory = {
    accountFingerprint: "a".repeat(64),
    projectIds: [PAGE.projectId],
    pageOwnership: { [PAGE.projectId]: [PAGE.pageId, PAGE_2.pageId] },
  };
  return {
    status: "BOUND",
    capturedAt: "2026-08-20T04:00:00.000Z",
    source: "trusted_same_session_cdp",
    route: "/projects/",
    accountFingerprint: inventory.accountFingerprint,
    inventoryHash: hashLiveInventory(inventory),
    inventory,
    projectCount: 1,
    pageCount: 2,
    captureContext: { cdpTargetId: "test-target", expiresAt: null },
    privacy: {
      rawAccountIdPersisted: false,
      titlesOrContentPersisted: false,
      cookiesOrSessionDataPersisted: false,
    },
  };
}

function referenceReceipt(source = PAGE, created = PAGE_2): ReferencePageReceipt {
  // The extra token is deliberately not part of the public MCP result. It
  // models the adapter-owned opaque handle retained by the service.
  return Object.freeze({
    kind: "reference_page_receipt" as const,
    source: Object.freeze({ ...source }),
    created: Object.freeze({ ...created }),
    receiptId: "018f0000-0000-4000-8000-000000000001",
    token: Object.freeze({ private: "adapter-only" }),
  }) as unknown as ReferencePageReceipt;
}

function createEvidence(source = PAGE, created = PAGE_2) {
  return {
    source,
    created,
    baselinePageIds: [source.pageId],
    baselinePageOrder: [source.pageId],
    createdPageIds: [source.pageId, created.pageId],
    createdPageOrder: [source.pageId, created.pageId],
    sourceRecordIds: ["300"],
    createdRecordIds: ["400"],
    recordFamilyParity: true as const,
    createdUnpublished: true as const,
  };
}

function knownTemplateReceipt(): KnownTemplateRecordReceipt {
  return Object.freeze({
    kind: "known_template_record_receipt" as const,
    target: Object.freeze({
      kind: "record" as const,
      projectId: PAGE.projectId,
      pageId: PAGE.pageId,
      recordId: "500",
    }),
    templateId: "128" as const,
    recordType: "128",
    recordCode: "TL04",
  });
}

function service(options: {
  pageLifecycle?: object | null;
  referencePages?: object | null;
  knownTemplates?: object | null;
} = {}): {
  service: EngineTildaMcpService;
  lifecycleExecute: ReturnType<typeof vi.fn>;
  referenceCreate: ReturnType<typeof vi.fn>;
  referenceCleanup: ReturnType<typeof vi.fn>;
  templateAdd: ReturnType<typeof vi.fn>;
} {
  const lifecycleExecute = vi.fn(async (request: { readonly dryRun?: boolean }) => ({
    changeSetId: "018f0000-0000-4000-8000-000000000002",
    snapshotId: "018f0000-0000-4000-8000-000000000003",
    dryRun: request.dryRun !== false,
    stateChanged: false as const,
    baseline: null,
    restored: null,
  }));
  const referenceCreate = vi.fn(async (source: typeof PAGE) => ({
    receipt: referenceReceipt(source),
    evidence: createEvidence(source),
  }));
  const referenceCleanup = vi.fn(async (receipt: ReferencePageReceipt) => ({
    source: receipt.source,
    removedPageId: receipt.created.pageId,
    activePageIds: [receipt.source.pageId],
    pageOrder: [receipt.source.pageId],
    removedPageAbsent: true as const,
    sourceRecordIds: ["300"],
  }));
  const templateAdd = vi.fn(async () => knownTemplateReceipt());

  const fakeReferencePages = options.referencePages === null
    ? null
    : options.referencePages ?? {
        createPageFromReference: referenceCreate,
        cleanupCreatedReference: referenceCleanup,
      };
  const fakeKnownTemplates = options.knownTemplates === null
    ? null
    : options.knownTemplates ?? { add: templateAdd };
  const fakePageLifecycle = options.pageLifecycle === null
    ? null
    : options.pageLifecycle ?? { execute: lifecycleExecute };

  const engine = {
    capabilities: () => [],
  } as unknown as TildaChangeSetEngine;
  const config = {
    labProjectIds: [PAGE.projectId],
    labPageTargets: [{ projectId: PAGE.projectId, pageId: PAGE.pageId }],
  } as unknown as ResearchConfig;
  const authority = new TaskAuthorityManager();
  const capture = vi.fn(async () => binding());
  const instance = new EngineTildaMcpService(
    config,
    engine,
    null as never,
    null as never,
    undefined,
    fakePageLifecycle as never,
    null,
    null,
    authority,
    capture,
    fakeReferencePages as never,
    fakeKnownTemplates as never,
  );
  return { service: instance, lifecycleExecute, referenceCreate, referenceCleanup, templateAdd };
}

async function authorize(
  instance: EngineTildaMcpService,
  operations: readonly string[] = [
    "page.reference.clone",
    "page.reference.cleanup",
    "standard.template.add",
  ],
  writeTargets: readonly object[] = [PROJECT],
) {
  return instance.execute("tilda_authorize_task", {
    taskDescription: "Run the exact page lifecycle copy test",
    mode: "production",
    observeTargets: [],
    writeTargets,
    allowedOperations: operations,
    ttlMs: 60_000,
  });
}

describe("MCP page-lifecycle action contracts", () => {
  it("accepts every action variant with dry-run default and rejects cross-action fields", () => {
    const base = { target: PAGE, idempotencyKey: "page-lifecycle-schema-1" };
    expect(pageLifecycleInputSchema.parse({ ...base, action: "fixed_roundtrip" })).toMatchObject({
      action: "fixed_roundtrip",
      dryRun: true,
    });
    expect(pageLifecycleInputSchema.parse({ ...base, action: "create_from_reference" })).toMatchObject({
      action: "create_from_reference",
      dryRun: true,
    });
    expect(pageLifecycleInputSchema.parse({
      ...base,
      action: "cleanup_reference",
      receiptId: "018f0000-0000-4000-8000-000000000001",
    })).toMatchObject({ action: "cleanup_reference", dryRun: true });
    expect(pageLifecycleInputSchema.parse({
      ...base,
      action: "add_known_template",
      templateId: "396",
    })).toMatchObject({ action: "add_known_template", templateId: "396", dryRun: true });
    expect(pageLifecycleInputSchema.safeParse({ ...base, action: "cleanup_reference" }).success).toBe(false);
    expect(pageLifecycleInputSchema.safeParse({ ...base, action: "add_known_template" }).success).toBe(false);
    expect(pageLifecycleInputSchema.safeParse({
      ...base,
      action: "create_from_reference",
      receiptId: "018f0000-0000-4000-8000-000000000001",
    }).success).toBe(false);
    expect(pageLifecycleInputSchema.safeParse({ ...base, action: "fixed_roundtrip", templateId: "128" }).success)
      .toBe(false);
  });

  it("dry-runs each structural action without invoking an adapter transport", async () => {
    const { service: instance, lifecycleExecute, referenceCreate, referenceCleanup, templateAdd } = service();
    await authorize(instance);

    await expect(instance.execute("tilda_page_lifecycle", {
      action: "fixed_roundtrip",
      target: PAGE,
      idempotencyKey: "page-lifecycle-dry-fixed-1",
    })).resolves.toMatchObject({
      ok: true,
      code: "DRY_RUN",
      capability: "page.lifecycle.duplicate_verify_reorder_restore_cleanup",
    });
    await expect(instance.execute("tilda_page_lifecycle", {
      action: "create_from_reference",
      target: PAGE,
      idempotencyKey: "page-lifecycle-dry-create-1",
    })).resolves.toMatchObject({ ok: true, code: "DRY_RUN", capability: "page.reference.clone" });
    await expect(instance.execute("tilda_page_lifecycle", {
      action: "add_known_template",
      target: PAGE,
      templateId: "128",
      idempotencyKey: "page-lifecycle-dry-template-1",
    })).resolves.toMatchObject({ ok: true, code: "DRY_RUN", capability: "standard.template.add" });

    expect(lifecycleExecute).toHaveBeenCalledTimes(1);
    expect(referenceCreate).not.toHaveBeenCalled();
    expect(referenceCleanup).not.toHaveBeenCalled();
    expect(templateAdd).not.toHaveBeenCalled();
  });

  it("stores a process-owned receipt, replays idempotently, and rejects an idempotency conflict", async () => {
    const { service: instance, referenceCreate, referenceCleanup } = service();
    await authorize(instance, ["page.reference.clone", "page.reference.cleanup"], [PROJECT]);

    const first = await instance.execute("tilda_page_lifecycle", {
      action: "create_from_reference",
      target: PAGE,
      idempotencyKey: "page-lifecycle-create-1",
      dryRun: false,
    });
    expect(first).toMatchObject({
      ok: true,
      code: "REFERENCE_PAGE_CREATED",
      target: PAGE_2,
      verification: {
        receiptId: "018f0000-0000-4000-8000-000000000001",
        recordFamilyParity: true,
        createdUnpublished: true,
      },
    });
    expect(JSON.stringify(first)).not.toContain("adapter-only");
    expect(referenceCreate).toHaveBeenCalledTimes(1);

    const replay = await instance.execute("tilda_page_lifecycle", {
      action: "create_from_reference",
      target: PAGE,
      idempotencyKey: "page-lifecycle-create-1",
      dryRun: false,
    });
    expect(replay).toEqual(first);
    expect(referenceCreate).toHaveBeenCalledTimes(1);

    const conflict = await instance.execute("tilda_page_lifecycle", {
      action: "cleanup_reference",
      target: PAGE,
      receiptId: "018f0000-0000-4000-8000-000000000001",
      idempotencyKey: "page-lifecycle-create-1",
      dryRun: false,
    });
    expect(conflict).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(referenceCleanup).not.toHaveBeenCalled();
  });

  it("cleans only the exact stored receipt and blocks replay after an ambiguous cleanup", async () => {
    const { service: instance, referenceCreate, referenceCleanup } = service();
    await authorize(instance, ["page.reference.clone", "page.reference.cleanup"], [PROJECT]);
    await expect(instance.execute("tilda_page_lifecycle", {
      action: "create_from_reference",
      target: PAGE,
      idempotencyKey: "page-lifecycle-cleanup-create-1",
      dryRun: false,
    })).resolves.toMatchObject({ ok: true, code: "REFERENCE_PAGE_CREATED" });

    const cleaned = await instance.execute("tilda_page_lifecycle", {
      action: "cleanup_reference",
      target: PAGE,
      receiptId: "018f0000-0000-4000-8000-000000000001",
      idempotencyKey: "page-lifecycle-cleanup-1",
      dryRun: false,
    });
    expect(cleaned).toMatchObject({
      ok: true,
      code: "REFERENCE_PAGE_CLEANED",
      target: PAGE_2,
      verification: { removedPageId: PAGE_2.pageId, removedPageAbsent: true },
    });
    expect(referenceCleanup).toHaveBeenCalledTimes(1);
    expect(referenceCleanup.mock.calls[0]?.[0]).toMatchObject({
      receiptId: "018f0000-0000-4000-8000-000000000001",
      source: PAGE,
      created: PAGE_2,
    });

    const replay = await instance.execute("tilda_page_lifecycle", {
      action: "cleanup_reference",
      target: PAGE,
      receiptId: "018f0000-0000-4000-8000-000000000001",
      idempotencyKey: "page-lifecycle-cleanup-1",
      dryRun: false,
    });
    expect(replay).toMatchObject({ ok: false, code: "REFERENCE_RECEIPT_REJECTED" });
    expect(referenceCleanup).toHaveBeenCalledTimes(1);

    const receiptGone = await instance.execute("tilda_page_lifecycle", {
      action: "cleanup_reference",
      target: PAGE,
      receiptId: "018f0000-0000-4000-8000-000000000001",
      idempotencyKey: "page-lifecycle-cleanup-2",
      dryRun: false,
    });
    expect(receiptGone).toMatchObject({ ok: false, code: "REFERENCE_RECEIPT_REJECTED" });

    // A failed/ambiguous cleanup consumes the receipt before dispatch, so a
    // later call cannot reuse that opaque handle.
    const failingCleanup = vi.fn(async () => {
      throw new Error("remote acknowledgement was ambiguous");
    });
    const failing = service({
      referencePages: {
        createPageFromReference: referenceCreate,
        cleanupCreatedReference: failingCleanup,
      },
    });
    await authorize(failing.service, ["page.reference.clone", "page.reference.cleanup"], [PROJECT]);
    await failing.service.execute("tilda_page_lifecycle", {
      action: "create_from_reference",
      target: PAGE,
      idempotencyKey: "page-lifecycle-ambiguous-create-1",
      dryRun: false,
    });
    const ambiguous = await failing.service.execute("tilda_page_lifecycle", {
      action: "cleanup_reference",
      target: PAGE,
      receiptId: "018f0000-0000-4000-8000-000000000001",
      idempotencyKey: "page-lifecycle-ambiguous-cleanup-1",
      dryRun: false,
    });
    expect(ambiguous).toMatchObject({ ok: false, code: "MCP_OPERATION_FAILED" });
    const blockedRetry = await failing.service.execute("tilda_page_lifecycle", {
      action: "cleanup_reference",
      target: PAGE,
      receiptId: "018f0000-0000-4000-8000-000000000001",
      idempotencyKey: "page-lifecycle-ambiguous-cleanup-1",
      dryRun: false,
    });
    expect(blockedRetry).toMatchObject({ ok: false, code: "REFERENCE_RECEIPT_REJECTED" });
    expect(failingCleanup).toHaveBeenCalledTimes(1);
  });

  it("adds a known template through the injected controller and returns its exact record", async () => {
    const { service: instance, templateAdd } = service();
    await authorize(instance, ["standard.template.add"]);
    const result = await instance.execute("tilda_page_lifecycle", {
      action: "add_known_template",
      target: PAGE,
      templateId: "128",
      idempotencyKey: "page-lifecycle-template-1",
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: true,
      code: "KNOWN_TEMPLATE_ADDED",
      target: {
        kind: "record",
        projectId: PAGE.projectId,
        pageId: PAGE.pageId,
        recordId: "500",
      },
      verification: { templateId: "128", recordType: "128", recordCode: "TL04" },
    });
    expect(templateAdd).toHaveBeenCalledTimes(1);
    expect(templateAdd).toHaveBeenCalledWith(PAGE, "128");
  });

  it("blocks a second transport attempt after an ambiguous structural create", async () => {
    const create = vi.fn(async () => {
      throw new Error("create acknowledgement was ambiguous");
    });
    const { service: instance } = service({
      referencePages: {
        createPageFromReference: create,
        cleanupCreatedReference: vi.fn(),
      },
      knownTemplates: null,
    });
    await authorize(instance, ["page.reference.clone"]);
    const input = {
      action: "create_from_reference",
      target: PAGE,
      idempotencyKey: "page-lifecycle-ambiguous-create-2",
      dryRun: false,
    };
    await expect(instance.execute("tilda_page_lifecycle", input)).resolves.toMatchObject({
      ok: false,
      code: "MCP_OPERATION_FAILED",
    });
    await expect(instance.execute("tilda_page_lifecycle", input)).resolves.toMatchObject({
      ok: false,
      code: "AMBIGUOUS_RETRY_BLOCKED",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
