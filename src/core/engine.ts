import { randomUUID } from "node:crypto";

import { canonicalHash } from "../research/hash.js";
import type {
  AdapterRegistry,
  AdapterState,
  ChangeAdapter,
  ChangeRequest,
  ChangeSetRecord,
  ChangeSetTaskAuthority,
  ExactTarget,
  VerificationRecord,
} from "./contracts.js";
import { TildaEngineError } from "./contracts.js";
import { ChangeSetStore } from "./store.js";
import { VolatileSnapshotVault } from "./vault.js";

export interface EngineActionResult {
  readonly changeSet: ChangeSetRecord;
  readonly stateChanged: boolean;
  readonly dryRun: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function requestHash(request: ChangeRequest): string {
  return canonicalHash(request);
}

function sameTaskAuthority(
  left: ChangeSetTaskAuthority | undefined,
  right: ChangeSetTaskAuthority | undefined,
): boolean {
  return left?.taskId === right?.taskId && left?.grantHash === right?.grantHash;
}

function assertStateHash(state: AdapterState, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(state.hash)) {
    throw new TildaEngineError("INVALID_ADAPTER_STATE", `${field} hash is not canonical SHA-256.`);
  }
}

function verification(expectedHash: string, actualHash: string): VerificationRecord {
  return {
    checkedAt: now(),
    expectedHash,
    actualHash,
    exactMatch: expectedHash === actualHash,
  };
}

function tildaErrorCode(error: unknown): string | null {
  return error instanceof TildaEngineError ? error.code : null;
}

async function diagnosticRead(
  adapter: ChangeAdapter,
  target: ExactTarget,
): Promise<AdapterState | null> {
  try {
    const state = await adapter.read(target);
    assertStateHash(state, "diagnostic state");
    return state;
  } catch {
    return null;
  }
}

function expectedForVerification(record: ChangeSetRecord): string {
  if (record.state === "PLANNED" || record.state === "ROLLED_BACK") {
    return record.expectedBeforeHash;
  }
  if (record.state === "APPLIED" || record.state === "VERIFIED") {
    return record.expectedAfterHash;
  }
  switch (record.failureCode) {
    case "APPLY_FAILED_UNCHANGED":
    case "APPLY_PREVIOUS_ATTEMPT_UNCHANGED":
    case "APPLY_VERIFICATION_FAILED_RECOVERED":
      return record.expectedBeforeHash;
    case "ROLLBACK_FAILED_UNCHANGED":
    case "ROLLBACK_PREVIOUS_ATTEMPT_UNCHANGED":
      return record.expectedAfterHash;
    default:
      throw new TildaEngineError(
        "AMBIGUOUS_STATE",
        "This failed ChangeSet has no single safe expected state; inspect it without retrying.",
      );
  }
}

export class TildaChangeSetEngine {
  constructor(
    readonly adapters: AdapterRegistry,
    readonly store = new ChangeSetStore(),
    readonly vault = new VolatileSnapshotVault(),
  ) {}

  capabilities() {
    return this.adapters.listCapabilities();
  }

  async query(request: ChangeRequest): Promise<AdapterState> {
    const adapter = this.adapters.forRequest(request);
    const state = await adapter.read(request.target);
    assertStateHash(state, "query state");
    return state;
  }

