import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalHash } from "../../src/research/hash.js";
import type {
  AdapterRegistry,
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ExactTarget,
  PlannedMutation,
  StandardFieldPatch,
} from "../../src/core/contracts.js";
import { TildaEngineError } from "../../src/core/contracts.js";
import { TildaChangeSetEngine } from "../../src/core/engine.js";
import { ChangeSetStore } from "../../src/core/store.js";
import {
  TaskAuthorityManager,
  type MintTaskAuthorityInput,
} from "../../src/core/task-authority-manager.js";
import { TaskScopedChangeSetEngine } from "../../src/core/task-authority.js";
import { VolatileSnapshotVault } from "../../src/core/vault.js";

const target = {
  kind: "record" as const,
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};

const request: StandardFieldPatch = {
  operation: "standard.field.patch",
  target,
  expectedIdentity: { recordType: "128", recordCode: "TL04" },
  field: "title",
  value: "after",
};

function state(value: string): AdapterState {
  const payload = { value };
  return {
    hash: canonicalHash(payload),
    payload,
    revision: "revision-1",
    summary: `state-${value}`,
  };
}

class AdversarialAdapter implements ChangeAdapter {
  readonly id = "test-adapter-v1";
  readonly capabilities = ["standard.field.patch"] as const;
  current = state("before");
  applyCalls = 0;
  restoreCalls = 0;
  applyMode: "success" | "throw-before" | "throw-after" | "head-ambiguous" = "success";
  restoreMode: "success" | "throw-before" | "throw-after" | "head-ambiguous" = "success";
  afterRead: (() => void) | undefined;

  supports(candidate: ChangeRequest): boolean {
    return candidate.operation === "standard.field.patch";
  }

  async read(_target: ExactTarget): Promise<AdapterState> {
    const result = structuredClone(this.current);
    this.afterRead?.();
    return result;
  }

  plan(before: AdapterState, candidate: ChangeRequest): PlannedMutation {
    const intendedState = state((candidate as StandardFieldPatch).value);
    return {
      adapter: this.id,
      capability: "standard.field.patch",
      request: candidate,
      expectedBeforeHash: before.hash,
      ...(before.revision === undefined ? {} : { expectedBeforeRevision: before.revision }),
      expectedAfterHash: intendedState.hash,
      intendedState,
      changedPaths: ["record.title"],
      summary: "Patch exact lab title",
    };
  }

  async apply(plan: PlannedMutation): Promise<AdapterState> {
    this.applyCalls += 1;
    if (this.applyMode === "throw-before") throw new Error("dispatch failed before change");
    this.current = structuredClone(plan.intendedState);
    if (this.applyMode === "head-ambiguous") {
      throw new TildaEngineError(
        "HEAD_WRITE_VERIFICATION_AMBIGUOUS",
        "HEAD write reread could not prove the exact transition.",
      );
    }
    if (this.applyMode === "throw-after") throw new Error("acknowledgement lost");
    return structuredClone(this.current);
  }

  async restore(_target: ExactTarget, snapshot: AdapterState): Promise<AdapterState> {
    this.restoreCalls += 1;
    if (this.restoreMode === "throw-before") throw new Error("restore failed before change");
    this.current = structuredClone(snapshot);
    if (this.restoreMode === "head-ambiguous") {
      throw new TildaEngineError(
        "HEAD_RESTORE_VERIFICATION_AMBIGUOUS",
        "HEAD restore reread could not prove the exact restoration.",
      );
    }
    if (this.restoreMode === "throw-after") throw new Error("restore acknowledgement lost");
    return structuredClone(this.current);
  }
}

function registry(adapter: AdversarialAdapter): AdapterRegistry {
  return {
    forRequest: () => adapter,
    byId: () => adapter,
    listCapabilities: () => [{ adapter: adapter.id, capabilities: adapter.capabilities }],
  };
}

let testRoot: string;
let adapter: AdversarialAdapter;
let store: ChangeSetStore;
let engine: TildaChangeSetEngine;

beforeEach(() => {
  testRoot = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "core-engine-test-"));
  adapter = new AdversarialAdapter();
  store = new ChangeSetStore(testRoot);
  engine = new TildaChangeSetEngine(registry(adapter), store, new VolatileSnapshotVault());
});

afterEach(() => {
  if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
});

