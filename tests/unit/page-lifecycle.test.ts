import { describe, expect, it, vi } from "vitest";
import {
  PageLifecycleController,
  type PageLifecycleBaselineEvidence,
  type PageLifecycleRestoredEvidence,
  type PageLifecycleTransport,
} from "../../src/adapters/page-lifecycle.js";
import type { PageTarget } from "../../src/core/contracts.js";

const source: PageTarget = {
  kind: "page",
  projectId: "9101",
  pageId: "9201",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function baseline(): PageLifecycleBaselineEvidence {
  return {
    source,
    activePageIds: [source.pageId],
    pageOrder: [source.pageId],
    sourceRecordIds: ["9301"],
    sourcePublished: false,
    sourceChanged: "0",
  };
}

function restored(
  overrides: Partial<PageLifecycleRestoredEvidence> = {},
): PageLifecycleRestoredEvidence {
  return {
    source,
    activePageIds: [source.pageId],
    pageOrder: [source.pageId],
    sourceRecordIds: ["9301"],
    sourcePublished: false,
    sourceChanged: "0",
    temporaryPageId: "9204",
    temporaryPageAbsent: true,
    pageOrderRestored: true,
    sourceUnchanged: true,
    exactBaselineRestored: true,
    ...overrides,
  };
}

function controllerFor(
  evidence: { readonly baseline: PageLifecycleBaselineEvidence; readonly restored: PageLifecycleRestoredEvidence },
): { readonly controller: PageLifecycleController; readonly transaction: ReturnType<typeof vi.fn> } {
  const transaction = vi.fn(async (target: PageTarget) => {
    expect(target).toEqual(source);
    return evidence;
  });
  const transport: PageLifecycleTransport = {
    duplicateVerifyReorderRestoreCleanup: transaction,
  };
  return { controller: new PageLifecycleController(transport), transaction };
}

describe("PageLifecycleController", () => {
  it("keeps dry-run local and returns ChangeSet/snapshot-shaped identifiers", async () => {
    const { controller, transaction } = controllerFor({ baseline: baseline(), restored: restored() });

    const result = await controller.execute({
      target: source,
      idempotencyKey: "page-lifecycle-dry-run-1",
    });

    expect(result).toMatchObject({
      dryRun: true,
      stateChanged: false,
      baseline: null,
      restored: null,
    });
    expect(result.changeSetId).toMatch(UUID);
    expect(result.snapshotId).toMatch(UUID);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("executes only the opaque fixed transaction once for an idempotent replay", async () => {
    const { controller, transaction } = controllerFor({ baseline: baseline(), restored: restored() });
    const request = {
      target: source,
      idempotencyKey: "page-lifecycle-restore-1",
      dryRun: false,
    };

    const first = await controller.execute(request);
    const replay = await controller.execute(request);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(replay).toBe(first);
    expect(first).toMatchObject({
      dryRun: false,
      stateChanged: false,
      baseline: baseline(),
      restored: restored(),
    });
    await expect(controller.execute({
      target: { ...source, pageId: "9205" },
      idempotencyKey: request.idempotencyKey,
      dryRun: false,
    })).rejects.toMatchObject({ code: "LIFECYCLE_TARGET_MISMATCH" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not overlap distinct lifecycle keys for the same exact source page", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transaction = vi.fn(async (_target: PageTarget) => {
      await gate;
      return { baseline: baseline(), restored: restored() };
    });
    const controller = new PageLifecycleController({
      duplicateVerifyReorderRestoreCleanup: transaction,
    });
    const first = controller.execute({
      target: source,
      idempotencyKey: "page-lifecycle-concurrent-1",
      dryRun: false,
    });

    await expect(controller.execute({
      target: source,
      idempotencyKey: "page-lifecycle-concurrent-2",
      dryRun: false,
    })).rejects.toMatchObject({ code: "LIFECYCLE_TARGET_BUSY" });
    release();
    await first;
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects retained temporary pages and blocks an ambiguous same-key retry", async () => {
    const unsafe = restored({ activePageIds: [source.pageId, "9204"] });
    const { controller, transaction } = controllerFor({ baseline: baseline(), restored: unsafe });
    const request = {
      target: source,
      idempotencyKey: "page-lifecycle-unsafe-1",
      dryRun: false,
    };

    await expect(controller.execute(request)).rejects.toMatchObject({
      code: "LIFECYCLE_RESTORE_UNVERIFIED",
    });
    await expect(controller.execute(request)).rejects.toMatchObject({
      code: "LIFECYCLE_RETRY_BLOCKED",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
