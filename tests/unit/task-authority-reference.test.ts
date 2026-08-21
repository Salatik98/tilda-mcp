import { describe, expect, it, vi } from "vitest";

import {
  ReferencePageLifecycleController,
  type ReferencePageTransport,
} from "../../src/adapters/reference-page-lifecycle.js";
import { TaskAuthorityManager } from "../../src/core/task-authority-manager.js";
import { TaskScopedReferencePageLifecycleController } from "../../src/core/task-authority-reference.js";
import { hashLiveInventory, type LiveInventory } from "../../src/research/config.js";

const SOURCE = { kind: "page" as const, projectId: "100", pageId: "200" };
const CREATED = { kind: "page" as const, projectId: "100", pageId: "201" };

function fixture(options: { readonly onCleanup?: () => void } = {}) {
  const token = Object.freeze({ kind: "adapter-owned-reference-token" });
  const transport: ReferencePageTransport = {
    createFromReference: vi.fn(async () => ({
      token,
      evidence: {
        source: SOURCE,
        created: CREATED,
        baselinePageIds: [SOURCE.pageId],
        baselinePageOrder: [SOURCE.pageId],
        createdPageIds: [SOURCE.pageId, CREATED.pageId],
        createdPageOrder: [SOURCE.pageId, CREATED.pageId],
        sourceRecordIds: ["300"],
        createdRecordIds: ["301"],
        recordFamilyParity: true as const,
        createdUnpublished: true as const,
      },
    })),
    cleanupCreatedReference: vi.fn(async (received) => {
      expect(received).toBe(token);
      options.onCleanup?.();
      return {
        source: SOURCE,
        removedPageId: CREATED.pageId,
        activePageIds: [SOURCE.pageId],
        pageOrder: [SOURCE.pageId],
        removedPageAbsent: true as const,
        sourceRecordIds: ["300"],
      };
    }),
  };
  const inventory: LiveInventory = {
    accountFingerprint: "a".repeat(64),
    projectIds: [SOURCE.projectId],
    pageOwnership: { [SOURCE.projectId]: [SOURCE.pageId] },
  };
  const authority = new TaskAuthorityManager({
    now: () => new Date("2026-08-20T04:00:00.000Z"),
    createTaskId: () => "018f0000-0000-7000-8000-000000000001",
  });
  const initial = authority.mint({
    taskDescription: "Create one exact reference copy, operate on it, then clean it up",
    mode: "production",
    observeTargets: [],
    writeTargets: [{ kind: "project", projectId: SOURCE.projectId }],
    allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
    binding: {
      accountFingerprint: inventory.accountFingerprint,
      inventoryHash: hashLiveInventory(inventory),
    },
    inventory,
    ttlMs: 60_000,
  });
  const scoped = new TaskScopedReferencePageLifecycleController(
    new ReferencePageLifecycleController(transport),
    authority,
  );
  return { authority, initial, scoped, transport };
}

