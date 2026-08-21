import { randomUUID } from "node:crypto";
import type { ExactTarget } from "../core/contracts.js";
import {
  LEARNING_ACTIONS,
  LEARNING_FAMILIES,
  LEARNING_TARGET_ROLES,
  type CapabilityLearningProvider,
  type CapabilityLearningResult,
  type CapabilityLearningSession,
  type CapabilityLearningExecutionAuthority,
  type CapabilityRecipe,
  type CapabilityRecipeTrace,
  type LearnCapabilityRequest,
  type LearningAction,
  type LearningFamily,
  type LearningPhase,
  type LearningStepEvidence,
  type LearningTargetRole,
  type LearningTaskLineage,
} from "./contracts.js";
import {
  LearningJournalError,
  type CapabilityLearningExecutionJournal,
  type LearningExecutionClaim,
} from "./journal.js";
import type { CapabilityRecipeRegistry } from "./registry.js";

const ID = /^[1-9][0-9]*$/;
const HASH = /^sha256:[0-9a-f]{64}$/i;
const TOKEN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+){1,5}$/;
const TRACE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const REQUIRED_TRACE_CHANNELS = ["dom", "runtime", "network"] as const;
const FAMILY_SET = new Set<string>(LEARNING_FAMILIES);
const ACTION_SET = new Set<string>(LEARNING_ACTIONS);
const ROLE_SET = new Set<string>(LEARNING_TARGET_ROLES);

export class LearningWorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LearningWorkflowError";
    this.code = code;
  }
}

function targetKey(target: ExactTarget): string {
  switch (target.kind) {
    case "project":
      return `project:${target.projectId}`;
    case "page":
      return `page:${target.projectId}:${target.pageId}`;
    case "record":
      return `record:${target.projectId}:${target.pageId}:${target.recordId}`;
    case "element":
      return `element:${target.projectId}:${target.pageId}:${target.recordId}:${target.elementId}`;
  }
}

