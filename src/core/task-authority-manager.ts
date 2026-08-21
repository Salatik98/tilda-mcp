import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { ChangeOperation, ExactTarget, PageTarget } from "./contracts.js";
import { TildaEngineError } from "./contracts.js";
import { hashLiveInventory, type LiveInventory } from "../research/config.js";
import {
  consumeVerifiedReferencePageReceipt,
  type ReferencePageReceipt,
} from "../adapters/reference-page-lifecycle.js";
import type {
  TaskAccountBinding,
  TaskAuthorityGrant,
  TaskAuthorityMode,
  TaskAuthorityReceipt,
  TaskExecutionLease,
  TaskMutationDispatchLease,
  TaskPublicationGrant,
} from "./task-authority.js";
import {
  MAX_TASK_AUTHORITY_TTL_MS,
  taskScopeCovers,
  TaskAuthorityGuard,
} from "./task-authority.js";

export { MAX_TASK_AUTHORITY_TTL_MS } from "./task-authority.js";

export const DEFAULT_TASK_AUTHORITY_TTL_MS = 15 * 60 * 1_000;
export const MAX_TASK_DESCRIPTION_BYTES = 16 * 1_024;

export interface MintTaskAuthorityInput {
  /** Used only long enough to derive instructionHash; never retained or returned. */
  readonly taskDescription: string;
  readonly mode: TaskAuthorityMode;
  readonly observeTargets: readonly ExactTarget[];
  readonly writeTargets: readonly ExactTarget[];
  readonly allowedOperations: readonly ChangeOperation[];
  readonly publication?: TaskPublicationGrant;
  /** Must come from a fresh same-session account/inventory capture. */
  readonly binding: TaskAccountBinding;
  /** Sanitized exact inventory from the same trusted capture; enables verified lineage rebinding. */
  readonly inventory?: LiveInventory;
  readonly ttlMs?: number;
}

export interface VerifiedReferenceInventoryTransition {
  readonly operation: "page.reference.clone" | "page.reference.cleanup";
  readonly expectedTaskId: string;
  readonly expectedGrantHash: string;
  readonly mutationLease: TaskReferenceMutationLease;
  readonly receipt: ReferencePageReceipt;
  readonly beforePageIds: readonly string[];
  readonly afterPageIds: readonly string[];
}

export interface TaskReferenceMutationLease {
  readonly kind: "task-reference-mutation-lease";
}

export interface TaskAuthorityManagerOptions {
  readonly now?: () => Date;
  readonly createTaskId?: () => string;
}

interface ActiveAuthority {
  readonly guard: TaskAuthorityGuard;
  readonly expiresAtMs: number;
  readonly grant: TaskAuthorityGrant;
  readonly inventory: LiveInventory | null;
  readonly pendingReferenceReceipt: ReferencePageReceipt | null;
}

function managerError(code: string, message: string): never {
  throw new TildaEngineError(code, message);
}

function instructionHash(description: string): string {
  return `sha256:${createHash("sha256")
    .update("tilda-mcp-task-instruction-v1\0")
    .update(description, "utf8")
    .digest("hex")}`;
}

function assertTaskDescription(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    managerError("TASK_DESCRIPTION_INVALID", "Task description must contain user intent.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TASK_DESCRIPTION_BYTES) {
    managerError(
      "TASK_DESCRIPTION_TOO_LARGE",
      `Task description exceeds the ${MAX_TASK_DESCRIPTION_BYTES}-byte authority limit.`,
    );
  }
}

function boundedTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TASK_AUTHORITY_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TASK_AUTHORITY_TTL_MS) {
    managerError(
      "TASK_AUTHORITY_TTL_INVALID",
      `Task authority TTL must be an integer from 1 to ${MAX_TASK_AUTHORITY_TTL_MS}ms.`,
    );
  }
  return ttl;
}

const CANONICAL_ID = /^[1-9][0-9]*$/u;

