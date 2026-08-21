import { isDeepStrictEqual } from "node:util";

import { canonicalHash } from "../research/hash.js";
import type {
  ChangeRequest,
  ChangeSetTaskAuthority,
  ExactTarget,
  PageTarget,
} from "./contracts.js";
import { CHANGE_OPERATIONS, TildaEngineError } from "./contracts.js";
import type { ChangeOperation } from "./contracts.js";
import type { EngineActionResult, TildaChangeSetEngine } from "./engine.js";
import type {
  PublicationAction,
  PublicationActionResult,
  PublicationController,
} from "./publication.js";

export const TASK_AUTHORITY_MODES = ["observe", "copy-test", "production"] as const;
export type TaskAuthorityMode = (typeof TASK_AUTHORITY_MODES)[number];
export const MAX_TASK_AUTHORITY_TTL_MS = 30 * 60 * 1_000;

export interface TaskAccountBinding {
  /** HMAC-derived value; never the raw account identity. */
  readonly accountFingerprint: string;
  /** Digest of the complete same-session project/page inventory. */
  readonly inventoryHash: string;
}

export interface TaskPublicationGrant {
  readonly actions: readonly PublicationAction[];
  readonly targets: readonly PageTarget[];
}

/**
 * Ephemeral authority derived from one user task. The raw user instruction,
 * content, credentials, and browser data must not be embedded in this object.
 */
export interface TaskAuthorityGrant {
  readonly format: "tilda-mcp-task-authority-v1";
  readonly taskId: string;
  readonly mode: TaskAuthorityMode;
  readonly instructionHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly accountBinding: TaskAccountBinding;
  /** Exact source/reference scopes that are readable but never writable. */
  readonly observeTargets: readonly ExactTarget[];
  /** Exact scopes within which requests must still name their leaf targets. */
  readonly writeTargets: readonly ExactTarget[];
  readonly allowedOperations: readonly ChangeOperation[];
  readonly publication?: TaskPublicationGrant;
}

export interface TaskAuthorityReceipt {
  readonly format: "tilda-mcp-task-authority-receipt-v1";
  readonly taskId: string;
  readonly mode: TaskAuthorityMode;
  readonly grantHash: string;
  readonly instructionHash: string;
  readonly accountFingerprint: string;
  readonly inventoryHash: string;
  readonly expiresAt: string;
}

/**
 * Process-local ownership of one remote mutation dispatch. The manager keeps
 * successful clear/replace operations from crossing this boundary while an
 * adapter-owned browser transaction is still capable of issuing writes.
 */
export interface TaskMutationDispatchLease {
  readonly kind: "task-mutation-dispatch-lease";
  release(): void;
}

/** Pins one multi-phase task execution while allowing nested dispatch leases. */
export interface TaskExecutionLease {
  readonly kind: "task-execution-lease";
  release(): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_ID = /^[1-9][0-9]*$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TARGETS = 256;

function authorityError(code: string, message: string): never {
  throw new TildaEngineError(code, message);
}

function exactKeys(value: object, expected: readonly string[], field: string): void {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    authorityError("TASK_AUTHORITY_INVALID", `${field} contains missing or extra fields.`);
  }
}

function canonicalTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    authorityError("TASK_AUTHORITY_INVALID", `${field} must be a canonical ISO timestamp.`);
  }
  return parsed;
}

function assertId(value: string, field: string): void {
  if (!CANONICAL_ID.test(value)) {
    authorityError("TASK_AUTHORITY_INVALID", `${field} must be a canonical positive decimal ID.`);
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

function assertTarget(target: ExactTarget, field: string): void {
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    authorityError("TASK_AUTHORITY_INVALID", `${field} must be an exact target object.`);
  }
  switch (target.kind) {
    case "project":
      exactKeys(target, ["kind", "projectId"], field);
      assertId(target.projectId, `${field}.projectId`);
      return;
    case "page":
      exactKeys(target, ["kind", "projectId", "pageId"], field);
      assertId(target.projectId, `${field}.projectId`);
      assertId(target.pageId, `${field}.pageId`);
      return;
    case "record":
      exactKeys(target, ["kind", "projectId", "pageId", "recordId"], field);
      assertId(target.projectId, `${field}.projectId`);
      assertId(target.pageId, `${field}.pageId`);
      assertId(target.recordId, `${field}.recordId`);
      return;
    case "element":
      exactKeys(target, ["kind", "projectId", "pageId", "recordId", "elementId"], field);
      assertId(target.projectId, `${field}.projectId`);
      assertId(target.pageId, `${field}.pageId`);
      assertId(target.recordId, `${field}.recordId`);
      assertId(target.elementId, `${field}.elementId`);
      return;
    default:
      authorityError("TASK_AUTHORITY_INVALID", `${field}.kind is unsupported.`);
  }
}

function assertTargetList(targets: readonly ExactTarget[], field: string): void {
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS) {
    authorityError("TASK_AUTHORITY_INVALID", `${field} must contain at most ${MAX_TARGETS} targets.`);
  }
  const seen = new Set<string>();
  targets.forEach((target, index) => {
    assertTarget(target, `${field}[${index}]`);
    const key = targetKey(target);
    if (seen.has(key)) authorityError("TASK_AUTHORITY_INVALID", `${field} contains duplicate targets.`);
    seen.add(key);
  });
}