  async plan(
    request: ChangeRequest,
    options: { idempotencyKey?: string; taskAuthority?: ChangeSetTaskAuthority } = {},
  ): Promise<EngineActionResult> {
    return this.store.withMutationLock(async () => {
      if (options.idempotencyKey !== undefined) {
        const existing = this.store.findByIdempotencyKey(options.idempotencyKey);
        if (existing !== null) {
          if (
            existing.requestHash !== requestHash(request) ||
            !sameTaskAuthority(existing.taskAuthority, options.taskAuthority)
          ) {
            throw new TildaEngineError(
              "IDEMPOTENCY_CONFLICT",
              "The idempotency key belongs to a different semantic request.",
            );
          }
          return { changeSet: existing, stateChanged: false, dryRun: true };
        }
      }

      const adapter = this.adapters.forRequest(request);
      const before = await adapter.read(request.target);
      assertStateHash(before, "baseline state");
      const plan = adapter.plan(before, request);
      assertStateHash(plan.intendedState, "intended state");
      if (
        plan.adapter !== adapter.id ||
        !adapter.capabilities.includes(plan.capability) ||
        plan.expectedBeforeHash !== before.hash ||
        plan.expectedAfterHash !== plan.intendedState.hash ||
        requestHash(plan.request) !== requestHash(request) ||
        plan.changedPaths.length === 0 ||
        new Set(plan.changedPaths).size !== plan.changedPaths.length
      ) {
        throw new TildaEngineError(
          "INVALID_ADAPTER_PLAN",
          "Adapter plan is not exactly bound to the baseline, capability, and request.",
        );
      }
      if (plan.expectedBeforeHash === plan.expectedAfterHash) {
        throw new TildaEngineError("NO_CHANGES", "The requested patch does not change the target.");
      }

      const changeSetId = randomUUID();
      const timestamp = now();
      let snapshotId: string | null = null;
      try {
        this.vault.put(changeSetId, { request, before, plan });
        const snapshot = this.store.createSnapshot({
          adapter: adapter.id,
          target: request.target,
          stateHash: before.hash,
          ...(before.revision === undefined ? {} : { revision: before.revision }),
          summary: before.summary,
        });
        snapshotId = snapshot.snapshotId;
        const changeSet: ChangeSetRecord = {
          format: "tilda-mcp-changeset-v1",
          changeSetId,
          snapshotId: snapshot.snapshotId,
          state: "PLANNED",
          createdAt: timestamp,
          updatedAt: timestamp,
          adapter: adapter.id,
          capability: plan.capability,
          target: request.target,
          operation: request.operation,
          requestHash: requestHash(request),
          expectedBeforeHash: plan.expectedBeforeHash,
          ...(plan.expectedBeforeRevision === undefined
            ? {}
            : { expectedBeforeRevision: plan.expectedBeforeRevision }),
          expectedAfterHash: plan.expectedAfterHash,
          changedPaths: [...plan.changedPaths],
          summary: plan.summary,
          ...(options.taskAuthority === undefined
            ? {}
            : { taskAuthority: structuredClone(options.taskAuthority) }),
        };
        const persisted = this.store.createChangeSet(changeSet, options.idempotencyKey);
        return { changeSet: persisted, stateChanged: false, dryRun: true };
      } catch (error) {
        this.vault.delete(changeSetId);
        if (snapshotId !== null) {
          try {
            this.store.discardUnreferencedSnapshot(snapshotId);
          } catch {
            // A referenced snapshot is immutable; fail closed and preserve its journal evidence.
          }
        }
        throw error;
      }
    });
  }

