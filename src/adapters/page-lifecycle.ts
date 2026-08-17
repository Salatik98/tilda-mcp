import { randomUUID } from "node:crypto";

import type { PageTarget } from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";

const CANONICAL_ID = /^[1-9][0-9]*$/;

export interface PageLifecycleBaselineEvidence {
  readonly source: PageTarget;
  readonly activePageIds: readonly string[];
  readonly pageOrder: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly sourcePublished: boolean;
  readonly sourceChanged: string | null;
}

export interface PageLifecycleRestoredEvidence {
  readonly source: PageTarget;
  readonly activePageIds: readonly string[];
  readonly pageOrder: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly sourcePublished: boolean;
  readonly sourceChanged: string | null;
  readonly temporaryPageId: string;
  readonly temporaryPageAbsent: boolean;
  readonly pageOrderRestored: boolean;
  readonly sourceUnchanged: boolean;
  readonly exactBaselineRestored: boolean;
}

/**
 * This is intentionally one opaque adapter-owned operation. It may duplicate,
 * inspect, reorder, restore, and clean up only the temporary child it created;
 * the MCP controller cannot issue a generic delete or reorder command. Its
 * implementation owns the fresh exact lab-target binding before any remote action.
 */
export interface PageLifecycleTransport {
  duplicateVerifyReorderRestoreCleanup(
    target: PageTarget,
  ): Promise<{
    readonly baseline: PageLifecycleBaselineEvidence;
    readonly restored: PageLifecycleRestoredEvidence;
  }>;
}

export interface PageLifecycleRequest {
  readonly target: PageTarget;
  readonly idempotencyKey: string;
  readonly dryRun?: boolean;
}

export interface PageLifecycleResult {
  readonly changeSetId: string;
  readonly snapshotId: string;
  readonly dryRun: boolean;
  /** The final source page is restored; no retained page or order change remains. */
  readonly stateChanged: false;
  readonly baseline: PageLifecycleBaselineEvidence | null;
  readonly restored: PageLifecycleRestoredEvidence | null;
}

interface CompletedLifecycle {
  readonly target: PageTarget;
  readonly result: PageLifecycleResult;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCanonicalIds(ids: readonly string[], field: string): void {
  if (ids.some((id) => !CANONICAL_ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new TildaEngineError("LIFECYCLE_EVIDENCE_INVALID", `${field} must contain unique canonical IDs.`);
  }
}

function assertPageTarget(target: PageTarget, field: string): void {
  if (
    target.kind !== "page" ||
    !CANONICAL_ID.test(target.projectId) ||
    !CANONICAL_ID.test(target.pageId)
  ) {
    throw new TildaEngineError(
      "LIFECYCLE_TARGET_INVALID",
      `${field} must be an exact page target with canonical projectId and pageId.`,
    );
  }
}

function assertExactSource(target: PageTarget, evidence: PageTarget, field: string): void {
  assertPageTarget(evidence, field);
  if (
    evidence.projectId !== target.projectId ||
    evidence.pageId !== target.pageId
  ) {
    throw new TildaEngineError("LIFECYCLE_TARGET_MISMATCH", `${field} is not bound to the exact source page.`);
  }
}

function assertIdempotencyKey(value: string): void {
  if (value.length < 8 || value.length > 256 || value.trim() !== value) {
    throw new TildaEngineError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotencyKey must be 8..256 characters with no surrounding whitespace.",
    );
  }
}

function assertRestored(
  target: PageTarget,
  baseline: PageLifecycleBaselineEvidence,
  restored: PageLifecycleRestoredEvidence,
): void {
  assertPageTarget(target, "Request target");
  assertExactSource(target, baseline.source, "Baseline evidence");
  assertExactSource(target, restored.source, "Restored evidence");
  assertCanonicalIds(baseline.activePageIds, "baseline.activePageIds");
  assertCanonicalIds(baseline.pageOrder, "baseline.pageOrder");
  assertCanonicalIds(baseline.sourceRecordIds, "baseline.sourceRecordIds");
  assertCanonicalIds(restored.activePageIds, "restored.activePageIds");
  assertCanonicalIds(restored.pageOrder, "restored.pageOrder");
  assertCanonicalIds(restored.sourceRecordIds, "restored.sourceRecordIds");
  if (!baseline.activePageIds.includes(target.pageId) || !baseline.pageOrder.includes(target.pageId)) {
    throw new TildaEngineError(
      "LIFECYCLE_EVIDENCE_INVALID",
      "Baseline evidence does not contain the exact source page in its active order.",
    );
  }
  if (!CANONICAL_ID.test(restored.temporaryPageId) || restored.temporaryPageId === target.pageId) {
    throw new TildaEngineError("LIFECYCLE_EVIDENCE_INVALID", "Temporary page identity is invalid.");
  }
  if (
    baseline.activePageIds.includes(restored.temporaryPageId) ||
    baseline.pageOrder.includes(restored.temporaryPageId) ||
    restored.activePageIds.includes(restored.temporaryPageId) ||
    !sameStrings(restored.activePageIds, baseline.activePageIds) ||
    !sameStrings(restored.pageOrder, baseline.pageOrder) ||
    !sameStrings(restored.sourceRecordIds, baseline.sourceRecordIds) ||
    restored.sourcePublished !== baseline.sourcePublished ||
    restored.sourceChanged !== baseline.sourceChanged ||
    !restored.temporaryPageAbsent ||
    !restored.pageOrderRestored ||
    !restored.sourceUnchanged ||
    !restored.exactBaselineRestored
  ) {
    throw new TildaEngineError(
      "LIFECYCLE_RESTORE_UNVERIFIED",
      "The opaque lifecycle transaction did not prove exact source-page restoration and cleanup.",
    );
  }
}

/**
 * Narrow controller for the one v1 page-lifecycle experiment. It never exposes
 * generic duplicate, delete, reorder, or retained-page operations.
 */
export class PageLifecycleController {
  readonly #completed = new Map<string, CompletedLifecycle>();
  readonly #inFlight = new Map<string, { readonly target: PageTarget; readonly result: Promise<PageLifecycleResult> }>();
  readonly #targetInFlight = new Map<string, string>();
  /** A failed remote attempt is ambiguous, so the same key may never blind-retry it. */
  readonly #retryBlocked = new Map<string, { readonly target: PageTarget }>();