/** A scope covers descendants, but every operation request still carries an exact leaf target. */
export function taskScopeCovers(scope: ExactTarget, target: ExactTarget): boolean {
  if (scope.projectId !== target.projectId) return false;
  if (scope.kind === "project") return true;
  if (target.kind === "project" || scope.pageId !== target.pageId) return false;
  if (scope.kind === "page") return true;
  if (target.kind === "page" || scope.recordId !== target.recordId) return false;
  if (scope.kind === "record") return true;
  return target.kind === "element" && scope.elementId === target.elementId;
}

function scopesOverlap(left: ExactTarget, right: ExactTarget): boolean {
  return taskScopeCovers(left, right) || taskScopeCovers(right, left);
}

function hashGrant(grant: TaskAuthorityGrant): string {
  // Inventory is a freshness binding that can evolve after one adapter-owned,
  // exactly verified create/cleanup transition. The user-authorized scope and
  // account identity remain invariant, so ChangeSets keep one stable lineage.
  return canonicalHash({
    format: "tilda-mcp-task-authority-scope-v1",
    taskId: grant.taskId,
    mode: grant.mode,
    instructionHash: grant.instructionHash,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    accountFingerprint: grant.accountBinding.accountFingerprint,
    observeTargets: grant.observeTargets,
    writeTargets: grant.writeTargets,
    allowedOperations: grant.allowedOperations,
    ...(grant.publication === undefined ? {} : { publication: grant.publication }),
  });
}

function assertSameTaskReceipt(
  authority: TaskAuthorityGuard,
  expected: TaskAuthorityReceipt,
): void {
  const current = authority.receipt();
  if (!isDeepStrictEqual(current, expected)) {
    authorityError(
      "TASK_AUTHORITY_CHANGED",
      "Task authority lineage changed during one multi-phase operation.",
    );
  }
}