describe("task-scoped reference page inventory lineage", () => {
  it("keeps one stable task/grant lineage across verified create and cleanup receipts", async () => {
    const { authority, initial, scoped, transport } = fixture();
    const created = await scoped.createPageFromReference(SOURCE);

    expect(authority.currentReceipt()).toMatchObject({
      taskId: initial.taskId,
      grantHash: initial.grantHash,
      inventoryHash: expect.not.stringMatching(initial.inventoryHash),
    });
    expect(() => authority.requireGuard().assertRead(CREATED)).not.toThrow();
    await expect(scoped.createPageFromReference(SOURCE)).rejects.toMatchObject({
      code: "TASK_INVENTORY_LINEAGE_BUSY",
    });
    expect(transport.createFromReference).toHaveBeenCalledTimes(1);

    await expect(scoped.cleanupCreatedReference(created.receipt)).resolves.toMatchObject({
      removedPageId: CREATED.pageId,
      removedPageAbsent: true,
    });
    expect(authority.currentReceipt()).toMatchObject({
      taskId: initial.taskId,
      grantHash: initial.grantHash,
      inventoryHash: initial.inventoryHash,
    });
    expect(transport.createFromReference).toHaveBeenCalledTimes(1);
    expect(transport.cleanupCreatedReference).toHaveBeenCalledTimes(1);
    await expect(scoped.cleanupCreatedReference(created.receipt)).rejects.toMatchObject({
      code: "TASK_INVENTORY_LINEAGE_MISMATCH",
    });
  });

  it("blocks clear, close, and replacement until the pending clone is cleaned up", async () => {
    const { authority, scoped, transport } = fixture();
    const created = await scoped.createPageFromReference(SOURCE);
    const current = authority.currentReceipt()!;
    const inventory: LiveInventory = {
      accountFingerprint: current.accountFingerprint,
      projectIds: [SOURCE.projectId],
      pageOwnership: { [SOURCE.projectId]: [SOURCE.pageId, CREATED.pageId] },
    };
    expect(() => authority.replace({
      taskDescription: "A different exact task",
      mode: "production",
      observeTargets: [],
      writeTargets: [{ kind: "project", projectId: SOURCE.projectId }],
      allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
      binding: {
        accountFingerprint: inventory.accountFingerprint,
        inventoryHash: hashLiveInventory(inventory),
      },
      inventory,
      ttlMs: 60_000,
    })).toThrow(expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }));
    expect(() => authority.clear()).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }),
    );
    expect(() => authority.close()).toThrow(
      expect.objectContaining({ code: "TASK_INVENTORY_LINEAGE_BUSY" }),
    );
    expect(authority.currentReceipt()).toEqual(current);

    await expect(scoped.cleanupCreatedReference(created.receipt)).resolves.toMatchObject({
      removedPageId: CREATED.pageId,
    });
    expect(transport.cleanupCreatedReference).toHaveBeenCalledTimes(1);
    expect(authority.close()).toBe(true);
  });

  it("does not rebind a replacement task that appears while clone transport is awaiting", async () => {
    const baseline: LiveInventory = {
      accountFingerprint: "a".repeat(64),
      projectIds: [SOURCE.projectId],
      pageOwnership: { [SOURCE.projectId]: [SOURCE.pageId] },
    };
    const afterCreate: LiveInventory = {
      ...baseline,
      pageOwnership: { [SOURCE.projectId]: [SOURCE.pageId, CREATED.pageId] },
    };
    let id = 0;
    const authority = new TaskAuthorityManager({
      now: () => new Date("2026-08-20T04:00:00.000Z"),
      createTaskId: () => [
        "018f0000-0000-7000-8000-000000000001",
        "018f0000-0000-7000-8000-000000000002",
      ][id++]!,
    });
    const initial = authority.mint({
      taskDescription: "first reference task",
      mode: "production",
      observeTargets: [],
      writeTargets: [{ kind: "project", projectId: SOURCE.projectId }],
      allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
      binding: {
        accountFingerprint: baseline.accountFingerprint,
        inventoryHash: hashLiveInventory(baseline),
      },
      inventory: baseline,
      ttlMs: 60_000,
    });
    let replacementError: unknown;
    let clearError: unknown;
    let closeError: unknown;
    const transport: ReferencePageTransport = {
      createFromReference: vi.fn(async () => {
        try {
          authority.clear();
        } catch (error) {
          clearError = error;
        }
        try {
          authority.close();
        } catch (error) {
          closeError = error;
        }
        try {
          authority.replace({
            taskDescription: "replacement task during create",
            mode: "production",
            observeTargets: [],
            writeTargets: [{ kind: "project", projectId: SOURCE.projectId }],
            allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
            binding: {
              accountFingerprint: afterCreate.accountFingerprint,
              inventoryHash: hashLiveInventory(afterCreate),
            },
            inventory: afterCreate,
            ttlMs: 60_000,
          });
        } catch (error) {
          replacementError = error;
        }
        return {
          token: Object.freeze({}),
          evidence: {
            source: SOURCE,
            created: CREATED,
            baselinePageIds: [SOURCE.pageId],
            baselinePageOrder: [SOURCE.pageId],
            createdPageIds: [SOURCE.pageId, CREATED.pageId],
            createdPageOrder: [SOURCE.pageId, CREATED.pageId],
            sourceRecordIds: ["300"],
            createdRecordIds: ["301"],
            recordFamilyParity: true as const,
            createdUnpublished: true as const,
          },
        };
      }),
      cleanupCreatedReference: vi.fn(),
    };
    const scoped = new TaskScopedReferencePageLifecycleController(
      new ReferencePageLifecycleController(transport),
      authority,
    );

    await expect(scoped.createPageFromReference(SOURCE)).resolves.toMatchObject({
      receipt: { created: CREATED },
    });
    expect(clearError).toMatchObject({ code: "TASK_INVENTORY_LINEAGE_BUSY" });
    expect(closeError).toMatchObject({ code: "TASK_INVENTORY_LINEAGE_BUSY" });
    expect(replacementError).toMatchObject({ code: "TASK_INVENTORY_LINEAGE_BUSY" });
    expect(authority.currentReceipt()).toMatchObject({
      taskId: initial.taskId,
      grantHash: initial.grantHash,
    });
  });

  it("does not rebind a replacement task that appears while cleanup transport is awaiting", async () => {
    let replaceDuringCleanup = () => undefined;
    const { authority, scoped } = fixture({ onCleanup: () => replaceDuringCleanup() });
    const created = await scoped.createPageFromReference(SOURCE);
    const baseline: LiveInventory = {
      accountFingerprint: "a".repeat(64),
      projectIds: [SOURCE.projectId],
      pageOwnership: { [SOURCE.projectId]: [SOURCE.pageId] },
    };
    const initial = authority.currentReceipt();
    let replacementError: unknown;
    let clearError: unknown;
    let closeError: unknown;
    replaceDuringCleanup = () => {
      try {
        authority.clear();
      } catch (error) {
        clearError = error;
      }
      try {
        authority.close();
      } catch (error) {
        closeError = error;
      }
      try {
        authority.replace({
          taskDescription: "replacement task during cleanup",
          mode: "production",
          observeTargets: [],
          writeTargets: [{ kind: "project", projectId: SOURCE.projectId }],
          allowedOperations: ["page.reference.clone", "page.reference.cleanup"],
          binding: {
            accountFingerprint: baseline.accountFingerprint,
            inventoryHash: hashLiveInventory(baseline),
          },
          inventory: baseline,
          ttlMs: 60_000,
        });
      } catch (error) {
        replacementError = error;
      }
    };

    await expect(scoped.cleanupCreatedReference(created.receipt)).resolves.toMatchObject({
      removedPageId: CREATED.pageId,
    });
    expect(clearError).toMatchObject({ code: "TASK_INVENTORY_LINEAGE_BUSY" });
    expect(closeError).toMatchObject({ code: "TASK_INVENTORY_LINEAGE_BUSY" });
    expect(replacementError).toMatchObject({ code: "TASK_INVENTORY_LINEAGE_BUSY" });
    expect(authority.currentReceipt()).toMatchObject({
      taskId: initial?.taskId,
      grantHash: initial?.grantHash,
    });
  });
});
