import { randomUUID } from "node:crypto";
import {
  assertLabPageTarget,
  assertLabRecordTarget,
  type LabPageTarget,
  type LabRecordTarget,
  type LiveInventory,
  type ResearchConfig,
} from "./config.js";

export type CreatedLabTargetKind = "page" | "record" | "element";
export type LabWriteKind = "semantic_mutation" | "zero_noop_save";

export interface LabObjectTarget extends LabPageTarget {
  readonly recordId?: string;
  readonly elementId?: string;
}

export interface CreationIntent {
  readonly transactionId: string;
  readonly sessionId: string;
  readonly parent: LabObjectTarget;
  readonly kind: CreatedLabTargetKind;
  /** Single-use opaque nonce. Keep it only in the adapter's same-session memory. */
  readonly nonce: string;
}

export interface CreatedTargetReceipt {
  readonly transactionId: string;
  readonly sessionId: string;
  readonly parent: LabObjectTarget;
  readonly kind: CreatedLabTargetKind;
  readonly nonce: string;
  readonly target: LabObjectTarget;
}

export interface LabTransactionSnapshot {
  readonly transactionId: string;
  readonly experimentId: string;
  readonly parent: LabPageTarget;
  readonly createdTargets: readonly LabObjectTarget[];
  readonly semanticMutationAuthorized: boolean;
  readonly zeroNoopSaveAuthorized: boolean;
}

export class LabTransactionGateError extends Error {
  readonly code = "LAB_TRANSACTION_GATE_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "LabTransactionGateError";
  }
}

const CANONICAL_ID = /^[1-9][0-9]*$/;
const OPAQUE_ELEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertId(value: string, field: string): string {
  if (!CANONICAL_ID.test(value)) {
    throw new LabTransactionGateError(`${field} must be a canonical positive decimal ID.`);
  }
  return value;
}

function assertOpaqueSessionId(value: string): string {
  if (!OPAQUE_ELEMENT_ID.test(value)) {
    throw new LabTransactionGateError("sessionId must be a bounded opaque identifier.");
  }
  return value;
}

function canonicalTarget(target: LabObjectTarget, field: string): LabObjectTarget {
  const projectId = assertId(target.projectId, `${field}.projectId`);
  const pageId = assertId(target.pageId, `${field}.pageId`);
  const recordId = target.recordId === undefined
    ? undefined
    : assertId(target.recordId, `${field}.recordId`);
  const elementId = target.elementId === undefined
    ? undefined
    : target.elementId;
  if (elementId !== undefined && !OPAQUE_ELEMENT_ID.test(elementId)) {
    throw new LabTransactionGateError(`${field}.elementId must be a bounded opaque identifier.`);
  }
  return { projectId, pageId, ...(recordId === undefined ? {} : { recordId }), ...(elementId === undefined ? {} : { elementId }) };
}

function targetKey(target: LabObjectTarget): string {
  return [target.projectId, target.pageId, target.recordId ?? "", target.elementId ?? ""].join(":");
}

function sameTarget(left: LabObjectTarget, right: LabObjectTarget): boolean {
  return targetKey(left) === targetKey(right);
}

function assertShape(kind: CreatedLabTargetKind, target: LabObjectTarget, field: string): void {
  if (kind === "page" && (target.recordId !== undefined || target.elementId !== undefined)) {
    throw new LabTransactionGateError(`${field} page receipt may contain only projectId and pageId.`);
  }
  if (kind === "record" && (target.recordId === undefined || target.elementId !== undefined)) {
    throw new LabTransactionGateError(`${field} record receipt requires recordId and forbids elementId.`);
  }
  if (kind === "element" && (target.recordId === undefined || target.elementId === undefined)) {
    throw new LabTransactionGateError(`${field} element receipt requires recordId and elementId.`);
  }
}

/**
 * Fail-closed, in-memory scope for one authenticated experiment session.
 * It does not grant a write by itself: normal allowlist, revision, snapshot and
 * dry-run gates are verified before construction by the caller.
 */
