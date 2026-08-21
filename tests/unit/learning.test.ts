import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExactTarget } from "../../src/core/contracts.js";
import { TypedAuditRunner } from "../../src/learning/audit.js";
import type {
  AuditRequest,
  AuditReport,
  CapabilityLearningExecutionAuthority,
  CapabilityLearningSession,
  LearningPhase,
  LearningStepEvidence,
} from "../../src/learning/contracts.js";
import { InMemoryCapabilityRecipeRegistry } from "../../src/learning/registry.js";
import { FileCapabilityLearningExecutionJournal } from "../../src/learning/journal.js";
import { CapabilityLearningWorkflow } from "../../src/learning/workflow.js";

const target: ExactTarget = {
  kind: "record",
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};

const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const lineage = {
  taskId: "123e4567-e89b-42d3-a456-426614174000",
  grantHash: hash("f"),
};

function authority() {
  const release = vi.fn();
  const value: CapabilityLearningExecutionAuthority = {
    receipt: vi.fn(() => lineage),
    assertCopyTestWrite: vi.fn(),
    beginTaskExecution: vi.fn(() => ({ kind: "task-execution-lease" as const, release })),
  };
  return { value, release };
}

function step(
  phase: LearningPhase,
  stateHash: string,
  changedPaths: readonly string[],
): LearningStepEvidence {
  return {
    phase,
    target,
    targetRole: "test-object",
    stateHash,
    changedPaths,
    trace: {
      phase,
      traceId: `trace-${phase}-01`,
      channels: ["dom", "runtime", "network"],
      eventCount: 3,
      digest: hash(phase === "before" ? "a" : phase === "after" ? "b" : phase === "replay" ? "c" : "d"),
    },
  };
}

function session(overrides: Partial<Record<"after" | "replay" | "restore", LearningStepEvidence>> = {}) {
  const calls: string[] = [];
  const value: CapabilityLearningSession = {
    adapterId: "typed-test-adapter",
    transport: "authenticated_request",
    captureBefore: vi.fn(async () => {
      calls.push("before");
      return step("before", hash("a"), []);
    }),
    performTestAction: vi.fn(async () => {
      calls.push("after");
      return overrides.after ?? step("after", hash("b"), ["content.title"]);
    }),
    replayRecipe: vi.fn(async () => {
      calls.push("replay");
      return overrides.replay ?? step("replay", hash("b"), ["content.title"]);
    }),
    restoreBaseline: vi.fn(async () => {
      calls.push("restore");
      return overrides.restore ?? step("restore", hash("a"), []);
    }),
  };
  return { value, calls };
}

function request(overrides: Partial<Parameters<CapabilityLearningWorkflow["learn"]>[0]> = {}) {
  return {
    mode: "copy-test" as const,
    target,
    targetRole: "test-object" as const,
    capability: "standard.block.clone",
    family: "standard" as const,
    action: "clone" as const,
    dryRun: false,
    idempotencyKey: "learning-test-idempotency-1",
    ...overrides,
  };
}