  constructor(readonly transport: PageLifecycleTransport) {}

  async execute(request: PageLifecycleRequest): Promise<PageLifecycleResult> {
    assertPageTarget(request.target, "Request target");
    assertIdempotencyKey(request.idempotencyKey);
    const dryRun = request.dryRun !== false;
    if (dryRun) {
      return {
        changeSetId: randomUUID(),
        snapshotId: randomUUID(),
        dryRun: true,
        stateChanged: false,
        baseline: null,
        restored: null,
      };
    }

    const previous = this.#completed.get(request.idempotencyKey);
    if (previous !== undefined) {
      assertExactSource(request.target, previous.target, "Idempotent replay target");
      return previous.result;
    }
    const pending = this.#inFlight.get(request.idempotencyKey);
    if (pending !== undefined) {
      assertExactSource(request.target, pending.target, "Idempotent replay target");
      return pending.result;
    }
    const blocked = this.#retryBlocked.get(request.idempotencyKey);
    if (blocked !== undefined) {
      assertExactSource(request.target, blocked.target, "Idempotent replay target");
      throw new TildaEngineError(
        "LIFECYCLE_RETRY_BLOCKED",
        "A prior lifecycle attempt with this idempotencyKey did not produce verified restoration; diagnose it before any new transaction.",
      );
    }

    const target: PageTarget = {
      kind: "page",
      projectId: request.target.projectId,
      pageId: request.target.pageId,
    };
    const targetKey = `${target.projectId}:${target.pageId}`;
    const activeKey = this.#targetInFlight.get(targetKey);
    if (activeKey !== undefined && activeKey !== request.idempotencyKey) {
      throw new TildaEngineError(
        "LIFECYCLE_TARGET_BUSY",
        "Another fixed lifecycle transaction is already in progress for this exact source page.",
      );
    }
    this.#targetInFlight.set(targetKey, request.idempotencyKey);
    const result = this.runFixedTransaction(target);
    this.#inFlight.set(request.idempotencyKey, { target, result });
    try {
      const completed = await result;
      this.#completed.set(request.idempotencyKey, { target, result: completed });
      return completed;
    } catch (error) {
      this.#retryBlocked.set(request.idempotencyKey, { target });
      throw error;
    } finally {
      this.#inFlight.delete(request.idempotencyKey);
      if (this.#targetInFlight.get(targetKey) === request.idempotencyKey) {
        this.#targetInFlight.delete(targetKey);
      }
    }
  }

  private async runFixedTransaction(target: PageTarget): Promise<PageLifecycleResult> {
    const evidence = await this.transport.duplicateVerifyReorderRestoreCleanup(target);
    assertRestored(target, evidence.baseline, evidence.restored);
    return {
      changeSetId: randomUUID(),
      snapshotId: randomUUID(),
      dryRun: false,
      stateChanged: false,
      baseline: evidence.baseline,
      restored: evidence.restored,
    };
  }
}