  async apply(
    changeSetId: string,
    dryRun = true,
    idempotencyKey?: string,
  ): Promise<EngineActionResult> {
    return this.store.withMutationLock(async () => {
      const current = this.store.loadChangeSet(changeSetId);
      if (dryRun) return { changeSet: current, stateChanged: false, dryRun: true };
      if (idempotencyKey === undefined) {
        throw new TildaEngineError(
          "IDEMPOTENCY_KEY_REQUIRED",
          "Applying a ChangeSet requires an explicit idempotency key.",
        );
      }

      const attempt = this.store.actionAttemptStatus(
        idempotencyKey,
        "apply",
        current.changeSetId,
      );
      if (current.state === "APPLIED" || current.state === "VERIFIED") {
        if (attempt !== "REPLAY") {
          throw new TildaEngineError(
            "STATE_CORRUPT",
            "Applied ChangeSet lacks its durable apply claim.",
          );
        }
        return { changeSet: current, stateChanged: false, dryRun: false };
      }
      if (current.state !== "PLANNED") {
        throw new TildaEngineError(
          "CHANGESET_NOT_APPLICABLE",
          `ChangeSet in ${current.state} state cannot be applied.`,
        );
      }

      const adapter = this.adapters.byId(current.adapter);
      const material = this.vault.get(current.changeSetId);
      if (
        material.plan.expectedBeforeHash !== current.expectedBeforeHash ||
        material.plan.expectedBeforeRevision !== current.expectedBeforeRevision ||
        requestHash(material.request) !== current.requestHash
      ) {
        throw new TildaEngineError("PLAN_MATERIAL_MISMATCH", "Volatile plan does not match the journal.");
      }
      const fresh = await adapter.read(current.target);
      assertStateHash(fresh, "pre-apply state");

      if (attempt === "REPLAY") {
        if (fresh.hash === current.expectedAfterHash) {
          const reconciled: ChangeSetRecord = {
            ...current,
            state: "APPLIED",
            updatedAt: now(),
            appliedHash: fresh.hash,
            reconciliationCode: "APPLY_REPLAY_RECONCILED",
            verification: verification(current.expectedAfterHash, fresh.hash),
          };
          this.store.appendChangeSet(reconciled);
          return { changeSet: reconciled, stateChanged: false, dryRun: false };
        }
        if (fresh.hash === current.expectedBeforeHash) {
          const failed: ChangeSetRecord = {
            ...current,
            state: "FAILED",
            updatedAt: now(),
            failureCode: "APPLY_PREVIOUS_ATTEMPT_UNCHANGED",
            verification: verification(current.expectedBeforeHash, fresh.hash),
          };
          this.store.appendChangeSet(failed);
          this.vault.delete(current.changeSetId);
          throw new TildaEngineError(
            "RECOVERY_REQUIRED",
            "A prior apply attempt was durably claimed but the target is unchanged; it was not retried.",
          );
        }
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          appliedHash: fresh.hash,
          failureCode: "APPLY_AMBIGUOUS",
          verification: verification(current.expectedAfterHash, fresh.hash),
        };
        this.store.appendChangeSet(failed);
        throw new TildaEngineError(
          "APPLY_AMBIGUOUS",
          "A prior apply attempt left an unexpected state; no retry is allowed.",
        );
      }

      if (fresh.hash !== current.expectedBeforeHash) {
        throw new TildaEngineError(
          "STALE_TARGET",
          "Target changed after planning; no mutation was attempted.",
        );
      }
      if (
        current.expectedBeforeRevision !== undefined &&
        fresh.revision !== current.expectedBeforeRevision
      ) {
        throw new TildaEngineError(
          "STALE_REVISION",
          "Target revision changed after planning; no mutation was attempted.",
        );
      }
      const claim = this.store.claimActionIdempotency(
        idempotencyKey,
        "apply",
        current.changeSetId,
      );
      if (claim !== "CLAIMED") {
        throw new TildaEngineError("RECOVERY_REQUIRED", "Apply claim changed concurrently.");
      }

      let after: AdapterState | null = null;
      let applyThrew = false;
      let applyErrorCode: string | null = null;
      try {
        after = await adapter.apply(material.plan);
        assertStateHash(after, "post-apply state");
      } catch (error) {
        applyThrew = true;
        applyErrorCode = tildaErrorCode(error);
        after = await diagnosticRead(adapter, current.target);
      }

      if (applyErrorCode === "HEAD_WRITE_VERIFICATION_AMBIGUOUS") {
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          ...(after === null ? {} : { appliedHash: after.hash }),
          failureCode: "APPLY_AMBIGUOUS",
          ...(after === null
            ? {}
            : { verification: verification(current.expectedAfterHash, after.hash) }),
        };
        this.store.appendChangeSet(failed);
        throw new TildaEngineError(
          "APPLY_AMBIGUOUS",
          "HEAD write verification was unstable; success reconciliation and automatic restore are disabled.",
        );
      }

      if (after?.hash === current.expectedAfterHash) {
        const applied: ChangeSetRecord = {
          ...current,
          state: "APPLIED",
          updatedAt: now(),
          appliedHash: after.hash,
          ...(applyThrew ? { reconciliationCode: "APPLY_ERROR_RECONCILED" } : {}),
          verification: verification(current.expectedAfterHash, after.hash),
        };
        this.store.appendChangeSet(applied);
        return { changeSet: applied, stateChanged: true, dryRun: false };
      }

      if (applyThrew) {
        if (after?.hash === current.expectedBeforeHash) {
          const failed: ChangeSetRecord = {
            ...current,
            state: "FAILED",
            updatedAt: now(),
            failureCode: "APPLY_FAILED_UNCHANGED",
            verification: verification(current.expectedBeforeHash, after.hash),
          };
          this.store.appendChangeSet(failed);
          this.vault.delete(current.changeSetId);
          throw new TildaEngineError(
            "APPLY_FAILED_UNCHANGED",
            "The adapter failed and a diagnostic reread proved no change; it was not retried.",
          );
        }
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          ...(after === null ? {} : { appliedHash: after.hash }),
          failureCode: "APPLY_AMBIGUOUS",
          ...(after === null
            ? {}
            : { verification: verification(current.expectedAfterHash, after.hash) }),
        };
        this.store.appendChangeSet(failed);
        throw new TildaEngineError(
          "APPLY_AMBIGUOUS",
          "The adapter failed after the durable permit; one diagnostic reread could not prove success or no-op.",
        );
      }

