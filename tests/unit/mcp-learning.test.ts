import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PublicationController, PublicPageVerifier } from "../../src/core/publication.js";
import type { TildaChangeSetEngine } from "../../src/core/engine.js";
import type { ResearchConfig } from "../../src/research/config.js";
import { EngineTildaMcpService } from "../../src/mcp/engine-service.js";
import { InMemoryCapabilityRecipeRegistry } from "../../src/learning/registry.js";
import { FileCapabilityLearningExecutionJournal } from "../../src/learning/journal.js";
import { CapabilityLearningWorkflow } from "../../src/learning/workflow.js";
import type {
  CapabilityLearningSession,
  LearningPhase,
  LearningStepEvidence,
} from "../../src/learning/contracts.js";
import { TaskAuthorityManager } from "../../src/core/task-authority-manager.js";
import { hashLiveInventory } from "../../src/research/config.js";
import type { TrustedBindingEstablished } from "../../src/research/inventory.js";

const pageTarget = {
  kind: "page" as const,
  projectId: "9101",
  pageId: "9201",
};

const sourcePage = {
  kind: "page" as const,
  projectId: "10004",
  pageId: "9204",
};

const hash = (letter: string) => `sha256:${letter.repeat(64)}`;

function step(
  phase: LearningPhase,
  stateHash: string,
  changedPaths: readonly string[],
): LearningStepEvidence {
  return {
    phase,
    target: pageTarget,
    targetRole: "test-object",
    stateHash,
    changedPaths,
    trace: {
      phase,
      traceId: `mcp-trace-${phase}`,
      channels: ["dom", "runtime", "network"],
      eventCount: 3,
      digest: hash(phase === "before" ? "a" : phase === "after" ? "b" : phase === "replay" ? "c" : "d"),
    },
  };
}

function liveBinding(): TrustedBindingEstablished {
  const inventory = {
    accountFingerprint: "a".repeat(64),
    projectIds: [pageTarget.projectId, sourcePage.projectId],
    pageOwnership: {
      [pageTarget.projectId]: [pageTarget.pageId],
      [sourcePage.projectId]: [sourcePage.pageId],
    },
  };
  return {
    status: "BOUND",
    capturedAt: "2026-08-20T00:00:00.000Z",
    source: "trusted_same_session_cdp",
    route: "/projects/",
    accountFingerprint: inventory.accountFingerprint,
    inventoryHash: hashLiveInventory(inventory),
    inventory,
    projectCount: 2,
    pageCount: 2,
    captureContext: { cdpTargetId: "target", expiresAt: null },
    privacy: {
      rawAccountIdPersisted: false,
      titlesOrContentPersisted: false,
      cookiesOrSessionDataPersisted: false,
    },
  };
}

function baseService(
  auditProvider: ConstructorParameters<typeof EngineTildaMcpService>[6] = null,
  learningWorkflow: ConstructorParameters<typeof EngineTildaMcpService>[7] = null,
) {
  const engine = {
    capabilities: () => [],
  } as unknown as TildaChangeSetEngine;
  const config = {
    labProjectIds: [pageTarget.projectId],
    labPageTargets: [pageTarget],
    publicTestDomains: ["example.test"],
  } as unknown as ResearchConfig;
  return new EngineTildaMcpService(
    config,
    engine,
    undefined as unknown as PublicationController,
    undefined as unknown as PublicPageVerifier,
    undefined,
    null,
    auditProvider,
    learningWorkflow,
    new TaskAuthorityManager(),
    async () => liveBinding(),
  );
}

async function authorizeCopyTest(mcp: EngineTildaMcpService): Promise<void> {
  const result = await mcp.execute("tilda_authorize_task", {
    taskDescription: "Inspect and learn only on the dedicated copy-test page",
    mode: "copy-test",
    observeTargets: [sourcePage],
    writeTargets: [pageTarget],
    allowedOperations: [],
    ttlMs: 60_000,
  });
  expect(result).toMatchObject({ ok: true, code: "TASK_AUTHORIZED" });
}

