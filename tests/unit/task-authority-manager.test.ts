import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ReferencePageLifecycleController,
  type ReferencePageTransport,
} from "../../src/adapters/reference-page-lifecycle.js";
import { hashLiveInventory, type LiveInventory } from "../../src/research/config.js";
import {
  MAX_TASK_AUTHORITY_TTL_MS,
  MAX_TASK_DESCRIPTION_BYTES,
  TaskAuthorityManager,
  type MintTaskAuthorityInput,
} from "../../src/core/task-authority-manager.js";

const BINDING = {
  accountFingerprint: "a".repeat(64),
  inventoryHash: "b".repeat(64),
};
const PAGE = { kind: "page" as const, projectId: "100", pageId: "200" };
const RECORD = {
  kind: "record" as const,
  projectId: "100",
  pageId: "200",
  recordId: "300",
};

function lineageInventory(pageIds: readonly string[] = [PAGE.pageId]): LiveInventory {
  return {
    accountFingerprint: BINDING.accountFingerprint,
    projectIds: [PAGE.projectId],
    pageOwnership: { [PAGE.projectId]: [...pageIds] },
  };
}

function referenceController() {
  const created = { kind: "page" as const, projectId: PAGE.projectId, pageId: "201" };
  const controller = new ReferencePageLifecycleController({
    createFromReference: async () => ({
      token: Object.freeze({}),
      evidence: {
        source: PAGE,
        created,
        baselinePageIds: [PAGE.pageId],
        baselinePageOrder: [PAGE.pageId],
        createdPageIds: [PAGE.pageId, created.pageId],
        createdPageOrder: [PAGE.pageId, created.pageId],
        sourceRecordIds: ["300"],
        createdRecordIds: ["301"],
        recordFamilyParity: true as const,
        createdUnpublished: true as const,
      },
    }),
    cleanupCreatedReference: async () => ({
      source: PAGE,
      removedPageId: created.pageId,
      activePageIds: [PAGE.pageId],
      pageOrder: [PAGE.pageId],
      removedPageAbsent: true as const,
      sourceRecordIds: ["300"],
    }),
  } satisfies ReferencePageTransport);
  return { controller, created };
}

function input(overrides: Partial<MintTaskAuthorityInput> = {}): MintTaskAuthorityInput {
  return {
    taskDescription: "Измени заголовок на точной странице и проверь результат",
    mode: "production",
    observeTargets: [],
    writeTargets: [PAGE],
    allowedOperations: ["standard.field.patch"],
    binding: BINDING,
    ttlMs: 60_000,
    ...overrides,
  };
}

function manager(clock: { value: number }, ids = [
  "018f0000-0000-7000-8000-000000000001",
  "018f0000-0000-7000-8000-000000000002",
]) {
  let index = 0;
  return new TaskAuthorityManager({
    now: () => new Date(clock.value),
    createTaskId: () => ids[index++]!,
  });
}