export class LabTransactionGate {
  readonly transactionId = randomUUID();
  private readonly pendingCreations = new Map<string, CreationIntent>();
  private readonly baselineTargets = new Map<string, LabObjectTarget>();
  private readonly createdTargets = new Map<string, LabObjectTarget>();
  private semanticMutationAuthorized = false;
  private zeroNoopSaveAuthorized = false;

  private constructor(
    readonly experimentId: string,
    readonly sessionId: string,
    readonly parent: LabPageTarget,
    baselineTarget?: LabRecordTarget,
  ) {
    if (experimentId.trim() === "") {
      throw new LabTransactionGateError("experimentId is required.");
    }
    assertOpaqueSessionId(sessionId);
    canonicalTarget(parent, "parent");
    if (baselineTarget !== undefined) {
      const target = baselineTarget;
      const canonical = canonicalTarget(target, "baseline target");
      if (
        canonical.projectId !== parent.projectId ||
        canonical.pageId !== parent.pageId ||
        canonical.recordId === undefined
      ) {
        throw new LabTransactionGateError(
          "A baseline child target must be reread on the exact transaction parent page.",
        );
      }
      this.baselineTargets.set(targetKey(canonical), canonical);
    }
  }

  static begin(input: {
    readonly config: ResearchConfig;
    readonly inventory: LiveInventory;
    readonly experimentId: string;
    readonly sessionId: string;
    readonly parent: LabPageTarget;
    /**
     * One exact existing record admitted by ignored local LAB_RECORD_TARGETS.
     * It is checked against the current account/inventory and page binding here;
     * callers cannot widen scope with a free-form baseline array.
     */
    readonly baselineRecordTarget?: LabRecordTarget;
  }): LabTransactionGate {
    // A transaction can only be rooted at a pre-existing exact allowlisted page.
    assertLabPageTarget(input.config, input.parent, input.inventory);
    let baselineRecordTarget: LabRecordTarget | undefined;
    if (input.baselineRecordTarget !== undefined) {
      if (input.experimentId !== "EXP-05") {
        throw new LabTransactionGateError(
          "LAB_RECORD_TARGETS baseline admission is available only to EXP-05.",
        );
      }
      baselineRecordTarget = assertLabRecordTarget(
        input.config,
        input.baselineRecordTarget,
        input.inventory,
      );
      if (
        baselineRecordTarget.projectId !== input.parent.projectId ||
        baselineRecordTarget.pageId !== input.parent.pageId
      ) {
        throw new LabTransactionGateError(
          "An existing baseline record must be allowlisted on the exact transaction parent page.",
        );
      }
    }
    return new LabTransactionGate(
      input.experimentId,
      input.sessionId,
      input.parent,
      baselineRecordTarget,
    );
  }

  authorizeWrite(kind: LabWriteKind): void {
    if (kind === "zero_noop_save") {
      // Still a remote write; it just does not consume the one semantic mutation.
      if (this.zeroNoopSaveAuthorized) {
        throw new LabTransactionGateError("Only one Zero no-op save is allowed per transaction.");
      }
      this.zeroNoopSaveAuthorized = true;
      return;
    }
    if (this.semanticMutationAuthorized) {
      throw new LabTransactionGateError("Only one semantic mutation is allowed per transaction.");
    }
    this.semanticMutationAuthorized = true;
  }

