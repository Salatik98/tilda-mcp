import { describe, expect, it, vi } from "vitest";

import type { ChangeRequest, ChangeSetRecord, PageTarget } from "../../src/core/contracts.js";
import type { TildaChangeSetEngine } from "../../src/core/engine.js";
import type { PublicationController } from "../../src/core/publication.js";
import {
  TaskAuthorityManager,
  type MintTaskAuthorityInput,
} from "../../src/core/task-authority-manager.js";
import {
  TaskAuthorityGuard,
  TaskScopedChangeSetEngine,
  TaskScopedPublicationController,
  type TaskAuthorityGrant,
} from "../../src/core/task-authority.js";

const NOW = "2026-08-20T04:00:00.000Z";
const BINDING = {
  accountFingerprint: "a".repeat(64),
  inventoryHash: "b".repeat(64),
};
const SOURCE_PAGE = { kind: "page" as const, projectId: "100", pageId: "200" };
const DESTINATION_PAGE = { kind: "page" as const, projectId: "100", pageId: "201" };
const DESTINATION_RECORD = {
  kind: "record" as const,
  projectId: "100",
  pageId: "201",
  recordId: "301",
};

function grant(
  fields: Pick<TaskAuthorityGrant, "mode" | "observeTargets" | "writeTargets" | "allowedOperations"> &
    Partial<Pick<TaskAuthorityGrant, "publication">>,
): TaskAuthorityGrant {
  return {
    format: "tilda-mcp-task-authority-v1",
    taskId: "018f0000-0000-7000-8000-000000000001",
    instructionHash: `sha256:${"c".repeat(64)}`,
    issuedAt: "2026-08-20T03:50:00.000Z",
    expiresAt: "2026-08-20T04:20:00.000Z",
    accountBinding: BINDING,
    ...fields,
  };
}

function standardRequest(target = DESTINATION_RECORD): ChangeRequest {
  return {
    operation: "standard.field.patch",
    target,
    expectedIdentity: { recordType: "128", recordCode: "TL04" },
    field: "title",
    value: "new value",
  };
}