describe("TaskAuthorityManager", () => {
  it("mints one in-process guard and retains only a domain-separated task hash", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    const taskDescription = "Production task with a private marker: raw-task-marker";
    const receipt = authority.mint(input({ taskDescription }));
    const expectedHash = `sha256:${createHash("sha256")
      .update("tilda-mcp-task-instruction-v1\0")
      .update(taskDescription, "utf8")
      .digest("hex")}`;

    expect(receipt).toMatchObject({
      taskId: "018f0000-0000-7000-8000-000000000001",
      mode: "production",
      instructionHash: expectedHash,
      expiresAt: "2026-08-20T04:01:00.000Z",
    });
    expect(JSON.stringify(receipt)).not.toContain("raw-task-marker");
    expect(JSON.stringify(authority)).not.toContain("raw-task-marker");
    expect(authority.currentReceipt()).toEqual(receipt);
    expect(() =>
      authority.currentGuard()?.assertChange("standard.field.patch", RECORD),
    ).not.toThrow();
  });

  it("requires explicit replacement and atomically preserves the old guard on invalid input", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    const first = authority.mint(input({ taskDescription: "first task" }));
    const firstGuard = authority.requireGuard();

    expect(() => authority.mint(input({ taskDescription: "second task" }))).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_ALREADY_ACTIVE" }),
    );
    expect(() =>
      authority.replace(input({ taskDescription: "invalid replacement", ttlMs: 30 * 60_000 + 1 })),
    ).toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_TTL_INVALID" }));
    expect(authority.currentReceipt()).toEqual(first);

    const replacement = authority.replace(input({
      taskDescription: "replacement task",
      publication: { actions: ["publish"], targets: [PAGE] },
    }));
    expect(replacement.taskId).toBe("018f0000-0000-7000-8000-000000000002");
    expect(replacement.instructionHash).not.toBe(first.instructionHash);
    expect(authority.currentReceipt()).toEqual(replacement);
    expect(() => authority.requireGuard().assertPublication("publish", PAGE)).not.toThrow();
    expect(() => firstGuard.assertRead(PAGE)).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_REVOKED" }),
    );
  });

  it("keeps clear and replace from crossing an active remote mutation lease", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    authority.mint(input());
    const guard = authority.requireGuard();
    const lease = guard.beginMutationDispatch();

    expect(() => guard.beginMutationDispatch()).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }),
    );
    expect(() => authority.clear()).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }),
    );
    expect(() => authority.replace(input({ taskDescription: "replacement" }))).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }),
    );
    expect(authority.currentGuard()).toBe(guard);

    lease.release();
    lease.release();
    expect(authority.clear()).toBe(true);
    expect(() => guard.beginMutationDispatch()).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_REVOKED" }),
    );
  });

  it("pins one multi-phase task while permitting nested remote dispatch leases", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    authority.mint(input());
    const guard = authority.requireGuard();
    const execution = guard.beginTaskExecution();

    expect(() => guard.beginTaskExecution()).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" }),
    );
    const dispatch = guard.beginMutationDispatch();
    dispatch.release();
    expect(() => authority.clear()).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" }),
    );
    expect(() => authority.replace(input({ taskDescription: "replacement" }))).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" }),
    );
    expect(authority.currentGuard()).toBe(guard);

    execution.release();
    execution.release();
    expect(authority.replace(input({ taskDescription: "replacement" }))).toMatchObject({
      taskId: "018f0000-0000-7000-8000-000000000002",
    });
  });

  it("enforces positive TTLs no longer than thirty minutes", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    expect(() => manager(clock).mint(input({ ttlMs: 0 }))).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_TTL_INVALID" }),
    );
    expect(() => manager(clock).mint(input({ ttlMs: MAX_TASK_AUTHORITY_TTL_MS + 1 }))).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_TTL_INVALID" }),
    );
    const receipt = manager(clock).mint(input({ ttlMs: MAX_TASK_AUTHORITY_TTL_MS }));
    expect(receipt.expiresAt).toBe("2026-08-20T04:30:00.000Z");
  });

  it("bounds the UTF-8 task description before creating authority", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    expect(() => authority.mint(input({ taskDescription: "   " }))).toThrow(
      expect.objectContaining({ code: "TASK_DESCRIPTION_INVALID" }),
    );
    expect(() => authority.mint(input({ taskDescription: "я".repeat(MAX_TASK_DESCRIPTION_BYTES) })))
      .toThrow(expect.objectContaining({ code: "TASK_DESCRIPTION_TOO_LARGE" }));
    expect(authority.currentGuard()).toBeNull();
  });

  it("expires and clears the single active guard without disk state", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    authority.mint(input({ taskDescription: "short task", ttlMs: 1_000 }));
    expect(authority.currentGuard()).not.toBeNull();

    clock.value += 1_000;
    expect(authority.currentGuard()).toBeNull();
    expect(authority.currentReceipt()).toBeNull();
    expect(() => authority.requireGuard()).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_REQUIRED" }),
    );
    expect(authority.clear()).toBe(false);
  });

  it("supports explicit clear and close as idempotent authority boundaries", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    authority.mint(input());
    const clearedGuard = authority.requireGuard();
    expect(authority.clear()).toBe(true);
    expect(() => clearedGuard.assertRead(PAGE)).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_REVOKED" }),
    );
    expect(authority.clear()).toBe(false);
    authority.mint(input({ taskDescription: "new task after clear" }));
    const closedGuard = authority.requireGuard();
    expect(authority.close()).toBe(true);
    expect(() => closedGuard.assertRead(PAGE)).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_REVOKED" }),
    );
    expect(authority.currentGuard()).toBeNull();
  });

  it("advances and restores only one receipt-verified page inventory lineage", async () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    const inventory = lineageInventory();
    const binding = {
      accountFingerprint: inventory.accountFingerprint,
      inventoryHash: hashLiveInventory(inventory),
    };
    const initial = authority.mint(input({
      binding,
      inventory,
      writeTargets: [{ kind: "project", projectId: PAGE.projectId }],
      allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
    }));
    const initialGuard = authority.requireGuard();
    const createLease = authority.beginReferenceInventoryMutation(PAGE);
    expect(() => authority.clear()).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }),
    );
    expect(() => authority.close()).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }),
    );
    expect(authority.currentReceipt()).toEqual(initial);

    const { controller, created } = referenceController();
    const verified = await controller.createPageFromReference(PAGE);
    const createTransition = {
      operation: "page.reference.clone",
      expectedTaskId: initial.taskId,
      expectedGrantHash: initial.grantHash,
      mutationLease: createLease,
      receipt: verified.receipt,
      beforePageIds: [PAGE.pageId],
      afterPageIds: [PAGE.pageId, created.pageId],
    } as const;
    const execution = initialGuard.beginTaskExecution();
    expect(() => authority.acceptVerifiedReferenceInventoryTransition(createTransition)).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" }),
    );
    execution.release();
    const afterCreate = authority.acceptVerifiedReferenceInventoryTransition(createTransition);
    authority.endReferenceInventoryMutation(createLease);
    expect(afterCreate).toMatchObject({
      taskId: initial.taskId,
      grantHash: initial.grantHash,
      accountFingerprint: initial.accountFingerprint,
      expiresAt: initial.expiresAt,
    });
    expect(afterCreate.inventoryHash).not.toBe(initial.inventoryHash);
    expect(() => initialGuard.assertRead(PAGE)).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_REVOKED" }),
    );
    expect(() => authority.requireGuard().assertRead(created)).not.toThrow();
    expect(() => authority.clear()).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }),
    );
    expect(() => authority.close()).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }),
    );
    expect(authority.currentReceipt()).toEqual(afterCreate);

    const cleaned = await controller.cleanupCreatedReference(verified.receipt);
    const cleanupLease = authority.beginReferenceInventoryMutation(PAGE, verified.receipt);
    const afterCleanup = authority.acceptVerifiedReferenceInventoryTransition({
      operation: "page.reference.cleanup",
      expectedTaskId: initial.taskId,
      expectedGrantHash: initial.grantHash,
      mutationLease: cleanupLease,
      receipt: verified.receipt,
      beforePageIds: [PAGE.pageId, created.pageId],
      afterPageIds: cleaned.activePageIds,
    });
    authority.endReferenceInventoryMutation(cleanupLease);
    expect(afterCleanup).toMatchObject({
      taskId: initial.taskId,
      grantHash: initial.grantHash,
      inventoryHash: initial.inventoryHash,
    });
    expect(authority.close()).toBe(true);
  });

  it("does not rebind on an unverified or out-of-scope inventory transition", () => {
    const clock = { value: Date.parse("2026-08-20T04:00:00.000Z") };
    const authority = manager(clock);
    const inventory = lineageInventory();
    const initial = authority.mint(input({
      binding: {
        accountFingerprint: inventory.accountFingerprint,
        inventoryHash: hashLiveInventory(inventory),
      },
      inventory,
      writeTargets: [PAGE],
      allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
    }));
    expect(() => authority.assertReferenceLineageReady(PAGE)).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_SCOPE_DENIED" }),
    );
    expect(authority.currentReceipt()).toEqual(initial);
  });
});
