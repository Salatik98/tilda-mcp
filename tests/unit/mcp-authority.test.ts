import { describe, expect, it, vi } from "vitest";

import type { ChangeSetRecord, ChangeSetTaskAuthority } from "../../src/core/contracts.js";
import type { TildaChangeSetEngine } from "../../src/core/engine.js";
import type { PublicationController, PublicPageVerifier } from "../../src/core/publication.js";
import { TaskAuthorityManager } from "../../src/core/task-authority-manager.js";
import { EngineTildaMcpService } from "../../src/mcp/engine-service.js";
import type { ResearchConfig } from "../../src/research/config.js";
import { hashLiveInventory } from "../../src/research/config.js";
import type { TrustedBindingEstablished } from "../../src/research/inventory.js";

const PAGE = { kind: "page" as const, projectId: "100", pageId: "200" };
const SOURCE_PAGE = { kind: "page" as const, projectId: "101", pageId: "201" };
const RECORD = {
  kind: "record" as const,
  projectId: "100",
  pageId: "200",
  recordId: "300",
};
const CHANGESET_ID = "018f0000-0000-7000-8000-000000000010";

function binding(inventoryHash?: string): TrustedBindingEstablished {
  const inventory = {
    accountFingerprint: "a".repeat(64),
    projectIds: [PAGE.projectId, SOURCE_PAGE.projectId],
    pageOwnership: {
      [PAGE.projectId]: [PAGE.pageId, "999"],
      [SOURCE_PAGE.projectId]: [SOURCE_PAGE.pageId],
    },
  };
  return {
    status: "BOUND",
    capturedAt: "2026-08-20T04:00:00.000Z",
    source: "trusted_same_session_cdp",
    route: "/projects/",
    accountFingerprint: "a".repeat(64),
    inventoryHash: inventoryHash ?? hashLiveInventory(inventory),
    inventory,
    projectCount: 2,
    pageCount: 3,
    captureContext: { cdpTargetId: "target", expiresAt: null },
    privacy: {
      rawAccountIdPersisted: false,
      titlesOrContentPersisted: false,
      cookiesOrSessionDataPersisted: false,
    },
  };
}

function fixture() {
  const record: ChangeSetRecord = {
    format: "tilda-mcp-changeset-v1" as const,
    changeSetId: CHANGESET_ID,
    snapshotId: "018f0000-0000-7000-8000-000000000011",
    state: "PLANNED" as const,
    createdAt: "2026-08-20T04:00:00.000Z",
    updatedAt: "2026-08-20T04:00:00.000Z",
    adapter: "standard-field-v1",
    capability: "standard.field.patch",
    target: RECORD,
    operation: "standard.field.patch" as const,
    requestHash: `sha256:${"1".repeat(64)}`,
    expectedBeforeHash: `sha256:${"2".repeat(64)}`,
    expectedAfterHash: `sha256:${"3".repeat(64)}`,
    changedPaths: ["title"],
    summary: "planned title patch",
  };
  const actionResult = { changeSet: record, stateChanged: false, dryRun: true };
  const engine = {
    capabilities: vi.fn(() => [
      { adapter: "standard-field-v1", capabilities: ["standard.field.patch"] },
    ]),
    plan: vi.fn(async (
      _request: unknown,
      options: { taskAuthority?: ChangeSetTaskAuthority } = {},
    ) => {
      if (options.taskAuthority === undefined) {
        delete record.taskAuthority;
      } else {
        record.taskAuthority = structuredClone(options.taskAuthority);
      }
      return actionResult;
    }),
    apply: vi.fn(async () => actionResult),
    verify: vi.fn(async () => actionResult),
    rollback: vi.fn(async () => actionResult),
    store: {
      loadChangeSet: vi.fn(() => record),
      loadSnapshot: vi.fn(() => ({
        snapshotId: record.snapshotId,
        target: RECORD,
        adapter: record.adapter,
        stateHash: record.expectedBeforeHash,
        summary: "snapshot",
        createdAt: record.createdAt,
      })),
    },
    vault: { has: vi.fn(() => true) },
  } as unknown as TildaChangeSetEngine;
  const publicationExecute = vi.fn(async (action: "publish" | "unpublish") => ({
    action,
    target: PAGE,
    before: { changed: "revision", published: "", pageUrl: "editor", publicUrl: "public" },
    after: { changed: "revision", published: "published", pageUrl: "editor", publicUrl: "public" },
    stateChanged: true,
    dryRun: false,
  }));
  const publication = { execute: publicationExecute } as unknown as PublicationController;
  const publicVerifier = {
    verify: vi.fn(async () => ({
      ok: true,
      url: "https://test.example/",
      status: 200,
      contentType: "text/html",
      responseBytes: 1,
      responseHash: `sha256:${"4".repeat(64)}`,
      title: "Test",
      canonicalUrl: null,
      recordIds: [],
      cacheBusted: true as const,
    })),
  } as unknown as PublicPageVerifier;
  const manager = new TaskAuthorityManager();
  let liveBinding = binding();
  const capture = vi.fn(async () => liveBinding);
  const config = {
    labProjectIds: [PAGE.projectId],
    readOnlyProjectIds: [SOURCE_PAGE.projectId],
    labPageTargets: [{ projectId: PAGE.projectId, pageId: PAGE.pageId }],
    publicTestDomains: ["test.example"],
  } as unknown as ResearchConfig;
  const service = new EngineTildaMcpService(
    config,
    engine,
    publication,
    publicVerifier,
    undefined,
    null,
    null,
    null,
    manager,
    capture,
  );
  return {
    service,
    engine,
    manager,
    capture,
    publicationExecute,
    setBinding(value: TrustedBindingEstablished) {
      liveBinding = value;
    },
  };
}