  authorizeCreation(kind: CreatedLabTargetKind, parent: LabObjectTarget): CreationIntent {
    const canonicalParent = canonicalTarget(parent, "creation parent");
    this.assertInScope(canonicalParent);
    if (
      (kind === "page" || kind === "record") &&
      (canonicalParent.recordId !== undefined || canonicalParent.elementId !== undefined)
    ) {
      throw new LabTransactionGateError(`${kind} creation must be rooted at an exact page target.`);
    }
    if (
      kind === "element" &&
      (canonicalParent.recordId === undefined || canonicalParent.elementId !== undefined)
    ) {
      throw new LabTransactionGateError("element creation must be rooted at an exact record target.");
    }
    // Creation changes remote state, so it is the transaction's one semantic mutation.
    this.authorizeWrite("semantic_mutation");
    const intent: CreationIntent = Object.freeze({
      transactionId: this.transactionId,
      sessionId: this.sessionId,
      parent: canonicalParent,
      kind,
      nonce: randomUUID(),
    });
    this.pendingCreations.set(intent.nonce, intent);
    return intent;
  }

  /**
   * Accept a newly created ID only once, only from this session, and only after
   * the adapter rereads the exact object and confirms its full ownership path.
   */
  acceptCreatedTarget(
    receipt: CreatedTargetReceipt,
    reread: (target: LabObjectTarget) => LabObjectTarget | null,
  ): LabObjectTarget {
    const intent = this.pendingCreations.get(receipt.nonce);
    if (intent === undefined) {
      throw new LabTransactionGateError("Creation receipt is unknown, expired, or already consumed.");
    }
    if (
      receipt.transactionId !== this.transactionId ||
      receipt.sessionId !== this.sessionId ||
      receipt.kind !== intent.kind ||
      !sameTarget(canonicalTarget(receipt.parent, "receipt parent"), intent.parent)
    ) {
      throw new LabTransactionGateError("Creation receipt is not bound to this transaction and same session.");
    }
    const target = canonicalTarget(receipt.target, "receipt target");
    assertShape(intent.kind, target, "receipt target");
    if (target.projectId !== this.parent.projectId) {
      throw new LabTransactionGateError("Created target is outside the transaction's allowlisted lab project.");
    }
    if (intent.kind !== "page" && target.pageId !== intent.parent.pageId) {
      throw new LabTransactionGateError("Created record or element is outside its exact parent page.");
    }
    const rereadTarget = reread(target);
    if (rereadTarget === null || !sameTarget(canonicalTarget(rereadTarget, "reread target"), target)) {
      throw new LabTransactionGateError("Created target was not immediately reread with exact ownership.");
    }
    this.pendingCreations.delete(receipt.nonce);
    this.createdTargets.set(targetKey(target), target);
    return target;
  }

  /** Only a target created and reread by this exact experiment may be deleted as rollback. */
  assertRollbackDeletion(target: LabObjectTarget): void {
    const canonical = canonicalTarget(target, "rollback target");
    if (!this.createdTargets.has(targetKey(canonical))) {
      throw new LabTransactionGateError(
        "Deletion is not authorized: rollback may clean up only an object created by this transaction.",
      );
    }
  }

  markRollbackDeleted(target: LabObjectTarget): void {
    this.assertRollbackDeletion(target);
    this.createdTargets.delete(targetKey(canonicalTarget(target, "rollback target")));
  }

  assertInScope(target: LabObjectTarget): void {
    const canonical = canonicalTarget(target, "scope target");
    if (this.createdTargets.has(targetKey(canonical))) return;
    if (this.baselineTargets.has(targetKey(canonical))) return;
    if (canonical.recordId === undefined && canonical.elementId === undefined) {
      if (canonical.projectId === this.parent.projectId && canonical.pageId === this.parent.pageId) return;
    }
    throw new LabTransactionGateError("Target is outside the exact allowlisted parent or created rollback scope.");
  }

  snapshot(): LabTransactionSnapshot {
    return Object.freeze({
      transactionId: this.transactionId,
      experimentId: this.experimentId,
      parent: Object.freeze({ ...this.parent }),
      createdTargets: Object.freeze([...this.createdTargets.values()].map((target) => Object.freeze({ ...target }))),
      semanticMutationAuthorized: this.semanticMutationAuthorized,
      zeroNoopSaveAuthorized: this.zeroNoopSaveAuthorized,
    });
  }
}