function canonicalPageIds(ids: readonly string[], field: string): readonly string[] {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !CANONICAL_ID.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    managerError("TASK_INVENTORY_LINEAGE_INVALID", `${field} must contain unique canonical page IDs.`);
  }
  return [...ids];
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function trustedInventory(
  inventory: LiveInventory | undefined,
  binding: TaskAccountBinding,
): LiveInventory | null {
  if (inventory === undefined) return null;
  const cloned = structuredClone(inventory);
  let digest: string;
  try {
    digest = hashLiveInventory(cloned);
  } catch {
    managerError("TASK_INVENTORY_INVALID", "Trusted task inventory is malformed.");
  }
  if (
    cloned.accountFingerprint !== binding.accountFingerprint ||
    digest !== binding.inventoryHash
  ) {
    managerError(
      "TASK_INVENTORY_INVALID",
      "Trusted task inventory does not match the supplied account/inventory binding.",
    );
  }
  return cloned;
}

/**
 * Owns one ephemeral authority for the current process. It never writes to
 * disk and retains only the sanitized grant/inventory needed to validate the
 * current guard and verified inventory lineage. Raw task text is never kept.
 * Integrators should resolve currentGuard() immediately before each operation.
 */
export class TaskAuthorityManager {
  readonly #now: () => Date;
  readonly #createTaskId: () => string;
  #active: ActiveAuthority | null = null;
  #revocationToken: object = Object.freeze({});
  #referenceMutationLease: TaskReferenceMutationLease | null = null;
  #mutationDispatchLease: object | null = null;
  #taskExecutionLease: object | null = null;

  constructor(options: TaskAuthorityManagerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#createTaskId = options.createTaskId ?? randomUUID;
  }

  mint(input: MintTaskAuthorityInput): TaskAuthorityReceipt {
    this.#assertNoAuthorityTransition();
    if (this.#current() !== null) {
      managerError(
        "TASK_AUTHORITY_ALREADY_ACTIVE",
        "An active task authority already exists; replace or clear it explicitly.",
      );
    }
    const token = Object.freeze({});
    const active = this.#build(input, token);
    this.#revocationToken = token;
    this.#active = active;
    return active.guard.receipt();
  }

  /** Builds and validates first, so an invalid replacement preserves the active grant. */
  replace(input: MintTaskAuthorityInput): TaskAuthorityReceipt {
    this.#assertNoAuthorityTransition();
    this.#current();
    const token = Object.freeze({});
    const replacement = this.#build(input, token);
    this.#revocationToken = token;
    this.#active = replacement;
    return replacement.guard.receipt();
  }

  currentGuard(): TaskAuthorityGuard | null {
    return this.#current()?.guard ?? null;
  }

  requireGuard(): TaskAuthorityGuard {
    const guard = this.currentGuard();
    if (guard === null) {
      managerError("TASK_AUTHORITY_REQUIRED", "No active task authority is available.");
    }
    return guard;
  }

  currentReceipt(): TaskAuthorityReceipt | null {
    return this.#current()?.guard.receipt() ?? null;
  }

  beginReferenceInventoryMutation(
    source: PageTarget,
    receipt?: ReferencePageReceipt,
  ): TaskReferenceMutationLease {
    if (this.#referenceMutationLease !== null) {
      managerError(
        "TASK_INVENTORY_LINEAGE_BUSY",
        "Another reference inventory transition is already in flight.",
      );
    }
    this.assertReferenceLineageReady(source, receipt);
    const lease = Object.freeze({ kind: "task-reference-mutation-lease" as const });
    this.#referenceMutationLease = lease;
    return lease;
  }