function assertGrant(
  grant: TaskAuthorityGrant,
  liveBinding: TaskAccountBinding,
  now: string,
): void {
  exactKeys(
    grant,
    [
      "format",
      "taskId",
      "mode",
      "instructionHash",
      "issuedAt",
      "expiresAt",
      "accountBinding",
      "observeTargets",
      "writeTargets",
      "allowedOperations",
      ...(grant.publication === undefined ? [] : ["publication"]),
    ],
    "grant",
  );
  if (grant.format !== "tilda-mcp-task-authority-v1" || !UUID.test(grant.taskId)) {
    authorityError("TASK_AUTHORITY_INVALID", "Task authority format or taskId is invalid.");
  }
  if (!(TASK_AUTHORITY_MODES as readonly string[]).includes(grant.mode)) {
    authorityError("TASK_AUTHORITY_INVALID", "Task authority mode is invalid.");
  }
  if (!SHA256.test(grant.instructionHash)) {
    authorityError("TASK_AUTHORITY_INVALID", "instructionHash must be canonical SHA-256.");
  }
  const issuedAt = canonicalTimestamp(grant.issuedAt, "issuedAt");
  const expiresAt = canonicalTimestamp(grant.expiresAt, "expiresAt");
  const current = canonicalTimestamp(now, "now");
  if (expiresAt <= issuedAt) {
    authorityError("TASK_AUTHORITY_INVALID", "Task authority must expire after it is issued.");
  }
  if (expiresAt - issuedAt > MAX_TASK_AUTHORITY_TTL_MS) {
    authorityError(
      "TASK_AUTHORITY_TTL_INVALID",
      `Task authority must not exceed ${MAX_TASK_AUTHORITY_TTL_MS}ms.`,
    );
  }
  if (current < issuedAt || current >= expiresAt) {
    authorityError("TASK_AUTHORITY_EXPIRED", "Task authority is not active at the current time.");
  }
  exactKeys(grant.accountBinding, ["accountFingerprint", "inventoryHash"], "accountBinding");
  for (const [field, value] of Object.entries(grant.accountBinding)) {
    if (!HEX_SHA256.test(value)) {
      authorityError("TASK_AUTHORITY_INVALID", `accountBinding.${field} must be a SHA-256 digest.`);
    }
  }
  if (!isDeepStrictEqual(grant.accountBinding, liveBinding)) {
    authorityError(
      "TASK_AUTHORITY_BINDING_MISMATCH",
      "Task authority does not match the fresh account and inventory binding.",
    );
  }
  assertTargetList(grant.observeTargets, "observeTargets");
  assertTargetList(grant.writeTargets, "writeTargets");
  if (
    grant.observeTargets.some((source) =>
      grant.writeTargets.some((destination) => scopesOverlap(source, destination)),
    )
  ) {
    authorityError(
      "TASK_AUTHORITY_SCOPE_OVERLAP",
      "Read-only source scopes and writable task scopes must be disjoint.",
    );
  }
  if (!Array.isArray(grant.allowedOperations)) {
    authorityError("TASK_AUTHORITY_INVALID", "allowedOperations must be an array.");
  }
  const operationSet = new Set(grant.allowedOperations);
  if (
    operationSet.size !== grant.allowedOperations.length ||
    grant.allowedOperations.some(
      (operation) => !(CHANGE_OPERATIONS as readonly string[]).includes(operation),
    )
  ) {
    authorityError("TASK_AUTHORITY_INVALID", "allowedOperations is invalid or contains duplicates.");
  }
  if (grant.mode === "observe") {
    if (
      grant.observeTargets.length === 0 ||
      grant.writeTargets.length !== 0 ||
      grant.allowedOperations.length !== 0 ||
      grant.publication !== undefined
    ) {
      authorityError("TASK_AUTHORITY_MODE_VIOLATION", "Observe mode must be strictly read-only.");
    }
  } else if (grant.writeTargets.length === 0) {
    authorityError("TASK_AUTHORITY_MODE_VIOLATION", `${grant.mode} mode requires a write target.`);
  }
  if (grant.mode === "copy-test" && grant.observeTargets.length === 0) {
    authorityError(
      "TASK_AUTHORITY_MODE_VIOLATION",
      "Copy-test mode requires at least one protected source target.",
    );
  }
  if (grant.publication !== undefined) {
    exactKeys(grant.publication, ["actions", "targets"], "publication");
    if (
      !Array.isArray(grant.publication.actions) ||
      grant.publication.actions.length === 0 ||
      new Set(grant.publication.actions).size !== grant.publication.actions.length ||
      grant.publication.actions.some((action) => action !== "publish" && action !== "unpublish")
    ) {
      authorityError("TASK_AUTHORITY_INVALID", "Publication actions are invalid.");
    }
    assertTargetList(grant.publication.targets, "publication.targets");
    if (
      grant.publication.targets.length === 0 ||
      grant.publication.targets.some(
        (target) => !grant.writeTargets.some((scope) => taskScopeCovers(scope, target)),
      )
    ) {
      authorityError(
        "TASK_AUTHORITY_PUBLICATION_SCOPE_INVALID",
        "Publication targets must be exact pages inside the writable task scope.",
      );
    }
  }
}

export class TaskAuthorityGuard {
  readonly #grant: TaskAuthorityGrant;
  readonly #receipt: TaskAuthorityReceipt;
  readonly #clock: () => string;
  readonly #isRevoked: () => boolean;
  readonly #beginMutationDispatch: (() => TaskMutationDispatchLease) | undefined;
  readonly #beginTaskExecution: (() => TaskExecutionLease) | undefined;
  readonly #issuedAtMs: number;
  readonly #expiresAtMs: number;

