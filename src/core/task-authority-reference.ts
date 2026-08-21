import type {
  ReferencePageCleanupEvidence,
  ReferencePageReceipt,
} from "../adapters/reference-page-lifecycle.js";
import { ReferencePageLifecycleController } from "../adapters/reference-page-lifecycle.js";
import type { PageTarget } from "./contracts.js";
import { TildaEngineError } from "./contracts.js";
import { TaskAuthorityManager } from "./task-authority-manager.js";

interface ReferenceLineage {
  readonly taskId: string;
  readonly grantHash: string;
  readonly createdPageIds: readonly string[];
}

/**
 * Keeps a verified same-task reference clone usable across the inventory hash
 * change it causes. Only the controller's process-owned receipt/evidence can
 * advance the binding, and cleanup consumes that lineage before dispatch.
 */
export class TaskScopedReferencePageLifecycleController {
  readonly #lineage = new WeakMap<object, ReferenceLineage>();

  constructor(
    readonly controller: ReferencePageLifecycleController,
    readonly authority: TaskAuthorityManager,
  ) {}

  async createPageFromReference(source: PageTarget) {
    const mutationLease = this.authority.beginReferenceInventoryMutation(source);
    try {
      const current = this.authority.currentReceipt();
      if (current === null) {
        throw new TildaEngineError("TASK_AUTHORITY_REQUIRED", "No active task authority is available.");
      }
      const created = await this.controller.createPageFromReference(source);
      const rebound = this.authority.acceptVerifiedReferenceInventoryTransition({
        operation: "page.reference.clone",
        expectedTaskId: current.taskId,
        expectedGrantHash: current.grantHash,
        mutationLease,
        receipt: created.receipt,
        beforePageIds: created.evidence.baselinePageIds,
        afterPageIds: created.evidence.createdPageIds,
      });
      if (rebound.taskId !== current.taskId || rebound.grantHash !== current.grantHash) {
        throw new TildaEngineError(
          "TASK_INVENTORY_LINEAGE_CHANGED",
          "Verified inventory rebinding changed the task authorization lineage.",
        );
      }
      this.#lineage.set(created.receipt, Object.freeze({
        taskId: current.taskId,
        grantHash: current.grantHash,
        createdPageIds: Object.freeze([...created.evidence.createdPageIds]),
      }));
      return created;
    } finally {
      this.authority.endReferenceInventoryMutation(mutationLease);
    }
  }

  async cleanupCreatedReference(
    receipt: ReferencePageReceipt,
  ): Promise<ReferencePageCleanupEvidence> {
    const lineage = this.#lineage.get(receipt);
    const current = this.authority.currentReceipt();
    if (
      lineage === undefined ||
      current === null ||
      current.taskId !== lineage.taskId ||
      current.grantHash !== lineage.grantHash
    ) {
      throw new TildaEngineError(
        "TASK_INVENTORY_LINEAGE_MISMATCH",
        "Reference cleanup requires its unconsumed receipt under the same active task lineage.",
      );
    }
    const mutationLease = this.authority.beginReferenceInventoryMutation(receipt.source, receipt);
    try {
      // The underlying controller also consumes its opaque token before remote
      // dispatch. Mirror that fail-closed boundary so ambiguous cleanup is never retried.
      this.#lineage.delete(receipt);
      const cleaned = await this.controller.cleanupCreatedReference(receipt);
      const rebound = this.authority.acceptVerifiedReferenceInventoryTransition({
        operation: "page.reference.cleanup",
        expectedTaskId: lineage.taskId,
        expectedGrantHash: lineage.grantHash,
        mutationLease,
        receipt,
        beforePageIds: lineage.createdPageIds,
        afterPageIds: cleaned.activePageIds,
      });
      if (rebound.taskId !== lineage.taskId || rebound.grantHash !== lineage.grantHash) {
        throw new TildaEngineError(
          "TASK_INVENTORY_LINEAGE_CHANGED",
          "Verified cleanup rebinding changed the task authorization lineage.",
        );
      }
      return cleaned;
    } finally {
      this.authority.endReferenceInventoryMutation(mutationLease);
    }
  }
}