  endReferenceInventoryMutation(lease: TaskReferenceMutationLease): void {
    if (this.#referenceMutationLease === lease) this.#referenceMutationLease = null;
  }

  /**
   * Preflight for a create/cleanup pair whose created page ID is not known yet.
   * Only a project-wide exact write scope can safely cover that future page.
   */
  assertReferenceLineageReady(
    source: PageTarget,
    receipt?: ReferencePageReceipt,
  ): void {
    const active = this.#current();
    if (active === null) {
      managerError("TASK_AUTHORITY_REQUIRED", "No active task authority is available.");
    }
    active.guard.assertChange("page.reference.clone", source);
    active.guard.assertChange("page.reference.cleanup", source);
    if (
      (receipt === undefined && active.pendingReferenceReceipt !== null) ||
      (receipt !== undefined && active.pendingReferenceReceipt !== receipt)
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_BUSY",
        receipt === undefined
          ? "One reference clone is already pending cleanup in this task."
          : "Reference cleanup receipt is not the active pending task lineage.",
      );
    }
    if (
      active.inventory === null ||
      !active.inventory.projectIds.includes(source.projectId) ||
      !active.inventory.pageOwnership[source.projectId]?.includes(source.pageId)
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_UNAVAILABLE",
        "Reference-page lineage requires the fresh sanitized task inventory.",
      );
    }
    if (
      !active.grant.writeTargets.some(
        (scope) => scope.kind === "project" && scope.projectId === source.projectId,
      )
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_SCOPE_DENIED",
        "Reference clone lineage requires an exact writable project scope for the future page.",
      );
    }
  }

  /**
   * Rebinds only the inventory freshness digest after an adapter-owned receipt
   * proves one exact page addition or removal. User scope, account, taskId,
   * expiry, operations, and publication authority cannot change here.
   */
  acceptVerifiedReferenceInventoryTransition(
    transition: VerifiedReferenceInventoryTransition,
  ): TaskAuthorityReceipt {
    this.#assertNoAuthorityTransition(true);
    const active = this.#current();
    if (active === null) {
      managerError("TASK_AUTHORITY_REQUIRED", "No active task authority is available.");
    }
    const current = active.guard.receipt();
    if (this.#referenceMutationLease !== transition.mutationLease) {
      managerError(
        "TASK_INVENTORY_LINEAGE_MISMATCH",
        "Verified inventory transition is not owned by the active process mutation lease.",
      );
    }
    if (
      current.taskId !== transition.expectedTaskId ||
      current.grantHash !== transition.expectedGrantHash
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_MISMATCH",
        "Active task authority changed before the verified inventory transition completed.",
      );
    }
    const { source, created: changedPage } = transition.receipt;
    if (
      transition.receipt.kind !== "reference_page_receipt" ||
      !Object.isFrozen(transition.receipt) ||
      source.kind !== "page" ||
      changedPage.kind !== "page" ||
      !CANONICAL_ID.test(source.projectId) ||
      !CANONICAL_ID.test(source.pageId) ||
      !CANONICAL_ID.test(changedPage.projectId) ||
      !CANONICAL_ID.test(changedPage.pageId) ||
      source.projectId !== changedPage.projectId ||
      source.pageId === changedPage.pageId
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_INVALID",
        "Reference-page transition targets are not one exact same-project clone lineage.",
      );
    }
    if (
      (transition.operation === "page.reference.clone" && active.pendingReferenceReceipt !== null) ||
      (transition.operation === "page.reference.cleanup" &&
        active.pendingReferenceReceipt !== transition.receipt)
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_BUSY",
        "Verified reference receipt is not the one pending in this task lineage.",
      );
    }
    active.guard.assertChange(transition.operation, source);
    if (active.inventory === null) {
      managerError(
        "TASK_INVENTORY_LINEAGE_UNAVAILABLE",
        "Reference-page lineage requires the fresh sanitized task inventory.",
      );
    }
    if (!active.grant.writeTargets.some((scope) => taskScopeCovers(scope, changedPage))) {
      managerError(
        "TASK_INVENTORY_LINEAGE_SCOPE_DENIED",
        "The verified created page is outside the existing task write scope.",
      );
    }
    const currentPageIds = active.inventory.pageOwnership[source.projectId];
    if (currentPageIds === undefined || !active.inventory.projectIds.includes(source.projectId)) {
      managerError(
        "TASK_INVENTORY_LINEAGE_INVALID",
        "Reference source project is absent from the bound task inventory.",
      );
    }
    const before = canonicalPageIds(transition.beforePageIds, "beforePageIds");
    const after = canonicalPageIds(transition.afterPageIds, "afterPageIds");
    if (!sameIdSet(before, currentPageIds)) {
      managerError(
        "TASK_INVENTORY_LINEAGE_MISMATCH",
        "Verified transition baseline does not match the active task inventory.",
      );
    }
    const exactTransition = transition.operation === "page.reference.clone"
      ? !before.includes(changedPage.pageId) &&
        after.length === before.length + 1 &&
        after.includes(changedPage.pageId) &&
        before.every((pageId) => after.includes(pageId)) &&
        before.includes(source.pageId)
      : before.includes(changedPage.pageId) &&
        after.length === before.length - 1 &&
        !after.includes(changedPage.pageId) &&
        after.every((pageId) => before.includes(pageId)) &&
        after.includes(source.pageId);
    if (!exactTransition) {
      managerError(
        "TASK_INVENTORY_LINEAGE_INVALID",
        "Adapter receipt did not prove exactly one authorized page addition or removal.",
      );
    }
    const nextInventory: LiveInventory = {
      accountFingerprint: active.inventory.accountFingerprint,
      projectIds: [...active.inventory.projectIds],
      pageOwnership: {
        ...structuredClone(active.inventory.pageOwnership),
        [source.projectId]: [...after],
      },
    };
    let inventoryHash: string;
    try {
      inventoryHash = hashLiveInventory(nextInventory);
    } catch {
      managerError("TASK_INVENTORY_LINEAGE_INVALID", "Derived task inventory is malformed.");
    }
    const nextGrant: TaskAuthorityGrant = {
      ...structuredClone(active.grant),
      accountBinding: {
        accountFingerprint: active.grant.accountBinding.accountFingerprint,
        inventoryHash,
      },
    };
    const token = Object.freeze({});
    const replacement = this.#activateGrant(
      nextGrant,
      nextInventory,
      token,
      this.#nowIso(),
      transition.operation === "page.reference.clone" ? transition.receipt : null,
    );
    if (
      transition.operation === "page.reference.clone" &&
      !consumeVerifiedReferencePageReceipt(transition.receipt)
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_RECEIPT_REJECTED",
        "Reference clone rebinding requires one unconsumed process-owned adapter receipt.",
      );
    }
    this.#revocationToken = token;
    this.#active = replacement;
    return replacement.guard.receipt();
  }

  clear(): boolean {
    this.#assertNoAuthorityTransition();
    const existed = this.#active !== null;
    this.#active = null;
    this.#revocationToken = Object.freeze({});
    this.#referenceMutationLease = null;
    return existed;
  }

  close(): boolean {
    return this.clear();
  }

  #current(): ActiveAuthority | null {
    if (
      this.#active !== null &&
      this.#mutationDispatchLease === null &&
      this.#taskExecutionLease === null &&
      this.#nowMs() >= this.#active.expiresAtMs
    ) {
      this.#active = null;
      this.#revocationToken = Object.freeze({});
      this.#referenceMutationLease = null;
    }
    return this.#active;
  }

  #build(input: MintTaskAuthorityInput, token: object): ActiveAuthority {
    assertTaskDescription(input.taskDescription);
    const ttlMs = boundedTtl(input.ttlMs);
    const issuedAtMs = this.#nowMs();
    if (issuedAtMs > 8_640_000_000_000_000 - ttlMs) {
      managerError("TASK_AUTHORITY_CLOCK_INVALID", "Current time cannot produce a valid expiry.");
    }
    const issuedAt = new Date(issuedAtMs).toISOString();
    const expiresAtMs = issuedAtMs + ttlMs;
    const grant: TaskAuthorityGrant = {
      format: "tilda-mcp-task-authority-v1" as const,
      taskId: this.#createTaskId(),
      mode: input.mode,
      instructionHash: instructionHash(input.taskDescription),
      issuedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      accountBinding: structuredClone(input.binding),
      observeTargets: structuredClone(input.observeTargets),
      writeTargets: structuredClone(input.writeTargets),
      allowedOperations: [...input.allowedOperations],
      ...(input.publication === undefined
        ? {}
        : { publication: structuredClone(input.publication) }),
    };
    return this.#activateGrant(
      grant,
      trustedInventory(input.inventory, input.binding),
      token,
      issuedAt,
      null,
    );
  }

  #activateGrant(
    grant: TaskAuthorityGrant,
    inventory: LiveInventory | null,
    token: object,
    now: string,
    pendingReferenceReceipt: ReferencePageReceipt | null,
  ): ActiveAuthority {
    const guard = new TaskAuthorityGuard(grant, grant.accountBinding, {
      now,
      clock: () => this.#nowIso(),
      isRevoked: () => this.#revocationToken !== token,
      beginMutationDispatch: () => this.#beginMutationDispatch(token),
      beginTaskExecution: () => this.#beginTaskExecution(token),
    });
    return Object.freeze({
      guard,
      expiresAtMs: Date.parse(grant.expiresAt),
      grant: structuredClone(grant),
      inventory: inventory === null ? null : structuredClone(inventory),
      pendingReferenceReceipt,
    });
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString();
  }

  #beginMutationDispatch(authorityToken: object): TaskMutationDispatchLease {
    if (
      this.#active === null ||
      this.#revocationToken !== authorityToken
    ) {
      managerError("TASK_AUTHORITY_REVOKED", "Task authority was replaced or cleared.");
    }
    this.#assertNoMutationDispatch();
    const leaseToken = Object.freeze({});
    this.#mutationDispatchLease = leaseToken;
    let released = false;
    return Object.freeze({
      kind: "task-mutation-dispatch-lease" as const,
      release: () => {
        if (released) return;
        released = true;
        if (this.#mutationDispatchLease === leaseToken) {
          this.#mutationDispatchLease = null;
        }
      },
    });
  }

  #beginTaskExecution(authorityToken: object): TaskExecutionLease {
    if (
      this.#active === null ||
      this.#revocationToken !== authorityToken
    ) {
      managerError("TASK_AUTHORITY_REVOKED", "Task authority was replaced or cleared.");
    }
    if (this.#taskExecutionLease !== null) {
      managerError(
        "TASK_AUTHORITY_EXECUTION_IN_PROGRESS",
        "Another multi-phase task execution already owns the active authority.",
      );
    }
    const leaseToken = Object.freeze({});
    this.#taskExecutionLease = leaseToken;
    let released = false;
    return Object.freeze({
      kind: "task-execution-lease" as const,
      release: () => {
        if (released) return;
        released = true;
        if (this.#taskExecutionLease === leaseToken) {
          this.#taskExecutionLease = null;
        }
      },
    });
  }

  #assertNoMutationDispatch(): void {
    if (this.#mutationDispatchLease !== null) {
      managerError(
        "TASK_AUTHORITY_MUTATION_IN_PROGRESS",
        "Task authority cannot be cleared or replaced while a remote mutation transaction is in progress.",
      );
    }
  }

  #assertNoAuthorityTransition(allowVerifiedReferenceTransition = false): void {
    if (
      !allowVerifiedReferenceTransition &&
      (
        this.#referenceMutationLease !== null ||
        (this.#active !== null && this.#active.pendingReferenceReceipt !== null)
      )
    ) {
      managerError(
        "TASK_INVENTORY_LINEAGE_BUSY",
        "The active task has an in-flight or pending reference clone that must be cleaned up first.",
      );
    }
    this.#assertNoMutationDispatch();
    if (this.#taskExecutionLease !== null) {
      managerError(
        "TASK_AUTHORITY_EXECUTION_IN_PROGRESS",
        "Task authority cannot be cleared or replaced while a multi-phase task execution is in progress.",
      );
    }
  }

  #nowMs(): number {
    const value = this.#now();
    const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isFinite(milliseconds)) {
      managerError("TASK_AUTHORITY_CLOCK_INVALID", "Authority clock returned an invalid date.");
    }
    return milliseconds;
  }
}