function authorization(taskDescription = "Change the exact page and publish it") {
  return {
    taskDescription,
    mode: "production",
    observeTargets: [],
    writeTargets: [PAGE],
    allowedOperations: ["standard.field.patch"],
    publication: { actions: ["publish"], targets: [PAGE] },
    ttlMs: 60_000,
  };
}

function request() {
  return {
    operation: "standard.field.patch",
    target: RECORD,
    expectedIdentity: { recordType: "128", recordCode: "TL04" },
    field: "title",
    value: "Authorized value",
  };
}

describe("MCP task authority integration", () => {
  it("requires authority, returns only a receipt, and gates the complete core lifecycle", async () => {
    const { service, engine, publicationExecute, capture } = fixture();
    await expect(service.execute("tilda_query", {
      query: { kind: "changeset", changeSetId: CHANGESET_ID },
    })).resolves.toMatchObject({ ok: false, code: "TASK_AUTHORITY_REQUIRED" });

    const taskDescription = "Private task marker raw-authority-text";
    const authorized = await service.execute("tilda_authorize_task", authorization(taskDescription));
    expect(authorized).toMatchObject({
      ok: true,
      code: "TASK_AUTHORIZED",
      stateChanged: true,
      capability: "task.authority",
      verification: {
        authority: {
          mode: "production",
          instructionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      },
    });
    expect(JSON.stringify(authorized)).not.toContain("raw-authority-text");

    await expect(service.execute("tilda_query", {
      query: { kind: "changeset", changeSetId: CHANGESET_ID },
    })).resolves.toMatchObject({ ok: true, code: "CHANGESET_READ" });
    await expect(service.execute("tilda_plan_changeset", { request: request() }))
      .resolves.toMatchObject({ ok: true, code: "CHANGESET_PLANNED" });
    await expect(service.execute("tilda_apply_changeset", {
      changeSetId: CHANGESET_ID,
      idempotencyKey: "apply-authority-1",
      dryRun: true,
    })).resolves.toMatchObject({ ok: true, code: "DRY_RUN" });
    await expect(service.execute("tilda_verify_changeset", { changeSetId: CHANGESET_ID }))
      .resolves.toMatchObject({ ok: true });
    await expect(service.execute("tilda_rollback_changeset", {
      changeSetId: CHANGESET_ID,
      idempotencyKey: "rollback-authority-1",
      dryRun: true,
    })).resolves.toMatchObject({ ok: true, code: "DRY_RUN" });
    await expect(service.execute("tilda_publish", {
      target: PAGE,
      idempotencyKey: "publish-authority-1",
      dryRun: false,
    })).resolves.toMatchObject({ ok: true, code: "PAGE_PUBLISHED" });

    expect(engine.plan).toHaveBeenCalledTimes(1);
    expect(engine.apply).toHaveBeenCalledTimes(1);
    expect(engine.verify).toHaveBeenCalledTimes(1);
    expect(engine.rollback).toHaveBeenCalledTimes(1);
    expect(publicationExecute).toHaveBeenCalledTimes(1);
    // The task is bound once. Browser-backed adapters perform their own
    // same-lease freshness proof instead of repeating a second full capture.
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("denies out-of-scope operations and separate publication actions before delegates", async () => {
    const { service, engine, publicationExecute } = fixture();
    await service.execute("tilda_authorize_task", {
      ...authorization(),
      publication: undefined,
    });
    const outside = {
      ...request(),
      target: { ...RECORD, pageId: "201" },
    };
    await expect(service.execute("tilda_plan_changeset", { request: outside }))
      .resolves.toMatchObject({ ok: false, code: "TASK_WRITE_DENIED" });
    await expect(service.execute("tilda_publish", {
      target: PAGE,
      idempotencyKey: "publish-authority-2",
      dryRun: false,
    })).resolves.toMatchObject({ ok: false, code: "TASK_PUBLICATION_DENIED" });
    expect(engine.plan).not.toHaveBeenCalled();
    expect(publicationExecute).not.toHaveBeenCalled();
  });

  it("rejects ChangeSets planned under a replaced task grant", async () => {
    const { service, engine } = fixture();
    await service.execute("tilda_authorize_task", authorization("first exact task"));
    await expect(service.execute("tilda_plan_changeset", { request: request() }))
      .resolves.toMatchObject({ ok: true, code: "CHANGESET_PLANNED" });

    await service.execute("tilda_authorize_task", authorization("replacement exact task"));
    await expect(service.execute("tilda_apply_changeset", {
      changeSetId: CHANGESET_ID,
      idempotencyKey: "apply-replaced-authority-1",
      dryRun: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "TASK_CHANGESET_AUTHORITY_MISMATCH",
    });
    expect(engine.apply).not.toHaveBeenCalled();
  });

  it("requires configured and freshly inventoried provenance for copy-test writes", async () => {
    const { service } = fixture();
    await expect(service.execute("tilda_authorize_task", {
      taskDescription: "test only on an arbitrary existing page",
      mode: "copy-test",
      observeTargets: [],
      writeTargets: [{ kind: "page", projectId: PAGE.projectId, pageId: "999" }],
      allowedOperations: ["standard.field.patch"],
      ttlMs: 60_000,
    })).resolves.toMatchObject({
      ok: false,
      code: "TASK_COPY_PROVENANCE_REQUIRED",
    });

    await expect(service.execute("tilda_authorize_task", {
      taskDescription: "use only the configured disposable lab project",
      mode: "copy-test",
      observeTargets: [SOURCE_PAGE],
      writeTargets: [{ kind: "project", projectId: PAGE.projectId }],
      allowedOperations: ["standard.field.patch"],
      ttlMs: 60_000,
    })).resolves.toMatchObject({
      ok: true,
      code: "TASK_AUTHORIZED",
      verification: { authority: { mode: "copy-test" } },
    });
  });

  it("never grants production write or publication authority to permanent source corpus", async () => {
    const { service, manager } = fixture();
    await expect(service.execute("tilda_authorize_task", {
      taskDescription: "attempt to write a permanent source page",
      mode: "production",
      observeTargets: [],
      writeTargets: [SOURCE_PAGE],
      allowedOperations: ["standard.field.patch"],
      publication: { actions: ["publish"], targets: [SOURCE_PAGE] },
      ttlMs: 60_000,
    })).resolves.toMatchObject({
      ok: false,
      code: "TASK_SOURCE_READ_ONLY",
    });
    expect(manager.currentGuard()).toBeNull();
  });

  it("keeps local journal reads cheap and clears authority when a public read detects binding drift", async () => {
    const { service, manager, setBinding } = fixture();
    await service.execute("tilda_authorize_task", authorization());
    setBinding(binding("c".repeat(64)));

    await expect(service.execute("tilda_query", {
      query: { kind: "changeset", changeSetId: CHANGESET_ID },
    })).resolves.toMatchObject({ ok: true, code: "CHANGESET_READ" });
    await expect(service.execute("tilda_verify_live", {
      target: PAGE,
    })).resolves.toMatchObject({ ok: false, code: "TASK_AUTHORITY_BINDING_MISMATCH" });
    expect(manager.currentGuard()).toBeNull();
    await expect(service.execute("tilda_query", {
      query: { kind: "changeset", changeSetId: CHANGESET_ID },
    })).resolves.toMatchObject({ ok: false, code: "TASK_AUTHORITY_REQUIRED" });
    await expect(service.execute("tilda_page_lifecycle", {
      action: "fixed_roundtrip",
      target: PAGE,
      idempotencyKey: "page-lifecycle-authority-1",
      dryRun: true,
    })).resolves.toMatchObject({ ok: false, code: "TASK_AUTHORITY_REQUIRED" });
  });
});