  constructor(
    grant: TaskAuthorityGrant,
    liveBinding: TaskAccountBinding,
    options: {
      readonly now?: string;
      readonly clock?: () => string;
      readonly isRevoked?: () => boolean;
      readonly beginMutationDispatch?: () => TaskMutationDispatchLease;
      readonly beginTaskExecution?: () => TaskExecutionLease;
    } = {},
  ) {
    const cloned = structuredClone(grant);
    this.#clock = options.clock ?? (options.now === undefined
      ? () => new Date().toISOString()
      : () => options.now!);
    this.#isRevoked = options.isRevoked ?? (() => false);
    this.#beginMutationDispatch = options.beginMutationDispatch;
    this.#beginTaskExecution = options.beginTaskExecution;
    assertGrant(cloned, liveBinding, options.now ?? this.#clock());
    this.#issuedAtMs = Date.parse(cloned.issuedAt);
    this.#expiresAtMs = Date.parse(cloned.expiresAt);
    this.#grant = Object.freeze(cloned);
    this.#receipt = Object.freeze({
      format: "tilda-mcp-task-authority-receipt-v1",
      taskId: cloned.taskId,
      mode: cloned.mode,
      grantHash: hashGrant(cloned),
      instructionHash: cloned.instructionHash,
      accountFingerprint: cloned.accountBinding.accountFingerprint,
      inventoryHash: cloned.accountBinding.inventoryHash,
      expiresAt: cloned.expiresAt,
    });
  }

  receipt(): TaskAuthorityReceipt {
    this.#assertActive();
    return structuredClone(this.#receipt);
  }

  /**
   * Acquires the manager-owned last-mile lease used by every browser mutation
   * surface. Unmanaged guards retain the old synchronous recheck semantics.
   */
  beginMutationDispatch(): TaskMutationDispatchLease {
    this.#assertActive();
    const lease = this.#beginMutationDispatch?.() ?? Object.freeze({
      kind: "task-mutation-dispatch-lease" as const,
      release: () => undefined,
    });
    try {
      // Recheck after manager acquisition so a stale guard can never retain a
      // lease obtained during an authority transition.
      this.#assertActive();
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /**
   * Pins the active grant across a bounded multi-phase workflow. Individual
   * remote writes still acquire their own nested mutation-dispatch lease.
   */
  beginTaskExecution(): TaskExecutionLease {
    this.#assertActive();
    const lease = this.#beginTaskExecution?.() ?? Object.freeze({
      kind: "task-execution-lease" as const,
      release: () => undefined,
    });
    try {
      this.#assertActive();
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  assertRead(target: ExactTarget): void {
    this.#assertActive();
    assertTarget(target, "read target");
    if (
      ![...this.#grant.observeTargets, ...this.#grant.writeTargets].some((scope) =>
        taskScopeCovers(scope, target),
      ) &&
      !this.#grant.publication?.targets.some((scope) => taskScopeCovers(scope, target))
    ) {
      authorityError("TASK_READ_DENIED", "Target is outside this task's exact read scopes.");
    }
  }

  assertChange(operation: ChangeOperation, target: ExactTarget): void {
    this.#assertActive();
    assertTarget(target, "write target");
    if (this.#grant.mode === "observe") {
      authorityError("TASK_WRITE_DENIED", "Observe mode cannot create or execute mutations.");
    }
    if (!this.#grant.allowedOperations.includes(operation)) {
      authorityError("TASK_OPERATION_DENIED", "Operation is outside this task's typed operation scope.");
    }
    if (!this.#grant.writeTargets.some((scope) => taskScopeCovers(scope, target))) {
      authorityError("TASK_WRITE_DENIED", "Target is outside this task's exact writable scopes.");
    }
  }

  assertRequest(request: ChangeRequest): void {
    this.assertChange(request.operation, request.target);
  }

  assertRollback(operation: ChangeOperation, target: ExactTarget): void {
    this.#assertActive();
    assertTarget(target, "rollback target");
    if (
      this.#grant.mode === "observe" ||
      !this.#grant.allowedOperations.includes(operation) ||
      !this.#grant.writeTargets.some((scope) => taskScopeCovers(scope, target))
    ) {
      authorityError(
        "TASK_ROLLBACK_DENIED",
        "Rollback operation or target is outside this task's write scope.",
      );
    }
  }

  assertPublication(action: PublicationAction, target: PageTarget): void {
    this.#assertActive();
    assertTarget(target, "publication target");
    const publication = this.#grant.publication;
    if (
      this.#grant.mode === "observe" ||
      publication === undefined ||
      !publication.actions.includes(action) ||
      !publication.targets.some((scope) => taskScopeCovers(scope, target))
    ) {
      authorityError(
        "TASK_PUBLICATION_DENIED",
        "Publication is a separate action and is not included in this task authority.",
      );
    }
  }

  assertCopyTestWrite(target: ExactTarget): void {
    this.#assertActive();
    assertTarget(target, "copy-test target");
    if (
      this.#grant.mode !== "copy-test" ||
      !this.#grant.writeTargets.some((scope) => taskScopeCovers(scope, target))
    ) {
      authorityError(
        "TASK_COPY_TEST_DENIED",
        "Capability learning requires an exact writable target in the active copy-test task.",
      );
    }
  }

  assertChangeSetAuthority(authority: ChangeSetTaskAuthority | undefined): void {
    this.#assertActive();
    if (
      authority === undefined ||
      authority.taskId !== this.#receipt.taskId ||
      authority.grantHash !== this.#receipt.grantHash
    ) {
      authorityError(
        "TASK_CHANGESET_AUTHORITY_MISMATCH",
        "ChangeSet was not planned by the active exact task authority.",
      );
    }
  }

  #assertActive(): void {
    if (this.#isRevoked()) {
      authorityError("TASK_AUTHORITY_REVOKED", "Task authority was replaced or cleared.");
    }
    const current = canonicalTimestamp(this.#clock(), "now");
    if (current < this.#issuedAtMs || current >= this.#expiresAtMs) {
      authorityError("TASK_AUTHORITY_EXPIRED", "Task authority is not active at the current time.");
    }
  }
}