function sameTarget(left: ExactTarget, right: ExactTarget): boolean {
  return targetKey(left) === targetKey(right);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRequest(request: LearnCapabilityRequest): void {
  if (request.mode !== "copy-test") {
    throw new LearningWorkflowError("LEARNING_MODE_BLOCKED", "Capability learning is limited to copy-test mode.");
  }
  if (!ID.test(request.target.projectId)) {
    throw new LearningWorkflowError("LEARNING_TARGET_INVALID", "Learning target has an invalid project ID.");
  }
  if (request.target.kind !== "project" && !ID.test(request.target.pageId)) {
    throw new LearningWorkflowError("LEARNING_TARGET_INVALID", "Learning target has an invalid page ID.");
  }
  if ((request.target.kind === "record" || request.target.kind === "element") && !ID.test(request.target.recordId)) {
    throw new LearningWorkflowError("LEARNING_TARGET_INVALID", "Learning target has an invalid record ID.");
  }
  if (
    request.target.kind === "element" &&
    (request.target.elementId.length < 1 ||
      request.target.elementId.length > 160 ||
      !/^[A-Za-z0-9_.-]+$/.test(request.target.elementId))
  ) {
    throw new LearningWorkflowError("LEARNING_TARGET_INVALID", "Learning target has an invalid element ID.");
  }
  if (!ROLE_SET.has(request.targetRole)) {
    throw new LearningWorkflowError("LEARNING_TARGET_ROLE_INVALID", "Learning requires a copy or test-object target role.");
  }
  if (!CAPABILITY.test(request.capability) || request.capability.length > 80) {
    throw new LearningWorkflowError("LEARNING_CAPABILITY_INVALID", "Capability must be a bounded dotted identifier.");
  }
  if (!FAMILY_SET.has(request.family)) {
    throw new LearningWorkflowError("LEARNING_FAMILY_INVALID", "Learning family is not supported by the typed workflow.");
  }
  if (!ACTION_SET.has(request.action)) {
    throw new LearningWorkflowError("LEARNING_ACTION_INVALID", "Learning action is not supported by the typed workflow.");
  }
  if (!request.dryRun && (request.idempotencyKey === undefined || request.idempotencyKey.length < 8 || request.idempotencyKey.trim() !== request.idempotencyKey)) {
    throw new LearningWorkflowError("LEARNING_IDEMPOTENCY_REQUIRED", "A trimmed idempotency key is required for a non-dry-run learning action.");
  }
}

function assertStep(
  step: LearningStepEvidence,
  phase: LearningPhase,
  request: LearnCapabilityRequest,
): void {
  if (step.phase !== phase) {
    throw new LearningWorkflowError("LEARNING_TRACE_PHASE_MISMATCH", `Expected a ${phase} trace.`);
  }
  if (!sameTarget(step.target, request.target)) {
    throw new LearningWorkflowError("LEARNING_TARGET_MISMATCH", `${phase} evidence belongs to another exact target.`);
  }
  if (step.targetRole !== request.targetRole) {
    throw new LearningWorkflowError("LEARNING_TARGET_ROLE_MISMATCH", `${phase} evidence is not marked as copy-test.`);
  }
  if (!HASH.test(step.stateHash)) {
    throw new LearningWorkflowError("LEARNING_STATE_HASH_INVALID", `${phase} state hash is invalid.`);
  }
  if (step.changedPaths.some((path) => path.length < 1 || path.length > 160 || !/^[A-Za-z0-9_.[\]-]+$/.test(path))) {
    throw new LearningWorkflowError("LEARNING_PATH_INVALID", `${phase} changed paths are not content-free safe paths.`);
  }
  if (step.trace.phase !== phase || !TRACE_ID.test(step.trace.traceId) || !HASH.test(step.trace.digest)) {
    throw new LearningWorkflowError("LEARNING_TRACE_INVALID", `${phase} trace receipt is invalid.`);
  }
  if (!Number.isSafeInteger(step.trace.eventCount) || step.trace.eventCount < 1 || step.trace.eventCount > 100_000) {
    throw new LearningWorkflowError("LEARNING_TRACE_INVALID", `${phase} trace event count is invalid.`);
  }
  for (const channel of REQUIRED_TRACE_CHANNELS) {
    if (!step.trace.channels.includes(channel)) {
      throw new LearningWorkflowError("LEARNING_TRACE_INCOMPLETE", `${phase} trace lacks a required evidence channel.`);
    }
  }
}

function assertSession(session: CapabilityLearningSession): void {
  if (!TOKEN.test(session.adapterId) || session.adapterId.length > 96) {
    throw new LearningWorkflowError("LEARNING_ADAPTER_INVALID", "Learning adapter ID is not a safe token.");
  }
  if (!session.transport) {
    throw new LearningWorkflowError("LEARNING_TRANSPORT_INVALID", "Learning transport is not declared.");
  }
}

function safeProviderFailure(error: unknown): LearningWorkflowError {
  if (error instanceof LearningWorkflowError) return error;
  if (error instanceof LearningJournalError) {
    return new LearningWorkflowError(error.code, error.message);
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,95}$/u.test(code)) {
    return new LearningWorkflowError(
      code,
      "The bounded learning execution was rejected by a typed authority or adapter guard.",
    );
  }
  return new LearningWorkflowError(
    "LEARNING_PROVIDER_FAILED",
    "The typed learning provider failed; no recipe was registered.",
  );
}

function traceReceipt(step: LearningStepEvidence): CapabilityRecipeTrace {
  return {
    phase: step.phase,
    traceId: step.trace.traceId,
    channels: [...step.trace.channels],
    eventCount: step.trace.eventCount,
    digest: step.trace.digest,
  };
}

export interface CapabilityLearningWorkflowOptions {
  readonly provider: CapabilityLearningProvider | null;
  readonly registry: CapabilityRecipeRegistry;
  readonly journal?: CapabilityLearningExecutionJournal | null;
  readonly now?: () => string;
  readonly createRecipeId?: () => string;
}