      let recovered: AdapterState | null = null;
      try {
        const candidate = await adapter.restore(current.target, material.before);
        assertStateHash(candidate, "automatic recovery state");
        recovered = await diagnosticRead(adapter, current.target);
      } catch {
        recovered = await diagnosticRead(adapter, current.target);
      }
      if (recovered?.hash === current.expectedBeforeHash) {
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          ...(after === null ? {} : { appliedHash: after.hash }),
          failureCode: "APPLY_VERIFICATION_FAILED_RECOVERED",
          verification: verification(current.expectedBeforeHash, recovered.hash),
        };
        this.store.appendChangeSet(failed);
        this.vault.delete(current.changeSetId);
      } else {
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          ...(after === null ? {} : { appliedHash: after.hash }),
          failureCode: "APPLY_VERIFICATION_FAILED_RECOVERY_UNPROVEN",
          ...(recovered === null
            ? {}
            : { verification: verification(current.expectedBeforeHash, recovered.hash) }),
        };
        this.store.appendChangeSet(failed);
      }
      throw new TildaEngineError(
        "APPLY_VERIFICATION_FAILED",
        "The adapter result did not match the plan; one recovery attempt was journaled and no retry occurred.",
      );
    });
  }

  async verify(changeSetId: string): Promise<EngineActionResult> {
    return this.store.withMutationLock(async () => {
      const current = this.store.loadChangeSet(changeSetId);
      const expected = expectedForVerification(current);
      const adapter = this.adapters.byId(current.adapter);
      const actual = await adapter.read(current.target);
      assertStateHash(actual, "verification state");
      const checked = verification(expected, actual.hash);
      const next: ChangeSetRecord = {
        ...current,
        state:
          checked.exactMatch && (current.state === "APPLIED" || current.state === "VERIFIED")
            ? "VERIFIED"
            : current.state,
        updatedAt: now(),
        verification: checked,
      };
      this.store.appendChangeSet(next);
      if (!checked.exactMatch) {
        throw new TildaEngineError(
          "VERIFICATION_FAILED",
          "Fresh target state does not match the ChangeSet expectation.",
        );
      }
      return { changeSet: next, stateChanged: false, dryRun: true };
    });
  }

  async rollback(
    changeSetId: string,
    dryRun = true,
    idempotencyKey?: string,
  ): Promise<EngineActionResult> {
    return this.store.withMutationLock(async () => {
      const current = this.store.loadChangeSet(changeSetId);
      if (dryRun) return { changeSet: current, stateChanged: false, dryRun: true };
      if (idempotencyKey === undefined) {
        throw new TildaEngineError(
          "IDEMPOTENCY_KEY_REQUIRED",
          "Rolling back a ChangeSet requires an explicit idempotency key.",
        );
      }
      const attempt = this.store.actionAttemptStatus(
        idempotencyKey,
        "rollback",
        current.changeSetId,
      );
      if (current.state === "ROLLED_BACK") {
        if (attempt !== "REPLAY") {
          throw new TildaEngineError(
            "STATE_CORRUPT",
            "Rolled-back ChangeSet lacks its durable rollback claim.",
          );
        }
        return { changeSet: current, stateChanged: false, dryRun: false };
      }
      if (!["PLANNED", "APPLIED", "VERIFIED", "FAILED"].includes(current.state)) {
        throw new TildaEngineError(
          "CHANGESET_NOT_ROLLBACKABLE",
          `ChangeSet in ${current.state} state cannot be rolled back.`,
        );
      }

      const adapter = this.adapters.byId(current.adapter);
      const fresh = await adapter.read(current.target);
      assertStateHash(fresh, "pre-rollback state");
      const snapshot = this.store.loadSnapshot(current.snapshotId);
      if (
        snapshot.adapter !== current.adapter ||
        canonicalHash(snapshot.target) !== canonicalHash(current.target) ||
        snapshot.stateHash !== current.expectedBeforeHash
      ) {
        throw new TildaEngineError(
          "SNAPSHOT_MISMATCH",
          "Snapshot is not exactly bound to this ChangeSet.",
        );
      }

      if (attempt === "REPLAY") {
        if (fresh.hash === current.expectedBeforeHash) {
          const rolledBack: ChangeSetRecord = {
            ...current,
            state: "ROLLED_BACK",
            updatedAt: now(),
            reconciliationCode: "ROLLBACK_REPLAY_RECONCILED",
            verification: verification(current.expectedBeforeHash, fresh.hash),
          };
          this.store.appendChangeSet(rolledBack);
          this.vault.delete(current.changeSetId);
          return { changeSet: rolledBack, stateChanged: false, dryRun: false };
        }
        if (fresh.hash === current.expectedAfterHash) {
          if (current.state !== "FAILED" || current.failureCode !== "ROLLBACK_PREVIOUS_ATTEMPT_UNCHANGED") {
            const failed: ChangeSetRecord = {
              ...current,
              state: "FAILED",
              updatedAt: now(),
              failureCode: "ROLLBACK_PREVIOUS_ATTEMPT_UNCHANGED",
              verification: verification(current.expectedAfterHash, fresh.hash),
            };
            this.store.appendChangeSet(failed);
          }
          throw new TildaEngineError(
            "RECOVERY_REQUIRED",
            "A prior rollback attempt was claimed but the applied state remains; it was not retried.",
          );
        }
        if (current.state !== "FAILED" || current.failureCode !== "ROLLBACK_AMBIGUOUS") {
          const failed: ChangeSetRecord = {
            ...current,
            state: "FAILED",
            updatedAt: now(),
            appliedHash: current.appliedHash ?? fresh.hash,
            failureCode: "ROLLBACK_AMBIGUOUS",
            verification: verification(current.expectedBeforeHash, fresh.hash),
          };
          this.store.appendChangeSet(failed);
        }
        throw new TildaEngineError(
          "ROLLBACK_AMBIGUOUS",
          "A prior rollback attempt left an unexpected state; no retry is allowed.",
        );
      }

      const alreadyBaseline = fresh.hash === current.expectedBeforeHash;
      const requiresRemoteRestore = fresh.hash === current.expectedAfterHash;
      if (current.state === "PLANNED" && !alreadyBaseline) {
        throw new TildaEngineError(
          "STALE_TARGET",
          "Unapplied target no longer matches its snapshot; rollback was not attempted.",
        );
      }
      if (
        (current.state === "APPLIED" || current.state === "VERIFIED") &&
        !requiresRemoteRestore
      ) {
        throw new TildaEngineError(
          "STALE_TARGET",
          "Applied target changed after verification; rollback was not attempted.",
        );
      }
      if (current.state === "FAILED" && !alreadyBaseline && !requiresRemoteRestore) {
        throw new TildaEngineError(
          "STALE_TARGET",
          "Failed ChangeSet target is neither the exact before nor after state.",
        );
      }

      const material = requiresRemoteRestore ? this.vault.get(current.changeSetId) : null;
      if (material !== null && material.before.hash !== current.expectedBeforeHash) {
        throw new TildaEngineError(
          "SNAPSHOT_MISMATCH",
          "Volatile snapshot is not exactly bound to this ChangeSet.",
        );
      }
      const claim = this.store.claimActionIdempotency(
        idempotencyKey,
        "rollback",
        current.changeSetId,
      );
      if (claim !== "CLAIMED") {
        throw new TildaEngineError("RECOVERY_REQUIRED", "Rollback claim changed concurrently.");
      }

      if (!requiresRemoteRestore) {
        const rolledBack: ChangeSetRecord = {
          ...current,
          state: "ROLLED_BACK",
          updatedAt: now(),
          verification: verification(current.expectedBeforeHash, fresh.hash),
        };
        this.store.appendChangeSet(rolledBack);
        this.vault.delete(current.changeSetId);
        return { changeSet: rolledBack, stateChanged: false, dryRun: false };
      }

      let restored: AdapterState | null = null;
      let restoreThrew = false;
      let restoreErrorCode: string | null = null;
      try {
        const candidate = await adapter.restore(current.target, material!.before);
        assertStateHash(candidate, "restored state");
        restored = await diagnosticRead(adapter, current.target);
      } catch (error) {
        restoreThrew = true;
        restoreErrorCode = tildaErrorCode(error);
        restored = await diagnosticRead(adapter, current.target);
      }
      if (restoreErrorCode === "HEAD_RESTORE_VERIFICATION_AMBIGUOUS") {
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          ...(restored === null
            ? {}
            : { verification: verification(current.expectedBeforeHash, restored.hash) }),
          failureCode: "ROLLBACK_AMBIGUOUS",
        };
        this.store.appendChangeSet(failed);
        throw new TildaEngineError(
          "ROLLBACK_AMBIGUOUS",
          "HEAD restore verification was unstable; success reconciliation is disabled.",
        );
      }
      if (restored?.hash === current.expectedBeforeHash) {
        const rolledBack: ChangeSetRecord = {
          ...current,
          state: "ROLLED_BACK",
          updatedAt: now(),
          ...(restoreThrew ? { reconciliationCode: "ROLLBACK_ERROR_RECONCILED" } : {}),
          verification: verification(current.expectedBeforeHash, restored.hash),
        };
        this.store.appendChangeSet(rolledBack);
        this.vault.delete(current.changeSetId);
        return { changeSet: rolledBack, stateChanged: true, dryRun: false };
      }

      if (restored?.hash === current.expectedAfterHash) {
        const failed: ChangeSetRecord = {
          ...current,
          state: "FAILED",
          updatedAt: now(),
          failureCode: "ROLLBACK_FAILED_UNCHANGED",
          verification: verification(current.expectedAfterHash, restored.hash),
        };
        this.store.appendChangeSet(failed);
        throw new TildaEngineError(
          "ROLLBACK_FAILED_UNCHANGED",
          "Rollback did not change the exact applied state; it was not retried.",
        );
      }
      const failed: ChangeSetRecord = {
        ...current,
        state: "FAILED",
        updatedAt: now(),
        ...(restored === null
          ? {}
          : { verification: verification(current.expectedBeforeHash, restored.hash) }),
        failureCode: "ROLLBACK_AMBIGUOUS",
      };
      this.store.appendChangeSet(failed);
      throw new TildaEngineError(
        "ROLLBACK_AMBIGUOUS",
        "Rollback could not prove exact restoration; one diagnostic reread ran and no retry is allowed.",
      );
    });
  }
}