/** Integration seam that keeps the proven ChangeSet engine unchanged. */
export class TaskScopedChangeSetEngine {
  constructor(
    readonly engine: TildaChangeSetEngine,
    readonly authority: TaskAuthorityGuard,
  ) {}

  capabilities() {
    return this.engine.capabilities();
  }

  async query(request: ChangeRequest) {
    this.authority.assertRead(request.target);
    return this.engine.query(request);
  }

  async plan(
    request: ChangeRequest,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<EngineActionResult> {
    this.authority.assertRequest(request);
    const receipt = this.authority.receipt();
    const result = await this.engine.plan(request, {
      ...options,
      taskAuthority: { taskId: receipt.taskId, grantHash: receipt.grantHash },
    });
    this.authority.assertChangeSetAuthority(result.changeSet.taskAuthority);
    return result;
  }

  async apply(
    changeSetId: string,
    dryRun = true,
    idempotencyKey?: string,
  ): Promise<EngineActionResult> {
    const record = this.engine.store.loadChangeSet(changeSetId);
    this.authority.assertChangeSetAuthority(record.taskAuthority);
    if (dryRun) {
      this.authority.assertRead(record.target);
      return this.engine.apply(changeSetId, true, idempotencyKey);
    }
    this.authority.assertChange(record.operation, record.target);
    const expectedAuthority = this.authority.receipt();
    const execution = this.authority.beginTaskExecution();
    try {
      assertSameTaskReceipt(this.authority, expectedAuthority);
      const result = await this.engine.apply(changeSetId, false, idempotencyKey);
      this.authority.assertChangeSetAuthority(result.changeSet.taskAuthority);
      assertSameTaskReceipt(this.authority, expectedAuthority);
      return result;
    } finally {
      execution.release();
    }
  }

  async verify(changeSetId: string): Promise<EngineActionResult> {
    const record = this.engine.store.loadChangeSet(changeSetId);
    this.authority.assertChangeSetAuthority(record.taskAuthority);
    this.authority.assertRead(record.target);
    return this.engine.verify(changeSetId);
  }

  async rollback(
    changeSetId: string,
    dryRun = true,
    idempotencyKey?: string,
  ): Promise<EngineActionResult> {
    const record = this.engine.store.loadChangeSet(changeSetId);
    this.authority.assertChangeSetAuthority(record.taskAuthority);
    if (dryRun) {
      this.authority.assertRead(record.target);
      return this.engine.rollback(changeSetId, true, idempotencyKey);
    }
    this.authority.assertRollback(record.operation, record.target);
    const expectedAuthority = this.authority.receipt();
    const execution = this.authority.beginTaskExecution();
    try {
      assertSameTaskReceipt(this.authority, expectedAuthority);
      const result = await this.engine.rollback(changeSetId, false, idempotencyKey);
      this.authority.assertChangeSetAuthority(result.changeSet.taskAuthority);
      assertSameTaskReceipt(this.authority, expectedAuthority);
      return result;
    } finally {
      execution.release();
    }
  }
}

/** Publication stays outside content ChangeSets and requires its own task flag. */
export class TaskScopedPublicationController {
  constructor(
    readonly publication: PublicationController,
    readonly authority: TaskAuthorityGuard,
  ) {}

  async execute(
    action: PublicationAction,
    target: PageTarget,
    options: { readonly dryRun?: boolean; readonly idempotencyKey?: string } = {},
  ): Promise<PublicationActionResult> {
    if (options.dryRun !== false) {
      this.authority.assertRead(target);
      return this.publication.execute(action, target, options);
    }
    this.authority.assertPublication(action, target);
    const expectedAuthority = this.authority.receipt();
    const execution = this.authority.beginTaskExecution();
    try {
      assertSameTaskReceipt(this.authority, expectedAuthority);
      const result = await this.publication.execute(action, target, options);
      this.authority.assertPublication(action, target);
      assertSameTaskReceipt(this.authority, expectedAuthority);
      return result;
    } finally {
      execution.release();
    }
  }
}