/**
 * Orchestrates one bounded learning run. The concrete browser seam is
 * injected; with no seam the operation fails closed and cannot invent a
 * Tilda endpoint or execute arbitrary code.
 */
export class CapabilityLearningWorkflow {
  readonly #provider: CapabilityLearningProvider | null;
  readonly #registry: CapabilityRecipeRegistry;
  readonly #journal: CapabilityLearningExecutionJournal | null;
  readonly #now: () => string;
  readonly #createRecipeId: () => string;

  constructor(options: CapabilityLearningWorkflowOptions) {
    this.#provider = options.provider;
    this.#registry = options.registry;
    this.#journal = options.journal ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createRecipeId = options.createRecipeId ?? randomUUID;
  }

  listRecipes() {
    return this.#registry.list();
  }

  executionAvailable(): boolean {
    return this.#provider !== null && this.#journal !== null;
  }

  async learn(
    request: LearnCapabilityRequest,
    authority: CapabilityLearningExecutionAuthority | null = null,
  ): Promise<CapabilityLearningResult> {
    try {
      assertRequest(request);
    } catch (error) {
      const failure = safeProviderFailure(error);
      return {
        ok: false,
        code: failure.code,
        summary: failure.message,
        stateChanged: false,
        target: request.target,
        capability: request.capability,
        blockedReasons: [failure.code],
      };
    }

    if (request.dryRun) {
      return {
        ok: true,
        code: "LEARNING_PLAN_READY",
        summary: "Copy-test learning plan validated; no browser or remote action was attempted.",
        stateChanged: false,
        target: request.target,
        capability: request.capability,
        evidence: {
          mode: request.mode,
          targetRole: request.targetRole,
          sequence: ["before", "after", "replay", "restore", "register"],
        },
      };
    }

    if (this.#provider === null) {
      return {
        ok: false,
        code: "LEARNING_PROVIDER_UNAVAILABLE",
        summary: "No copy-test learning provider is connected; no Tilda operation was attempted.",
        stateChanged: false,
        target: request.target,
        capability: request.capability,
        blockedReasons: ["LEARNING_PROVIDER_UNAVAILABLE"],
      };
    }

    if (this.#journal === null) {
      return {
        ok: false,
        code: "LEARNING_JOURNAL_UNAVAILABLE",
        summary: "No durable learning execution journal is connected; no Tilda operation was attempted.",
        stateChanged: false,
        target: request.target,
        capability: request.capability,
        blockedReasons: ["LEARNING_JOURNAL_UNAVAILABLE"],
      };
    }

    if (authority === null) {
      return {
        ok: false,
        code: "LEARNING_TASK_AUTHORITY_REQUIRED",
        summary: "Non-dry learning requires a managed copy-test task execution pin.",
        stateChanged: false,
        target: request.target,
        capability: request.capability,
        blockedReasons: ["LEARNING_TASK_AUTHORITY_REQUIRED"],
      };
    }

    let lineage: LearningTaskLineage;
    let execution: ReturnType<CapabilityLearningExecutionAuthority["beginTaskExecution"]>;
    try {
      authority.assertCopyTestWrite(request.target);
      lineage = authority.receipt();
      execution = authority.beginTaskExecution();
      this.#assertLineage(authority, lineage, request.target);
    } catch (error) {
      const failure = safeProviderFailure(error);
      return this.#failure(request, failure, false);
    }
    try {
      return await this.#learnPinned(request, authority, lineage);
    } finally {
      execution.release();
    }
  }