describe("MCP audit and learning boundary", () => {
  it("fails closed when the concrete audit and learning seams are absent", async () => {
    const mcp = baseService();
    await authorizeCopyTest(mcp);
    const audit = await mcp.execute("tilda_audit", {
      target: pageTarget,
      checks: ["identity"],
    });
    const learning = await mcp.execute("tilda_learn_capability", {
      mode: "copy-test",
      target: pageTarget,
      targetRole: "test-object",
      capability: "page.block.clone",
      family: "page",
      action: "clone",
      dryRun: false,
      idempotencyKey: "mcp-learning-boundary-1",
    });

    expect(audit).toMatchObject({
      ok: false,
      code: "AUDIT_PROVIDER_UNAVAILABLE",
      stateChanged: false,
      capability: "tilda.audit",
    });
    expect(learning).toMatchObject({
      ok: false,
      code: "LEARNING_PROVIDER_UNAVAILABLE",
      stateChanged: false,
      blockedReasons: ["LEARNING_PROVIDER_UNAVAILABLE"],
    });
  });

  it("never opens a connected learning provider without the durable journal", async () => {
    const provider = { open: vi.fn() };
    const registry = new InMemoryCapabilityRecipeRegistry();
    const learning = new CapabilityLearningWorkflow({ provider, registry });
    const mcp = baseService(null, learning);
    await authorizeCopyTest(mcp);

    const result = await mcp.execute("tilda_learn_capability", {
      mode: "copy-test",
      target: pageTarget,
      targetRole: "test-object",
      capability: "page.block.clone",
      family: "page",
      action: "clone",
      dryRun: false,
      idempotencyKey: "mcp-learning-disabled-1",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "LEARNING_JOURNAL_UNAVAILABLE",
      stateChanged: false,
    });
    expect(provider.open).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  it("executes non-dry learning once under the managed task pin and replays the same durable key without another mutation", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-mcp-learning-"));
    try {
      const testSession: CapabilityLearningSession = {
        adapterId: "typed-mcp-learning-test",
        transport: "authenticated_request",
        captureBefore: vi.fn(async () => step("before", hash("a"), [])),
        performTestAction: vi.fn(async () => step("after", hash("b"), ["page.title"])),
        replayRecipe: vi.fn(async () => step("replay", hash("b"), ["page.title"])),
        restoreBaseline: vi.fn(async () => step("restore", hash("a"), [])),
      };
      const provider = { open: vi.fn(async () => testSession) };
      const registry = new InMemoryCapabilityRecipeRegistry();
      const workflow = new CapabilityLearningWorkflow({
        provider,
        registry,
        journal: new FileCapabilityLearningExecutionJournal(join(runtimeRoot, "executions"), runtimeRoot),
        now: () => "2026-08-20T00:00:00.000Z",
        createRecipeId: () => "recipe-mcp-learning-1",
      });
      const mcp = baseService(null, workflow);
      await authorizeCopyTest(mcp);
      await expect(mcp.execute("tilda_capabilities", {})).resolves.toMatchObject({
        verification: {
          capabilities: expect.arrayContaining([
            expect.objectContaining({
              capability: "mcp.capability.learning",
              status: "AVAILABLE_WITH_FRESH_AUTHORITY",
              executionAvailable: true,
            }),
          ]),
        },
      });
      const input = {
        mode: "copy-test",
        target: pageTarget,
        targetRole: "test-object",
        capability: "page.block.clone",
        family: "page",
        action: "clone",
        dryRun: false,
        idempotencyKey: "mcp-learning-durable-1",
      };

      await expect(mcp.execute("tilda_learn_capability", input)).resolves.toMatchObject({
        ok: true,
        code: "LEARNING_REGISTERED",
        stateChanged: false,
      });
      await expect(mcp.execute("tilda_learn_capability", input)).resolves.toMatchObject({
        ok: true,
        code: "LEARNING_RECIPE_REPLAY",
        stateChanged: false,
      });
      expect(provider.open).toHaveBeenCalledTimes(1);
      expect(testSession.performTestAction).toHaveBeenCalledTimes(1);
      expect(testSession.restoreBaseline).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("reports non-dry capability learning as unavailable", async () => {
    const mcp = baseService();
    const result = await mcp.execute("tilda_capabilities", {});

    expect(result.verification?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: "mcp.capability.learning",
        status: "TRANSPORT_UNAVAILABLE",
        executionAvailable: false,
      }),
    ]));
  });

  it("never routes publication through capability learning", async () => {
    const mcp = baseService();
    const learning = await mcp.execute("tilda_learn_capability", {
      mode: "copy-test",
      target: pageTarget,
      targetRole: "copy",
      capability: "page.publish",
      family: "page",
      action: "publish",
      dryRun: false,
      idempotencyKey: "mcp-learning-publication-1",
    });

    expect(learning).toMatchObject({
      ok: false,
      code: "LEARNING_PUBLICATION_ACTION_BLOCKED",
      stateChanged: false,
    });
  });

  it("routes a typed audit and leaves learning dry-run local", async () => {
    const auditProvider = {
      audit: vi.fn(async (request) => ({
        format: "tilda-audit-v1" as const,
        target: request.target,
        status: "PASS" as const,
        checks: request.checks,
        findings: [],
        adapter: "typed-audit-v1",
        observedAt: "2026-08-20T00:00:00.000Z",
      })),
    };
    const learning = new CapabilityLearningWorkflow({
      provider: null,
      registry: new InMemoryCapabilityRecipeRegistry(),
    });
    const mcp = baseService(auditProvider, learning);
    await authorizeCopyTest(mcp);

    const audit = await mcp.execute("tilda_audit", {
      target: pageTarget,
      checks: ["identity", "structure"],
    });
    const planned = await mcp.execute("tilda_learn_capability", {
      mode: "copy-test",
      target: pageTarget,
      targetRole: "copy",
      capability: "page.block.clone",
      family: "page",
      action: "clone",
      dryRun: true,
    });

    expect(audit).toMatchObject({ ok: true, code: "AUDIT_OK", capability: "tilda.audit" });
    expect(auditProvider.audit).toHaveBeenCalledTimes(1);
    expect(planned).toMatchObject({ ok: true, code: "LEARNING_PLAN_READY", stateChanged: false });
  });
});