describe("TaskAuthorityGuard", () => {
  it("keeps observe mode strictly read-only while allowing scoped descendant reads", () => {
    const authority = new TaskAuthorityGuard(
      grant({
        mode: "observe",
        observeTargets: [{ kind: "project", projectId: "100" }],
        writeTargets: [],
        allowedOperations: [],
      }),
      BINDING,
      { now: NOW },
    );

    expect(() => authority.assertRead(SOURCE_PAGE)).not.toThrow();
    expect(() => authority.assertRead({ kind: "page", projectId: "999", pageId: "1" }))
      .toThrow(expect.objectContaining({ code: "TASK_READ_DENIED" }));
    expect(() => authority.assertRequest(standardRequest()))
      .toThrow(expect.objectContaining({ code: "TASK_WRITE_DENIED" }));
    expect(() => authority.assertPublication("publish", SOURCE_PAGE))
      .toThrow(expect.objectContaining({ code: "TASK_PUBLICATION_DENIED" }));
  });

  it("protects copy-test sources and authorizes only typed writes on disjoint copies", () => {
    const authority = new TaskAuthorityGuard(
      grant({
        mode: "copy-test",
        observeTargets: [SOURCE_PAGE],
        writeTargets: [DESTINATION_PAGE],
        allowedOperations: ["standard.field.patch"],
      }),
      BINDING,
      { now: NOW },
    );

    expect(() => authority.assertRead(SOURCE_PAGE)).not.toThrow();
    expect(() => authority.assertRequest(standardRequest())).not.toThrow();
    expect(() =>
      authority.assertRequest(
        standardRequest({ ...DESTINATION_RECORD, pageId: SOURCE_PAGE.pageId }),
      ),
    ).toThrow(expect.objectContaining({ code: "TASK_WRITE_DENIED" }));
    expect(() => authority.assertChange("page.seo.patch", DESTINATION_PAGE))
      .toThrow(expect.objectContaining({ code: "TASK_OPERATION_DENIED" }));

    expect(() =>
      new TaskAuthorityGuard(
        grant({
          mode: "copy-test",
          observeTargets: [{ kind: "project", projectId: "100" }],
          writeTargets: [DESTINATION_PAGE],
          allowedOperations: ["standard.field.patch"],
        }),
        BINDING,
        { now: NOW },
      ),
    ).toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_SCOPE_OVERLAP" }));
  });

  it("accepts one production task grant and keeps publication as a separate exact action", () => {
    const authority = new TaskAuthorityGuard(
      grant({
        mode: "production",
        observeTargets: [SOURCE_PAGE],
        writeTargets: [DESTINATION_PAGE],
        allowedOperations: ["standard.field.patch"],
        publication: { actions: ["publish"], targets: [DESTINATION_PAGE] },
      }),
      BINDING,
      { now: NOW },
    );

    expect(() => authority.assertRequest(standardRequest())).not.toThrow();
    expect(() =>
      authority.assertRollback("standard.field.patch", DESTINATION_RECORD),
    ).not.toThrow();
    expect(() => authority.assertPublication("publish", DESTINATION_PAGE)).not.toThrow();
    expect(() => authority.assertPublication("unpublish", DESTINATION_PAGE))
      .toThrow(expect.objectContaining({ code: "TASK_PUBLICATION_DENIED" }));

    const receipt = authority.receipt();
    expect(receipt).toMatchObject({
      format: "tilda-mcp-task-authority-receipt-v1",
      mode: "production",
      instructionHash: `sha256:${"c".repeat(64)}`,
      accountFingerprint: BINDING.accountFingerprint,
      inventoryHash: BINDING.inventoryHash,
    });
    expect(receipt.grantHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("new value");
  });

  it("fails closed on stale or mismatched live account inventory binding", () => {
    const production = grant({
      mode: "production",
      observeTargets: [],
      writeTargets: [DESTINATION_PAGE],
      allowedOperations: ["standard.field.patch"],
    });
    expect(() =>
      new TaskAuthorityGuard(
        production,
        { ...BINDING, inventoryHash: "d".repeat(64) },
        { now: NOW },
      ),
    ).toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_BINDING_MISMATCH" }));
    expect(() =>
      new TaskAuthorityGuard(production, BINDING, { now: "2026-08-20T05:00:00.000Z" }),
    ).toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_EXPIRED" }));
  });

  it("rechecks expiry on every assertion and rejects grants longer than thirty minutes", () => {
    let now = Date.parse(NOW);
    const authority = new TaskAuthorityGuard(
      grant({
        mode: "production",
        observeTargets: [],
        writeTargets: [DESTINATION_PAGE],
        allowedOperations: ["standard.field.patch"],
      }),
      BINDING,
      { clock: () => new Date(now).toISOString() },
    );

    expect(() => authority.assertRead(DESTINATION_PAGE)).not.toThrow();
    now = Date.parse("2026-08-20T04:20:00.000Z");
    expect(() => authority.assertRead(DESTINATION_PAGE))
      .toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_EXPIRED" }));

    expect(() => new TaskAuthorityGuard({
      ...grant({
        mode: "production",
        observeTargets: [],
        writeTargets: [DESTINATION_PAGE],
        allowedOperations: ["standard.field.patch"],
      }),
      issuedAt: "2026-08-20T03:00:00.000Z",
    }, BINDING, { now: NOW })).toThrow(
      expect.objectContaining({ code: "TASK_AUTHORITY_TTL_INVALID" }),
    );
  });
});

describe("task-scoped control integration seam", () => {
  it("gates every ChangeSet stage and delegates to the existing engine", async () => {
    const authority = new TaskAuthorityGuard(
      grant({
        mode: "production",
        observeTargets: [],
        writeTargets: [DESTINATION_PAGE],
        allowedOperations: ["standard.field.patch"],
      }),
      BINDING,
      { now: NOW },
    );
    const record = {
      target: DESTINATION_RECORD,
      operation: "standard.field.patch",
      taskAuthority: {
        taskId: authority.receipt().taskId,
        grantHash: authority.receipt().grantHash,
      },
    } as ChangeSetRecord;
    const result = { changeSet: record, stateChanged: false, dryRun: true };
    const engine = {
      capabilities: vi.fn(() => []),
      query: vi.fn(async () => ({ hash: `sha256:${"e".repeat(64)}` })),
      plan: vi.fn(async () => result),
      apply: vi.fn(async () => result),
      verify: vi.fn(async () => result),
      rollback: vi.fn(async () => result),
      store: { loadChangeSet: vi.fn(() => record) },
    } as unknown as TildaChangeSetEngine;
    const scoped = new TaskScopedChangeSetEngine(engine, authority);
    const request = standardRequest();

    await scoped.query(request);
    await scoped.plan(request, { idempotencyKey: "plan" });
    await scoped.apply("change", false, "apply");
    await scoped.verify("change");
    await scoped.rollback("change", false, "rollback");

    expect(engine.query).toHaveBeenCalledWith(request);
    expect(engine.plan).toHaveBeenCalledWith(request, {
      idempotencyKey: "plan",
      taskAuthority: record.taskAuthority,
    });
    expect(engine.apply).toHaveBeenCalledWith("change", false, "apply");
    expect(engine.verify).toHaveBeenCalledWith("change");
    expect(engine.rollback).toHaveBeenCalledWith("change", false, "rollback");
  });

  it("does not call the content or publication write delegates when authority denies", async () => {
    const observe = new TaskAuthorityGuard(
      grant({
        mode: "observe",
        observeTargets: [SOURCE_PAGE],
        writeTargets: [],
        allowedOperations: [],
      }),
      BINDING,
      { now: NOW },
    );
    const plan = vi.fn();
    const content = new TaskScopedChangeSetEngine(
      { plan } as unknown as TildaChangeSetEngine,
      observe,
    );
    await expect(content.plan(standardRequest())).rejects.toMatchObject({ code: "TASK_WRITE_DENIED" });
    expect(plan).not.toHaveBeenCalled();

    const execute = vi.fn();
    const publication = new TaskScopedPublicationController(
      { execute } as unknown as PublicationController,
      observe,
    );
    await expect(
      publication.execute("publish", SOURCE_PAGE, {
        dryRun: false,
        idempotencyKey: "publish",
      }),
    ).rejects.toMatchObject({ code: "TASK_PUBLICATION_DENIED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("delegates an explicitly granted production publish without changing content", async () => {
    const page: PageTarget = DESTINATION_PAGE;
    const authority = new TaskAuthorityGuard(
      grant({
        mode: "production",
        observeTargets: [],
        writeTargets: [page],
        allowedOperations: [],
        publication: { actions: ["publish"], targets: [page] },
      }),
      BINDING,
      { now: NOW },
    );
    const expected = { action: "publish", target: page, dryRun: false };
    const execute = vi.fn(async () => expected);
    const publication = new TaskScopedPublicationController(
      { execute } as unknown as PublicationController,
      authority,
    );

    await expect(
      publication.execute("publish", page, { dryRun: false, idempotencyKey: "publish" }),
    ).resolves.toBe(expected);
    expect(execute).toHaveBeenCalledWith("publish", page, {
      dryRun: false,
      idempotencyKey: "publish",
    });
  });

  it("pins one exact task lineage across non-dry apply and rollback", async () => {
    let nextId = 1;
    const manager = new TaskAuthorityManager({
      now: () => new Date(NOW),
      createTaskId: () =>
        `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    const authorityInput: MintTaskAuthorityInput = {
      taskDescription: "Apply and rollback one exact standard field ChangeSet",
      mode: "production",
      observeTargets: [],
      writeTargets: [DESTINATION_PAGE],
      allowedOperations: ["standard.field.patch"],
      binding: BINDING,
      ttlMs: 60_000,
    };
    const initial = manager.mint(authorityInput);
    const record = {
      target: DESTINATION_RECORD,
      operation: "standard.field.patch",
      taskAuthority: { taskId: initial.taskId, grantHash: initial.grantHash },
    } as ChangeSetRecord;
    const transitionErrors: unknown[] = [];
    const phases: string[] = [];
    const attemptAuthorityTransition = (phase: "apply" | "rollback") => {
      phases.push(`${phase}:read`);
      expect(manager.currentReceipt()).toEqual(initial);
      for (const transition of ["replace", "clear"] as const) {
        try {
          if (transition === "replace") {
            manager.replace({ ...authorityInput, taskDescription: "replacement task" });
          } else {
            manager.clear();
          }
        } catch (error) {
          transitionErrors.push(error);
        }
      }
      expect(manager.currentReceipt()).toEqual(initial);
      phases.push(`${phase}:dispatch`);
    };
    const result = { changeSet: record, stateChanged: true, dryRun: false };
    const engine = {
      apply: vi.fn(async () => {
        attemptAuthorityTransition("apply");
        return result;
      }),
      rollback: vi.fn(async () => {
        attemptAuthorityTransition("rollback");
        return result;
      }),
      store: { loadChangeSet: vi.fn(() => record) },
    } as unknown as TildaChangeSetEngine;
    const scoped = new TaskScopedChangeSetEngine(engine, manager.requireGuard());

    await expect(scoped.apply("change", false, "apply-key")).resolves.toBe(result);
    await expect(scoped.rollback("change", false, "rollback-key")).resolves.toBe(result);
    expect(phases).toEqual([
      "apply:read",
      "apply:dispatch",
      "rollback:read",
      "rollback:dispatch",
    ]);
    expect(transitionErrors).toHaveLength(4);
    for (const error of transitionErrors) {
      expect(error).toMatchObject({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" });
    }
    expect(manager.currentReceipt()).toEqual(initial);
    expect(manager.replace({ ...authorityInput, taskDescription: "replacement task" })).toMatchObject({
      taskId: "018f0000-0000-7000-8000-000000000002",
    });
  });

  it("pins publication and unpublication reconciliation to the exact original task", async () => {
    let nextId = 1;
    const manager = new TaskAuthorityManager({
      now: () => new Date(NOW),
      createTaskId: () =>
        `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    const authorityInput: MintTaskAuthorityInput = {
      taskDescription: "Publish and unpublish one exact page",
      mode: "production",
      observeTargets: [],
      writeTargets: [DESTINATION_PAGE],
      allowedOperations: [],
      publication: {
        actions: ["publish", "unpublish"],
        targets: [DESTINATION_PAGE],
      },
      binding: BINDING,
      ttlMs: 60_000,
    };
    const initial = manager.mint(authorityInput);
    const transitionErrors: unknown[] = [];
    const phases: string[] = [];
    const execute = vi.fn(async (action: "publish" | "unpublish", page: PageTarget) => {
      phases.push(`${action}:read`);
      expect(manager.currentReceipt()).toEqual(initial);
      try {
        manager.replace({ ...authorityInput, taskDescription: "replacement task" });
      } catch (error) {
        transitionErrors.push(error);
      }
      try {
        manager.clear();
      } catch (error) {
        transitionErrors.push(error);
      }
      expect(manager.currentReceipt()).toEqual(initial);
      phases.push(`${action}:dispatch`);
      return { action, target: page, dryRun: false };
    });
    const scoped = new TaskScopedPublicationController(
      { execute } as unknown as PublicationController,
      manager.requireGuard(),
    );

    await expect(scoped.execute("publish", DESTINATION_PAGE, {
      dryRun: false,
      idempotencyKey: "publish-key",
    })).resolves.toMatchObject({ action: "publish", target: DESTINATION_PAGE });
    await expect(scoped.execute("unpublish", DESTINATION_PAGE, {
      dryRun: false,
      idempotencyKey: "unpublish-key",
    })).resolves.toMatchObject({ action: "unpublish", target: DESTINATION_PAGE });
    expect(phases).toEqual([
      "publish:read",
      "publish:dispatch",
      "unpublish:read",
      "unpublish:dispatch",
    ]);
    expect(transitionErrors).toHaveLength(4);
    for (const error of transitionErrors) {
      expect(error).toMatchObject({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" });
    }
    expect(manager.currentReceipt()).toEqual(initial);
  });
});