  async #learnPinned(
    request: LearnCapabilityRequest,
    authority: CapabilityLearningExecutionAuthority,
    lineage: LearningTaskLineage,
  ): Promise<CapabilityLearningResult> {
    let executionClaim: LearningExecutionClaim;
    try {
      this.#assertLineage(authority, lineage, request.target);
      const claim = this.#journal!.claim(request, lineage);
      if (claim.kind === "COMPLETED") {
        const existing = this.#registry.find(request.capability, request.target);
        if (existing === null) {
          return this.#failure(
            request,
            new LearningWorkflowError(
              "LEARNING_COMPLETED_RECIPE_MISSING",
              "The durable execution is complete but its sanitized recipe is unavailable; no mutation was attempted.",
            ),
            false,
          );
        }
        return {
          ok: true,
          code: "LEARNING_RECIPE_REPLAY",
          summary: "The same completed idempotent learning execution reused its exact-target recipe; no mutation was attempted.",
          stateChanged: false,
          target: request.target,
          capability: request.capability,
          recipe: existing,
        };
      }
      if (claim.kind === "FAILED") {
        return this.#failure(
          request,
          new LearningWorkflowError(
            "LEARNING_IDEMPOTENCY_TERMINAL",
            "The same idempotency key already ended in a safely restored failure; automatic repeat is blocked.",
          ),
          false,
        );
      }
      executionClaim = claim.claim;
    } catch (error) {
      return this.#failure(request, safeProviderFailure(error), false);
    }

    let existing: CapabilityRecipe | null;
    try {
      existing = this.#registry.find(request.capability, request.target);
    } catch (error) {
      return this.#failClaim(request, executionClaim, safeProviderFailure(error));
    }
    if (existing !== null) {
      try {
        this.#assertLineage(authority, lineage, request.target);
        executionClaim.complete();
      } catch (error) {
        return this.#failure(request, safeProviderFailure(error), false);
      }
      return {
        ok: true,
        code: "LEARNING_RECIPE_REPLAY",
        summary: "An existing exact-target capability recipe was reused under a completed durable claim; no learning mutation was attempted.",
        stateChanged: false,
        target: request.target,
        capability: request.capability,
        recipe: existing,
      };
    }

    let session: CapabilityLearningSession;
    try {
      this.#assertLineage(authority, lineage, request.target);
      session = await this.#provider!.open(request);
      assertSession(session);
      this.#assertLineage(authority, lineage, request.target);
    } catch (error) {
      return this.#failClaim(request, executionClaim, safeProviderFailure(error));
    }

    let before: LearningStepEvidence | undefined;
    let after: LearningStepEvidence | undefined;
    let replay: LearningStepEvidence | undefined;
    let restored: LearningStepEvidence | undefined;
    let restoreProven = false;
    try {
      before = await this.#phase(authority, lineage, request, "before", () => session.captureBefore());
      after = await this.#phase(authority, lineage, request, "after", () => session.performTestAction());
      if (after.stateHash === before.stateHash || after.changedPaths.length === 0) {
        throw new LearningWorkflowError("LEARNING_NO_MUTATION", "The copy-test action produced no bounded semantic delta.");
      }
      replay = await this.#phase(authority, lineage, request, "replay", () => session.replayRecipe());
      if (replay.stateHash !== after.stateHash || !samePaths(replay.changedPaths, after.changedPaths)) {
        throw new LearningWorkflowError("LEARNING_REPLAY_MISMATCH", "Programmatic replay did not reproduce the observed semantic delta.");
      }
      restored = await this.#phase(authority, lineage, request, "restore", () => session.restoreBaseline());
      if (restored.stateHash !== before.stateHash) {
        throw new LearningWorkflowError("LEARNING_RESTORE_MISMATCH", "Copy-test restore did not return the exact baseline hash.");
      }
      restoreProven = true;
    } catch (error) {
      const failure = safeProviderFailure(error);
      if (before !== undefined && !restoreProven) {
        try {
          restored = await this.#phase(authority, lineage, request, "restore", () => session.restoreBaseline());
          if (restored.stateHash !== before.stateHash) {
            throw new LearningWorkflowError("LEARNING_RESTORE_MISMATCH", "Copy-test restore did not return the exact baseline hash.");
          }
          restoreProven = true;
        } catch {
          return this.#ambiguousClaim(request, executionClaim);
        }
      }
      return this.#failClaim(request, executionClaim, failure);
    }

    // All four phase receipts and exact replay/restore hashes are required
    // before registration. Only sanitized hashes and trace metadata persist.
    const recipe: CapabilityRecipe = {
      format: "tilda-capability-recipe-v1",
      recipeId: this.#createRecipeId(),
      capability: request.capability,
      family: request.family,
      action: request.action,
      mode: "copy-test",
      target: structuredClone(request.target),
      targetRole: request.targetRole,
      adapterId: session.adapterId,
      transport: session.transport,
      registeredAt: this.#now(),
      changedPaths: [...after!.changedPaths],
      beforeHash: before!.stateHash,
      afterHash: after!.stateHash,
      replayHash: replay!.stateHash,
      restoredHash: restored!.stateHash,
      traces: [before!, after!, replay!, restored!].map(traceReceipt),
    };
    let registered: CapabilityRecipe;
    try {
      this.#assertLineage(authority, lineage, request.target);
      registered = this.#registry.upsert(recipe);
      this.#assertLineage(authority, lineage, request.target);
    } catch (error) {
      return this.#failClaim(request, executionClaim, safeProviderFailure(error));
    }
    try {
      executionClaim.complete();
    } catch (error) {
      return this.#failure(request, safeProviderFailure(error), false);
    }
    return {
      ok: true,
      code: "LEARNING_REGISTERED",
      summary: "Copy-test trace, replay, reread, and exact restore passed; capability recipe registered.",
      stateChanged: false,
      target: request.target,
      capability: request.capability,
      recipe: registered,
      evidence: {
        phases: registered.traces.map((trace) => trace.phase),
        beforeHash: registered.beforeHash,
        afterHash: registered.afterHash,
        replayHash: registered.replayHash,
        restoredHash: registered.restoredHash,
      },
    };
  }

  async #phase(
    authority: CapabilityLearningExecutionAuthority,
    lineage: LearningTaskLineage,
    request: LearnCapabilityRequest,
    phase: LearningPhase,
    action: () => Promise<LearningStepEvidence>,
  ): Promise<LearningStepEvidence> {
    this.#assertLineage(authority, lineage, request.target);
    const evidence = await action();
    this.#assertLineage(authority, lineage, request.target);
    assertStep(evidence, phase, request);
    return evidence;
  }

  #assertLineage(
    authority: CapabilityLearningExecutionAuthority,
    expected: LearningTaskLineage,
    target: ExactTarget,
  ): void {
    authority.assertCopyTestWrite(target);
    const current = authority.receipt();
    if (current.taskId !== expected.taskId || current.grantHash !== expected.grantHash) {
      throw new LearningWorkflowError(
        "LEARNING_TASK_LINEAGE_CHANGED",
        "The pinned learning execution no longer belongs to the same exact task grant.",
      );
    }
  }

  #failClaim(
    request: LearnCapabilityRequest,
    claim: LearningExecutionClaim,
    failure: LearningWorkflowError,
  ): CapabilityLearningResult {
    try {
      claim.fail(failure.code);
    } catch (error) {
      return this.#failure(request, safeProviderFailure(error), false);
    }
    return this.#failure(request, failure, false);
  }

  #ambiguousClaim(
    request: LearnCapabilityRequest,
    claim: LearningExecutionClaim,
  ): CapabilityLearningResult {
    try {
      claim.ambiguous("LEARNING_RESTORE_FAILED");
    } catch (error) {
      return this.#failure(request, safeProviderFailure(error), true);
    }
    return this.#failure(
      request,
      new LearningWorkflowError(
        "LEARNING_RESTORE_FAILED",
        "Learning failed and the exact copy-test baseline could not be proven restored; the entire exact target is quarantined.",
      ),
      true,
    );
  }

  #failure(
    request: LearnCapabilityRequest,
    failure: LearningWorkflowError,
    stateChanged: boolean,
  ): CapabilityLearningResult {
    return {
      ok: false,
      code: failure.code,
      summary: failure.message,
      stateChanged,
      target: request.target,
      capability: request.capability,
      blockedReasons: [failure.code],
    };
  }
}