describe("copy-test capability learning", () => {
  it("runs before → after → replay → restore and registers only sanitized recipe evidence", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-workflow-"));
    const testSession = session();
    const provider = { open: vi.fn(async () => testSession.value) };
    const registry = new InMemoryCapabilityRecipeRegistry();
    const workflow = new CapabilityLearningWorkflow({
      provider,
      registry,
      journal: new FileCapabilityLearningExecutionJournal(join(runtimeRoot, "executions"), runtimeRoot),
      now: () => "2026-08-20T00:00:00.000Z",
      createRecipeId: () => "recipe-test-0001",
    });

    const task = authority();
    const result = await workflow.learn(request(), task.value);

    expect(result).toMatchObject({ ok: true, code: "LEARNING_REGISTERED", stateChanged: false });
    expect(testSession.calls).toEqual(["before", "after", "replay", "restore"]);
    expect(provider.open).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
    expect(result.recipe).toMatchObject({
      format: "tilda-capability-recipe-v1",
      recipeId: "recipe-test-0001",
      capability: "standard.block.clone",
      beforeHash: hash("a"),
      afterHash: hash("b"),
      replayHash: hash("b"),
      restoredHash: hash("a"),
      changedPaths: ["content.title"],
    });
    expect(JSON.stringify(result.recipe)).not.toContain("javascript:");
    expect(JSON.stringify(result.recipe)).not.toContain("https://");
    expect(task.value.beginTaskExecution).toHaveBeenCalledTimes(1);
    expect(vi.mocked(task.value.receipt).mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(task.release).toHaveBeenCalledTimes(1);
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("restores after a replay mismatch and refuses recipe registration", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-workflow-"));
    const testSession = session({ replay: step("replay", hash("c"), ["content.title"]) });
    const registry = new InMemoryCapabilityRecipeRegistry();
    const workflow = new CapabilityLearningWorkflow({
      provider: { open: vi.fn(async () => testSession.value) },
      registry,
      journal: new FileCapabilityLearningExecutionJournal(join(runtimeRoot, "executions"), runtimeRoot),
    });

    const task = authority();
    const result = await workflow.learn(request(), task.value);

    expect(result).toMatchObject({ ok: false, code: "LEARNING_REPLAY_MISMATCH", stateChanged: false });
    expect(testSession.calls).toEqual(["before", "after", "replay", "restore"]);
    expect(registry.list()).toHaveLength(0);
    expect(task.release).toHaveBeenCalledTimes(1);
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("quarantines the exact capability-target when task lineage cannot be reasserted after a mutation phase", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-workflow-"));
    try {
      let revoked = false;
      const revokedError = () => Object.assign(new Error("revoked"), { code: "TASK_AUTHORITY_REVOKED" });
      const testSession = session();
      vi.mocked(testSession.value.performTestAction).mockImplementation(async () => {
        testSession.calls.push("after");
        revoked = true;
        return step("after", hash("b"), ["content.title"]);
      });
      const provider = { open: vi.fn(async () => testSession.value) };
      const journal = new FileCapabilityLearningExecutionJournal(join(runtimeRoot, "executions"), runtimeRoot);
      const workflow = new CapabilityLearningWorkflow({
        provider,
        registry: new InMemoryCapabilityRecipeRegistry(),
        journal,
      });
      const release = vi.fn();
      const unstable: CapabilityLearningExecutionAuthority = {
        receipt: () => {
          if (revoked) throw revokedError();
          return lineage;
        },
        assertCopyTestWrite: () => {
          if (revoked) throw revokedError();
        },
        beginTaskExecution: () => ({ kind: "task-execution-lease", release }),
      };

      await expect(workflow.learn(request({ idempotencyKey: "learning-revoked-key" }), unstable)).resolves.toMatchObject({
        ok: false,
        code: "LEARNING_RESTORE_FAILED",
        stateChanged: true,
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(testSession.value.restoreBaseline).not.toHaveBeenCalled();

      revoked = false;
      const stable = authority();
      await expect(workflow.learn(request({ idempotencyKey: "learning-after-revoked" }), stable.value)).resolves.toMatchObject({
        ok: false,
        code: "LEARNING_TARGET_QUARANTINED",
        stateChanged: false,
      });
      expect(provider.open).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("records a restore hash mismatch as ambiguous rather than a safely restored failure", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-workflow-"));
    try {
      const testSession = session({ restore: step("restore", hash("c"), []) });
      const provider = { open: vi.fn(async () => testSession.value) };
      const workflow = new CapabilityLearningWorkflow({
        provider,
        registry: new InMemoryCapabilityRecipeRegistry(),
        journal: new FileCapabilityLearningExecutionJournal(join(runtimeRoot, "executions"), runtimeRoot),
      });
      const task = authority();
      await expect(workflow.learn(request({ idempotencyKey: "learning-restore-mismatch" }), task.value)).resolves.toMatchObject({
        ok: false,
        code: "LEARNING_RESTORE_FAILED",
        stateChanged: true,
      });
      expect(testSession.value.restoreBaseline).toHaveBeenCalledTimes(2);

      const next = authority();
      await expect(workflow.learn(request({
        idempotencyKey: "learning-after-restore-mismatch",
        capability: "standard.block.configure",
        action: "configure",
      }), next.value)).resolves.toMatchObject({
        ok: false,
        code: "LEARNING_TARGET_QUARANTINED",
      });
      expect(provider.open).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("is dry-run by default and fails closed without a concrete provider", async () => {
    const registry = new InMemoryCapabilityRecipeRegistry();
    const workflow = new CapabilityLearningWorkflow({ provider: null, registry });

    await expect(workflow.learn(request({ dryRun: true }))).resolves.toMatchObject({
      ok: true,
      code: "LEARNING_PLAN_READY",
      stateChanged: false,
    });
    await expect(workflow.learn(request())).resolves.toMatchObject({
      ok: false,
      code: "LEARNING_PROVIDER_UNAVAILABLE",
      stateChanged: false,
    });
  });
});

describe("typed Tilda audit", () => {
  it("returns content-free provider findings without permitting writes", async () => {
    const request: AuditRequest = { target, checks: ["identity", "structure", "capability"] };
    const report: AuditReport = {
      format: "tilda-audit-v1",
      target,
      status: "PASS",
      checks: request.checks,
      findings: [{ code: "identity.ok", severity: "info", summary: "Exact target identity matched." }],
      adapter: "typed-audit-v1",
      observedAt: "2026-08-20T00:00:00.000Z",
    };
    const runner = new TypedAuditRunner({ audit: vi.fn(async () => report) });

    await expect(runner.run(request)).resolves.toMatchObject({ ok: true, code: "AUDIT_OK", report });
  });

  it("blocks cleanly when no read-only audit seam is connected", async () => {
    const runner = new TypedAuditRunner(null);
    await expect(runner.run({ target, checks: ["identity"] })).resolves.toMatchObject({
      ok: false,
      code: "AUDIT_PROVIDER_UNAVAILABLE",
      blockedReasons: ["AUDIT_PROVIDER_UNAVAILABLE"],
    });
  });
});