describe("TildaChangeSetEngine adversarial recovery", () => {
  it("reconciles an apply exception when the diagnostic reread proves success", async () => {
    const planned = await engine.plan(request, { idempotencyKey: "plan-reconcile-1" });
    adapter.applyMode = "throw-after";

    const applied = await engine.apply(planned.changeSet.changeSetId, false, "apply-reconcile-1");
    expect(applied.changeSet).toMatchObject({
      state: "APPLIED",
      reconciliationCode: "APPLY_ERROR_RECONCILED",
    });
    expect(adapter.applyCalls).toBe(1);

    const replay = await engine.apply(
      planned.changeSet.changeSetId,
      false,
      "apply-reconcile-1",
    );
    expect(replay.stateChanged).toBe(false);
    expect(adapter.applyCalls).toBe(1);
    await expect(
      engine.apply(planned.changeSet.changeSetId, false, "apply-different-key"),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it("journals a proven unchanged apply failure and never retries it", async () => {
    const planned = await engine.plan(request);
    adapter.applyMode = "throw-before";

    await expect(
      engine.apply(planned.changeSet.changeSetId, false, "apply-unchanged-1"),
    ).rejects.toMatchObject({ code: "APPLY_FAILED_UNCHANGED" });
    expect(store.loadChangeSet(planned.changeSet.changeSetId)).toMatchObject({
      state: "FAILED",
      failureCode: "APPLY_FAILED_UNCHANGED",
    });
    await expect(
      engine.apply(planned.changeSet.changeSetId, false, "apply-unchanged-2"),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(adapter.applyCalls).toBe(1);
  });

  it("does not reconcile a HEAD apply ambiguity even when the diagnostic hash is expected-after", async () => {
    const planned = await engine.plan(request);
    adapter.applyMode = "head-ambiguous";

    await expect(
      engine.apply(planned.changeSet.changeSetId, false, "apply-head-ambiguous-1"),
    ).rejects.toMatchObject({ code: "APPLY_AMBIGUOUS" });

    const failed = store.loadChangeSet(planned.changeSet.changeSetId);
    expect(failed).toMatchObject({
      state: "FAILED",
      failureCode: "APPLY_AMBIGUOUS",
      appliedHash: planned.changeSet.expectedAfterHash,
      verification: {
        expectedHash: planned.changeSet.expectedAfterHash,
        actualHash: planned.changeSet.expectedAfterHash,
        exactMatch: true,
      },
    });
    expect(failed.state).not.toBe("APPLIED");
    expect(adapter.applyCalls).toBe(1);
    expect(adapter.restoreCalls).toBe(0);
  });

  it("fails closed after restart when volatile plan material is gone", async () => {
    const planned = await engine.plan(request);
    const restarted = new TildaChangeSetEngine(
      registry(adapter),
      new ChangeSetStore(testRoot),
      new VolatileSnapshotVault(),
    );

    await expect(
      restarted.apply(planned.changeSet.changeSetId, false, "restart-apply-1"),
    ).rejects.toMatchObject({ code: "PLAN_MATERIAL_UNAVAILABLE" });
    expect(adapter.applyCalls).toBe(0);
    expect(adapter.current.hash).toBe(state("before").hash);
  });

  it("journals rollback failure and blocks every new retry key", async () => {
    const planned = await engine.plan(request);
    await engine.apply(planned.changeSet.changeSetId, false, "apply-for-rollback-1");
    adapter.restoreMode = "throw-before";

    await expect(
      engine.rollback(planned.changeSet.changeSetId, false, "rollback-failure-1"),
    ).rejects.toMatchObject({ code: "ROLLBACK_FAILED_UNCHANGED" });
    expect(store.loadChangeSet(planned.changeSet.changeSetId)).toMatchObject({
      state: "FAILED",
      failureCode: "ROLLBACK_FAILED_UNCHANGED",
    });
    await expect(
      engine.rollback(planned.changeSet.changeSetId, false, "rollback-failure-2"),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(adapter.restoreCalls).toBe(1);
  });

  it("reconciles a thrown rollback when reread proves exact restoration", async () => {
    const planned = await engine.plan(request);
    await engine.apply(planned.changeSet.changeSetId, false, "apply-for-rollback-2");
    adapter.restoreMode = "throw-after";

    const rolledBack = await engine.rollback(
      planned.changeSet.changeSetId,
      false,
      "rollback-reconcile-1",
    );
    expect(rolledBack.changeSet).toMatchObject({
      state: "ROLLED_BACK",
      reconciliationCode: "ROLLBACK_ERROR_RECONCILED",
    });
    expect(adapter.current.hash).toBe(state("before").hash);
    expect(engine.vault.has(planned.changeSet.changeSetId)).toBe(false);
  });

  it("does not reconcile a HEAD restore ambiguity even when the diagnostic hash is expected-before", async () => {
    const planned = await engine.plan(request);
    await engine.apply(planned.changeSet.changeSetId, false, "apply-before-head-restore-1");
    adapter.restoreMode = "head-ambiguous";

    await expect(
      engine.rollback(planned.changeSet.changeSetId, false, "rollback-head-ambiguous-1"),
    ).rejects.toMatchObject({ code: "ROLLBACK_AMBIGUOUS" });

    const failed = store.loadChangeSet(planned.changeSet.changeSetId);
    expect(failed).toMatchObject({
      state: "FAILED",
      failureCode: "ROLLBACK_AMBIGUOUS",
      verification: {
        expectedHash: planned.changeSet.expectedBeforeHash,
        actualHash: planned.changeSet.expectedBeforeHash,
        exactMatch: true,
      },
    });
    expect(failed.state).not.toBe("ROLLED_BACK");
    expect(adapter.restoreCalls).toBe(1);
  });

  it("persists task authority provenance and includes it in idempotency identity", async () => {
    const firstAuthority = {
      taskId: "018f0000-0000-7000-8000-000000000001",
      grantHash: `sha256:${"a".repeat(64)}`,
    };
    const secondAuthority = {
      taskId: "018f0000-0000-7000-8000-000000000002",
      grantHash: `sha256:${"b".repeat(64)}`,
    };
    const planned = await engine.plan(request, {
      idempotencyKey: "plan-task-authority-1",
      taskAuthority: firstAuthority,
    });

    expect(planned.changeSet.taskAuthority).toEqual(firstAuthority);
    expect(store.loadChangeSet(planned.changeSet.changeSetId).taskAuthority).toEqual(firstAuthority);
    await expect(engine.plan(request, {
      idempotencyKey: "plan-task-authority-1",
      taskAuthority: secondAuthority,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("keeps actual apply and rollback read/dispatch phases under one task lineage", async () => {
    let nextId = 1;
    const authority = new TaskAuthorityManager({
      now: () => new Date("2026-08-20T04:00:00.000Z"),
      createTaskId: () =>
        `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    const binding = {
      accountFingerprint: "a".repeat(64),
      inventoryHash: "b".repeat(64),
    };
    const authorityInput: MintTaskAuthorityInput = {
      taskDescription: "Apply and rollback one exact core ChangeSet",
      mode: "production",
      observeTargets: [],
      writeTargets: [{ kind: "page", projectId: target.projectId, pageId: target.pageId }],
      allowedOperations: ["standard.field.patch"],
      binding,
      ttlMs: 60_000,
    };
    const initial = authority.mint(authorityInput);
    const planned = await engine.plan(request, {
      taskAuthority: { taskId: initial.taskId, grantHash: initial.grantHash },
    });
    const scoped = new TaskScopedChangeSetEngine(engine, authority.requireGuard());
    const transitionErrors: unknown[] = [];
    let phase: "apply" | "rollback" = "apply";
    const observedPhases: string[] = [];
    const attemptedPhases = new Set<string>();
    adapter.afterRead = () => {
      observedPhases.push(`${phase}:read`);
      expect(authority.currentReceipt()).toEqual(initial);
      if (attemptedPhases.has(phase)) return;
      attemptedPhases.add(phase);
      try {
        authority.replace({ ...authorityInput, taskDescription: "replacement task" });
      } catch (error) {
        transitionErrors.push(error);
      }
      try {
        authority.clear();
      } catch (error) {
        transitionErrors.push(error);
      }
      expect(authority.currentReceipt()).toEqual(initial);
    };

    await expect(scoped.apply(
      planned.changeSet.changeSetId,
      false,
      "scoped-apply-1",
    )).resolves.toMatchObject({ changeSet: { state: "APPLIED" } });
    observedPhases.push("apply:dispatched");
    phase = "rollback";
    await expect(scoped.rollback(
      planned.changeSet.changeSetId,
      false,
      "scoped-rollback-1",
    )).resolves.toMatchObject({ changeSet: { state: "ROLLED_BACK" } });
    observedPhases.push("rollback:dispatched");

    expect(observedPhases).toEqual([
      "apply:read",
      "apply:dispatched",
      "rollback:read",
      "rollback:read",
      "rollback:dispatched",
    ]);
    expect(transitionErrors).toHaveLength(4);
    for (const error of transitionErrors) {
      expect(error).toMatchObject({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" });
    }
    expect(authority.currentReceipt()).toEqual(initial);
    expect(adapter.applyCalls).toBe(1);
    expect(adapter.restoreCalls).toBe(1);
    expect(authority.replace({ ...authorityInput, taskDescription: "replacement task" })).toMatchObject({
      taskId: "018f0000-0000-7000-8000-000000000002",
    });
  });
});
