import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ChangeSetRecord,
  ChangeSetState,
  PublicationJournalRecord,
  SnapshotEnvelope,
} from "./contracts.js";
import {
  CHANGE_OPERATIONS,
  CHANGESET_STATES,
  PUBLICATION_JOURNAL_STATES,
  TildaEngineError,
} from "./contracts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT = /^([0-9]{6})\.json$/;
const CANONICAL_HASH = /^sha256:[a-f0-9]{64}$/;
const HEX_HASH = /^[a-f0-9]{64}$/;
const CANONICAL_ID = /^[1-9][0-9]*$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ActionClaim = {
  scope: "action-claim";
  action: "apply" | "rollback";
  changeSetId: string;
  keyHash: string;
};

type IdempotencyMapping =
  | { scope: "plan"; changeSetId: string }
  | { scope: "action"; action: "apply" | "rollback"; changeSetId: string }
  | { scope: "publication"; keyHash: string };

const CHANGESET_TRANSITIONS: Readonly<Record<ChangeSetState, ReadonlySet<ChangeSetState>>> = {
  PLANNED: new Set(["PLANNED", "APPLIED", "ROLLED_BACK", "FAILED"]),
  APPLIED: new Set(["APPLIED", "VERIFIED", "ROLLED_BACK", "FAILED"]),
  VERIFIED: new Set(["VERIFIED", "ROLLED_BACK", "FAILED"]),
  FAILED: new Set(["FAILED", "ROLLED_BACK"]),
  ROLLED_BACK: new Set(["ROLLED_BACK"]),
};

function isContained(base: string, target: string, allowBase = false): boolean {
  const pathFromBase = relative(base, target);
  if (pathFromBase === "") return allowBase;
  return (
    pathFromBase !== ".." &&
    !pathFromBase.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromBase) &&
    !pathFromBase.includes(":")
  );
}

function assertContained(base: string, target: string, allowBase = false): void {
  if (!isContained(base, target, allowBase)) {
    throw new TildaEngineError(
      "UNSAFE_STATE_PATH",
      "Runtime state path escaped the workspace state directory.",
    );
  }
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TildaEngineError(
      "UNSAFE_STATE_PATH",
      "Runtime state directory must be a regular non-symlink directory.",
    );
  }
}

function walkDirectoryTree(base: string, target: string, create: boolean): void {
  assertContained(base, target, true);
  if (create) ensureDirectory(base);
  if (!existsSync(base)) {
    throw new TildaEngineError("UNSAFE_STATE_PATH", "Runtime state base does not exist.");
  }
  const baseMetadata = lstatSync(base);
  if (!baseMetadata.isDirectory() || baseMetadata.isSymbolicLink()) {
    throw new TildaEngineError("UNSAFE_STATE_PATH", "Runtime state base is not a safe directory.");
  }

  const pathFromBase = relative(base, target);
  let cursor = base;
  for (const segment of pathFromBase.split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) {
      if (!create) {
        throw new TildaEngineError("UNSAFE_STATE_PATH", "Runtime state path does not exist.");
      }
      mkdirSync(cursor, { mode: 0o700 });
    }
    const metadata = lstatSync(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TildaEngineError(
        "UNSAFE_STATE_PATH",
        "Runtime state path contains a symlink or non-directory ancestor.",
      );
    }
  }
}

function assertPlainFile(base: string, path: string): void {
  assertContained(base, path);
  walkDirectoryTree(base, dirname(path), false);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TildaEngineError("UNSAFE_STATE_PATH", "Runtime state must be a regular file.");
  }
}

/** Atomic no-clobber publication: unlike rename(), link() never replaces an event. */
function writeImmutableJson(base: string, path: string, value: unknown): void {
  assertContained(base, path);
  const parent = dirname(path);
  walkDirectoryTree(base, parent, true);
  const temporary = resolve(parent, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    linkSync(temporary, path);
    unlinkSync(temporary);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  assertPlainFile(base, path);
}

function parseJson<T>(base: string, path: string): T {
  assertPlainFile(base, path);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof TildaEngineError) throw error;
    throw new TildaEngineError("STATE_CORRUPT", "Local MCP state is not valid JSON.");
  }
}

function assertUuid(value: string, field: string): string {
  if (!UUID.test(value)) {
    throw new TildaEngineError("INVALID_STATE_ID", `${field} must be a UUID.`);
  }
  return value;
}

function assertIsoTimestamp(value: string, field: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TildaEngineError("STATE_CORRUPT", `${field} is not an ISO timestamp.`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new TildaEngineError("STATE_CORRUPT", `${field} is not canonical ISO UTC.`);
    }
  } catch (error) {
    if (error instanceof TildaEngineError) throw error;
    throw new TildaEngineError("STATE_CORRUPT", `${field} is not an ISO timestamp.`);
  }
}

function assertHash(value: string, field: string): void {
  if (!CANONICAL_HASH.test(value)) {
    throw new TildaEngineError("STATE_CORRUPT", `${field} is not a canonical SHA-256 hash.`);
  }
}

function assertHexHash(value: string, field: string): void {
  if (!HEX_HASH.test(value)) {
    throw new TildaEngineError("STATE_CORRUPT", `${field} is not a SHA-256 digest.`);
  }
}

function assertToken(value: string, field: string): void {
  if (!SAFE_TOKEN.test(value)) {
    throw new TildaEngineError("STATE_CORRUPT", `${field} is not a bounded state token.`);
  }
}

function assertSummary(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TildaEngineError(
      "STATE_PRIVACY_VIOLATION",
      `${field} must be a bounded, single-line structural summary.`,
    );
  }
}

function assertTarget(target: unknown, expectedKind?: "page"): void {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new TildaEngineError("STATE_CORRUPT", "Journal target is invalid.");
  }
  const candidate = target as Record<string, unknown>;
  const kind = candidate.kind;
  const fieldsByKind: Record<string, readonly string[]> = {
    project: ["kind", "projectId"],
    page: ["kind", "projectId", "pageId"],
    record: ["kind", "projectId", "pageId", "recordId"],
    element: ["kind", "projectId", "pageId", "recordId", "elementId"],
  };
  if (typeof kind !== "string" || fieldsByKind[kind] === undefined) {
    throw new TildaEngineError("STATE_CORRUPT", "Journal target kind is invalid.");
  }
  if (expectedKind !== undefined && kind !== expectedKind) {
    throw new TildaEngineError("STATE_CORRUPT", `Journal target must be ${expectedKind}-scoped.`);
  }
  const expectedFields = fieldsByKind[kind];
  const actualFields = Object.keys(candidate).sort();
  if (!isDeepStrictEqual(actualFields, [...expectedFields].sort())) {
    throw new TildaEngineError("STATE_PRIVACY_VIOLATION", "Journal target contains extra fields.");
  }
  for (const field of expectedFields.filter((field) => field !== "kind")) {
    const value = candidate[field];
    if (typeof value !== "string" || !CANONICAL_ID.test(value)) {
      throw new TildaEngineError("STATE_CORRUPT", `Journal target ${field} is invalid.`);
    }
  }
}

function assertVerification(record: ChangeSetRecord): void {
  const value = record.verification;
  if (value === undefined) return;
  assertIsoTimestamp(value.checkedAt, "verification.checkedAt");
  assertHash(value.expectedHash, "verification.expectedHash");
  assertHash(value.actualHash, "verification.actualHash");
  if (value.exactMatch !== (value.expectedHash === value.actualHash)) {
    throw new TildaEngineError("STATE_CORRUPT", "Verification exactMatch is inconsistent.");
  }
  if (value.changedPaths !== undefined) {
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length > 64) {
      throw new TildaEngineError("STATE_CORRUPT", "Verification changedPaths is invalid.");
    }
    for (const path of value.changedPaths) assertSummary(path, "verification changed path");
  }
}

function assertTaskAuthority(record: ChangeSetRecord): void {
  const authority = record.taskAuthority;
  if (authority === undefined) return;
  if (
    authority === null ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    !isDeepStrictEqual(Object.keys(authority).sort(), ["grantHash", "taskId"]) ||
    !TASK_UUID.test(authority.taskId) ||
    !CANONICAL_HASH.test(authority.grantHash)
  ) {
    throw new TildaEngineError(
      "STATE_CORRUPT",
      "ChangeSet task authority provenance is invalid.",
    );
  }
}

function assertChangeSet(record: ChangeSetRecord): void {
  if (record.format !== "tilda-mcp-changeset-v1") {
    throw new TildaEngineError("STATE_CORRUPT", "Unsupported ChangeSet journal format.");
  }
  assertUuid(record.changeSetId, "changeSetId");
  assertUuid(record.snapshotId, "snapshotId");
  if (!(CHANGESET_STATES as readonly string[]).includes(record.state)) {
    throw new TildaEngineError("STATE_CORRUPT", "ChangeSet state is invalid.");
  }
  assertIsoTimestamp(record.createdAt, "createdAt");
  assertIsoTimestamp(record.updatedAt, "updatedAt");
  if (record.updatedAt < record.createdAt) {
    throw new TildaEngineError("STATE_CORRUPT", "ChangeSet update precedes creation.");
  }
  assertToken(record.adapter, "adapter");
  assertToken(record.capability, "capability");
  if (!(CHANGE_OPERATIONS as readonly string[]).includes(record.operation)) {
    throw new TildaEngineError("STATE_CORRUPT", "ChangeSet operation is invalid.");
  }
  assertTarget(record.target);
  assertHash(record.requestHash, "requestHash");
  assertHash(record.expectedBeforeHash, "expectedBeforeHash");
  assertHash(record.expectedAfterHash, "expectedAfterHash");
  if (record.expectedBeforeRevision !== undefined) {
    assertSummary(record.expectedBeforeRevision, "expectedBeforeRevision");
  }
  if (!Array.isArray(record.changedPaths) || record.changedPaths.length < 1 || record.changedPaths.length > 64) {
    throw new TildaEngineError("STATE_CORRUPT", "ChangeSet changedPaths is invalid.");
  }
  const uniquePaths = new Set<string>();
  for (const path of record.changedPaths) {
    assertSummary(path, "changed path");
    uniquePaths.add(path);
  }
  if (uniquePaths.size !== record.changedPaths.length) {
    throw new TildaEngineError("STATE_CORRUPT", "ChangeSet changedPaths contains duplicates.");
  }
  assertSummary(record.summary, "summary");
  assertTaskAuthority(record);
  if (record.planIdempotencyHash !== undefined) {
    assertHexHash(record.planIdempotencyHash, "planIdempotencyHash");
  }
  if (record.appliedHash !== undefined) assertHash(record.appliedHash, "appliedHash");
  if (record.failureCode !== undefined) assertToken(record.failureCode, "failureCode");
  if (record.reconciliationCode !== undefined) {
    assertToken(record.reconciliationCode, "reconciliationCode");
  }
  assertVerification(record);

  if ((record.state === "APPLIED" || record.state === "VERIFIED") && record.appliedHash === undefined) {
    throw new TildaEngineError("STATE_CORRUPT", `${record.state} ChangeSet lacks appliedHash.`);
  }
  if (record.state === "FAILED" && record.failureCode === undefined) {
    throw new TildaEngineError("STATE_CORRUPT", "FAILED ChangeSet lacks failureCode.");
  }
  if (
    (record.state === "APPLIED" || record.state === "VERIFIED") &&
    (record.verification?.expectedHash !== record.expectedAfterHash ||
      record.verification.actualHash !== record.expectedAfterHash ||
      !record.verification.exactMatch)
  ) {
    throw new TildaEngineError("STATE_CORRUPT", `${record.state} ChangeSet lacks exact apply verification.`);
  }
  if (
    record.state === "ROLLED_BACK" &&
    (record.verification?.expectedHash !== record.expectedBeforeHash ||
      record.verification.actualHash !== record.expectedBeforeHash ||
      !record.verification.exactMatch)
  ) {
    throw new TildaEngineError("STATE_CORRUPT", "ROLLED_BACK ChangeSet lacks exact restore verification.");
  }
}

function immutableChangeSetFields(record: ChangeSetRecord): unknown {
  return {
    format: record.format,
    changeSetId: record.changeSetId,
    snapshotId: record.snapshotId,
    createdAt: record.createdAt,
    adapter: record.adapter,
    capability: record.capability,
    target: record.target,
    operation: record.operation,
    requestHash: record.requestHash,
    expectedBeforeHash: record.expectedBeforeHash,
    expectedBeforeRevision: record.expectedBeforeRevision,
    expectedAfterHash: record.expectedAfterHash,
    changedPaths: record.changedPaths,
    summary: record.summary,
    taskAuthority: record.taskAuthority,
    planIdempotencyHash: record.planIdempotencyHash,
  };
}

function assertChangeSetTransition(current: ChangeSetRecord, next: ChangeSetRecord): void {
  if (!isDeepStrictEqual(immutableChangeSetFields(current), immutableChangeSetFields(next))) {
    throw new TildaEngineError("JOURNAL_IMMUTABLE_FIELD_CHANGED", "ChangeSet identity fields are immutable.");
  }
  if (!CHANGESET_TRANSITIONS[current.state].has(next.state)) {
    throw new TildaEngineError(
      "INVALID_STATE_TRANSITION",
      `ChangeSet cannot transition from ${current.state} to ${next.state}.`,
    );
  }
  if (next.updatedAt < current.updatedAt) {
    throw new TildaEngineError("STALE_CHANGESET", "Refusing to append stale ChangeSet state.");
  }
  if (current.appliedHash !== undefined && next.appliedHash !== current.appliedHash) {
    throw new TildaEngineError("JOURNAL_IMMUTABLE_FIELD_CHANGED", "appliedHash cannot be replaced.");
  }
}

function assertSnapshot(snapshot: SnapshotEnvelope): void {
  if (snapshot.format !== "tilda-mcp-snapshot-v1") {
    throw new TildaEngineError("STATE_CORRUPT", "Unsupported snapshot format.");
  }
  assertUuid(snapshot.snapshotId, "snapshotId");
  assertIsoTimestamp(snapshot.createdAt, "snapshot.createdAt");
  assertToken(snapshot.adapter, "snapshot.adapter");
  assertTarget(snapshot.target);
  assertHash(snapshot.stateHash, "snapshot.stateHash");
  if (snapshot.revision !== undefined) assertSummary(snapshot.revision, "snapshot.revision");
  assertSummary(snapshot.summary, "snapshot.summary");
}

function assertPublication(record: PublicationJournalRecord): void {
  if (record.format !== "tilda-mcp-publication-v1") {
    throw new TildaEngineError("STATE_CORRUPT", "Unsupported publication journal format.");
  }
  assertHexHash(record.keyHash, "publication.keyHash");
  assertHexHash(record.intentHash, "publication.intentHash");
  assertHexHash(record.beforeChangedHash, "publication.beforeChangedHash");
  if (record.action !== "publish" && record.action !== "unpublish") {
    throw new TildaEngineError("STATE_CORRUPT", "Publication action is invalid.");
  }
  assertTarget(record.target, "page");
  if (!(PUBLICATION_JOURNAL_STATES as readonly string[]).includes(record.state)) {
    throw new TildaEngineError("STATE_CORRUPT", "Publication journal state is invalid.");
  }
  assertIsoTimestamp(record.createdAt, "publication.createdAt");
  assertIsoTimestamp(record.updatedAt, "publication.updatedAt");
  if (record.updatedAt < record.createdAt) {
    throw new TildaEngineError("STATE_CORRUPT", "Publication update precedes creation.");
  }
  if (typeof record.beforePublished !== "boolean") {
    throw new TildaEngineError("STATE_CORRUPT", "Publication before-state is invalid.");
  }
  if (record.failureCode !== undefined) assertToken(record.failureCode, "publication.failureCode");
  if (record.reconciliationCode !== undefined) {
    assertToken(record.reconciliationCode, "publication.reconciliationCode");
  }
  if ((record.state === "FAILED" || record.state === "AMBIGUOUS") && record.failureCode === undefined) {
    throw new TildaEngineError("STATE_CORRUPT", `${record.state} publication lacks failureCode.`);
  }
}

function immutablePublicationFields(record: PublicationJournalRecord): unknown {
  return {
    format: record.format,
    keyHash: record.keyHash,
    intentHash: record.intentHash,
    action: record.action,
    target: record.target,
    createdAt: record.createdAt,
    beforePublished: record.beforePublished,
    beforeChangedHash: record.beforeChangedHash,
  };
}

function idempotencyDigest(value: string): string {
  if (value.length < 8 || value.length > 256 || value.trim() !== value) {
    throw new TildaEngineError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotencyKey must be 8..256 characters with no surrounding whitespace.",
    );
  }
  return createHash("sha256").update(`tilda-mcp-idempotency-v1\0${value}`).digest("hex");
}

export class ChangeSetStore {
  readonly root: string;
  readonly #runtimeParent: string;
  readonly #snapshots: string;
  readonly #changeSets: string;
  readonly #idempotency: string;
  readonly #actionClaims: string;
  readonly #publications: string;
  readonly #lockPath: string;

  constructor(root = resolve(process.cwd(), ".tilda-runtime", "mcp-v1")) {
    const expectedParent = resolve(process.cwd(), ".tilda-runtime");
    const resolvedRoot = resolve(root);
    if (!isContained(expectedParent, resolvedRoot)) {
      throw new TildaEngineError(
        "UNSAFE_STATE_PATH",
        "MCP state must be a child of the workspace .tilda-runtime directory.",
      );
    }
    walkDirectoryTree(expectedParent, resolvedRoot, true);
    this.root = resolvedRoot;
    this.#runtimeParent = expectedParent;
    this.#snapshots = resolve(resolvedRoot, "snapshots");
    this.#changeSets = resolve(resolvedRoot, "changesets");
    this.#idempotency = resolve(resolvedRoot, "idempotency");
    this.#actionClaims = resolve(resolvedRoot, "action-claims");
    this.#publications = resolve(resolvedRoot, "publications");
    this.#lockPath = resolve(resolvedRoot, "mutation.lock");
    for (const directory of [
      this.#snapshots,
      this.#changeSets,
      this.#idempotency,
      this.#actionClaims,
      this.#publications,
    ]) {
      walkDirectoryTree(this.#runtimeParent, directory, true);
    }
  }

  async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    walkDirectoryTree(this.#runtimeParent, this.root, false);
    let descriptor: number;
    try {
      descriptor = openSync(this.#lockPath, "wx", 0o600);
    } catch {
      throw new TildaEngineError(
        "CONCURRENT_OPERATION",
        "Another MCP mutation is already in progress; no retry was attempted.",
      );
    }
    try {
      return await action();
    } finally {
      closeSync(descriptor);
      assertPlainFile(this.#runtimeParent, this.#lockPath);
      unlinkSync(this.#lockPath);
    }
  }

  createSnapshot(input: Omit<SnapshotEnvelope, "format" | "snapshotId" | "createdAt">): SnapshotEnvelope {
    const snapshot: SnapshotEnvelope = {
      format: "tilda-mcp-snapshot-v1",
      snapshotId: randomUUID(),
      createdAt: new Date().toISOString(),
      ...structuredClone(input),
    };
    assertSnapshot(snapshot);
    writeImmutableJson(
      this.#runtimeParent,
      resolve(this.#snapshots, `${snapshot.snapshotId}.json`),
      snapshot,
    );
    return structuredClone(snapshot);
  }

  loadSnapshot(snapshotId: string): SnapshotEnvelope {
    const snapshot = parseJson<SnapshotEnvelope>(
      this.#runtimeParent,
      resolve(this.#snapshots, `${assertUuid(snapshotId, "snapshotId")}.json`),
    );
    assertSnapshot(snapshot);
    return structuredClone(snapshot);
  }

  discardUnreferencedSnapshot(snapshotId: string): void {
    const canonicalId = assertUuid(snapshotId, "snapshotId");
    for (const changeSetId of this.#changeSetIds()) {
      if (this.loadChangeSet(changeSetId).snapshotId === canonicalId) {
        throw new TildaEngineError("SNAPSHOT_REFERENCED", "Referenced snapshots are immutable.");
      }
    }
    const path = resolve(this.#snapshots, `${canonicalId}.json`);
    if (!existsSync(path)) return;
    assertPlainFile(this.#runtimeParent, path);
    unlinkSync(path);
  }

  createChangeSet(record: ChangeSetRecord, idempotencyKey?: string): ChangeSetRecord {
    assertUuid(record.changeSetId, "changeSetId");
    if (record.planIdempotencyHash !== undefined) {
      throw new TildaEngineError(
        "STATE_PRIVACY_VIOLATION",
        "Callers may not inject a persisted idempotency digest.",
      );
    }
    const digest = idempotencyKey === undefined ? undefined : idempotencyDigest(idempotencyKey);
    if (digest !== undefined && this.#findPlanByDigest(digest) !== null) {
      throw new TildaEngineError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key is already bound to another ChangeSet.",
      );
    }
    const persisted: ChangeSetRecord =
      digest === undefined ? structuredClone(record) : { ...structuredClone(record), planIdempotencyHash: digest };
    assertChangeSet(persisted);

    const directory = resolve(this.#changeSets, persisted.changeSetId);
    if (existsSync(directory)) {
      throw new TildaEngineError("CHANGESET_EXISTS", "ChangeSet already exists.");
    }
    walkDirectoryTree(this.#runtimeParent, directory, true);
    try {
      writeImmutableJson(this.#runtimeParent, resolve(directory, "000001.json"), persisted);
      if (digest !== undefined) {
        const idempotencyPath = resolve(this.#idempotency, `${digest}.json`);
        if (existsSync(idempotencyPath)) {
          throw new TildaEngineError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was concurrently bound to another operation.",
          );
        }
        writeImmutableJson(this.#runtimeParent, idempotencyPath, {
          scope: "plan",
          changeSetId: persisted.changeSetId,
        } satisfies IdempotencyMapping);
      }
    } catch (error) {
      if (existsSync(directory)) {
        walkDirectoryTree(this.#runtimeParent, directory, false);
        rmSync(directory, { recursive: true, force: true });
      }
      throw error;
    }
    return structuredClone(persisted);
  }

  loadChangeSet(changeSetId: string): ChangeSetRecord {
    const history = this.#loadChangeSetHistory(assertUuid(changeSetId, "changeSetId"));
    return structuredClone(history[history.length - 1]!);
  }

  appendChangeSet(record: ChangeSetRecord): ChangeSetRecord {
    assertChangeSet(record);
    const history = this.#loadChangeSetHistory(record.changeSetId);
    const current = history[history.length - 1]!;
    assertChangeSetTransition(current, record);
    const nextSequence = history.length + 1;
    if (nextSequence > 999_999) {
      throw new TildaEngineError("STATE_JOURNAL_FULL", "ChangeSet event journal is full.");
    }
    const directory = resolve(this.#changeSets, record.changeSetId);
    writeImmutableJson(
      this.#runtimeParent,
      resolve(directory, `${String(nextSequence).padStart(6, "0")}.json`),
      structuredClone(record),
    );
    return structuredClone(record);
  }

  findByIdempotencyKey(key: string): ChangeSetRecord | null {
    return this.#findPlanByDigest(idempotencyDigest(key));
  }

  claimActionIdempotency(
    key: string,
    action: "apply" | "rollback",
    changeSetId: string,
  ): "CLAIMED" | "REPLAY" {
    const canonicalId = assertUuid(changeSetId, "changeSetId");
    this.loadChangeSet(canonicalId);
    const digest = idempotencyDigest(key);
    const status = this.actionAttemptStatus(key, action, canonicalId);
    if (status === "REPLAY") return "REPLAY";
    const claimDirectory = resolve(this.#actionClaims, canonicalId);
    const claimPath = resolve(claimDirectory, `${action}.json`);
    const mappingPath = resolve(this.#idempotency, `${digest}.json`);
    if (existsSync(mappingPath)) {
      const mapping = parseJson<IdempotencyMapping>(this.#runtimeParent, mappingPath);
      if (
        mapping.scope !== "action" ||
        mapping.action !== action ||
        mapping.changeSetId !== canonicalId
      ) {
        throw new TildaEngineError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key is already bound to another operation.",
        );
      }
    } else {
      writeImmutableJson(this.#runtimeParent, mappingPath, {
        scope: "action",
        action,
        changeSetId: canonicalId,
      } satisfies IdempotencyMapping);
    }

    writeImmutableJson(this.#runtimeParent, claimPath, {
      scope: "action-claim",
      action,
      changeSetId: canonicalId,
      keyHash: digest,
    } satisfies ActionClaim);
    return "CLAIMED";
  }

  actionAttemptStatus(
    key: string,
    action: "apply" | "rollback",
    changeSetId: string,
  ): "UNCLAIMED" | "REPLAY" {
    const canonicalId = assertUuid(changeSetId, "changeSetId");
    this.loadChangeSet(canonicalId);
    const digest = idempotencyDigest(key);
    const claimPath = resolve(this.#actionClaims, canonicalId, `${action}.json`);
    if (existsSync(claimPath)) {
      const claim = parseJson<ActionClaim>(this.#runtimeParent, claimPath);
      if (
        claim.scope === "action-claim" &&
        claim.action === action &&
        claim.changeSetId === canonicalId &&
        claim.keyHash === digest
      ) {
        return "REPLAY";
      }
      throw new TildaEngineError(
        "RECOVERY_REQUIRED",
        "This ChangeSet action already has an unresolved durable attempt; a new key cannot retry it.",
      );
    }
    const mappingPath = resolve(this.#idempotency, `${digest}.json`);
    if (existsSync(mappingPath)) {
      const mapping = parseJson<IdempotencyMapping>(this.#runtimeParent, mappingPath);
      if (
        mapping.scope !== "action" ||
        mapping.action !== action ||
        mapping.changeSetId !== canonicalId
      ) {
        throw new TildaEngineError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key is already bound to another operation.",
        );
      }
    }
    return "UNCLAIMED";
  }

  claimPublicationAction(
    key: string,
    input: Omit<
      PublicationJournalRecord,
      "format" | "keyHash" | "state" | "createdAt" | "updatedAt"
    >,
  ): { claim: "CLAIMED" | "REPLAY"; record: PublicationJournalRecord } {
    const digest = idempotencyDigest(key);
    const existing = this.#loadPublicationByDigest(digest);
    if (existing !== null) {
      if (
        existing.intentHash !== input.intentHash ||
        existing.action !== input.action ||
        !isDeepStrictEqual(existing.target, input.target)
      ) {
        throw new TildaEngineError(
          "IDEMPOTENCY_CONFLICT",
          "Publication idempotency key belongs to another exact action.",
        );
      }
      return { claim: "REPLAY", record: existing };
    }

    const mappingPath = resolve(this.#idempotency, `${digest}.json`);
    if (existsSync(mappingPath)) {
      const mapping = parseJson<IdempotencyMapping>(this.#runtimeParent, mappingPath);
      if (mapping.scope !== "publication" || mapping.keyHash !== digest) {
        throw new TildaEngineError(
          "IDEMPOTENCY_CONFLICT",
          "Publication idempotency key is already bound to another operation.",
        );
      }
    } else {
      writeImmutableJson(this.#runtimeParent, mappingPath, {
        scope: "publication",
        keyHash: digest,
      } satisfies IdempotencyMapping);
    }

    const timestamp = new Date().toISOString();
    const record: PublicationJournalRecord = {
      format: "tilda-mcp-publication-v1",
      keyHash: digest,
      state: "CLAIMED",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...structuredClone(input),
    };
    assertPublication(record);
    const directory = resolve(this.#publications, digest);
    walkDirectoryTree(this.#runtimeParent, directory, true);
    writeImmutableJson(this.#runtimeParent, resolve(directory, "000001.json"), record);
    return { claim: "CLAIMED", record: structuredClone(record) };
  }

  appendPublicationAction(key: string, record: PublicationJournalRecord): PublicationJournalRecord {
    const digest = idempotencyDigest(key);
    if (record.keyHash !== digest) {
      throw new TildaEngineError("IDEMPOTENCY_CONFLICT", "Publication key digest does not match.");
    }
    assertPublication(record);
    const history = this.#loadPublicationHistory(digest);
    const current = history[history.length - 1]!;
    if (!isDeepStrictEqual(immutablePublicationFields(current), immutablePublicationFields(record))) {
      throw new TildaEngineError(
        "JOURNAL_IMMUTABLE_FIELD_CHANGED",
        "Publication intent fields are immutable.",
      );
    }
    if (current.state !== "CLAIMED") {
      throw new TildaEngineError(
        "INVALID_STATE_TRANSITION",
        "A terminal publication journal cannot be appended.",
      );
    }
    if (record.state === "CLAIMED") {
      throw new TildaEngineError(
        "INVALID_STATE_TRANSITION",
        "Publication must transition from CLAIMED to a terminal outcome.",
      );
    }
    if (record.updatedAt < current.updatedAt) {
      throw new TildaEngineError("STALE_CHANGESET", "Refusing a stale publication event.");
    }
    const directory = resolve(this.#publications, digest);
    writeImmutableJson(this.#runtimeParent, resolve(directory, "000002.json"), record);
    return structuredClone(record);
  }

  loadPublicationAction(key: string): PublicationJournalRecord | null {
    return this.#loadPublicationByDigest(idempotencyDigest(key));
  }

  #findPlanByDigest(digest: string): ChangeSetRecord | null {
    assertHexHash(digest, "idempotency digest");
    const mappingPath = resolve(this.#idempotency, `${digest}.json`);
    if (existsSync(mappingPath)) {
      const mapping = parseJson<IdempotencyMapping>(this.#runtimeParent, mappingPath);
      if (mapping.scope !== "plan") return null;
      const record = this.loadChangeSet(assertUuid(mapping.changeSetId, "changeSetId"));
      if (record.planIdempotencyHash !== digest) {
        throw new TildaEngineError("STATE_CORRUPT", "Plan idempotency mapping is inconsistent.");
      }
      return record;
    }

    const matches = this.#changeSetIds()
      .map((changeSetId) => this.loadChangeSet(changeSetId))
      .filter((record) => record.planIdempotencyHash === digest);
    if (matches.length > 1) {
      throw new TildaEngineError("STATE_CORRUPT", "Duplicate plan idempotency digests exist.");
    }
    return matches[0] ?? null;
  }

  #changeSetIds(): string[] {
    walkDirectoryTree(this.#runtimeParent, this.#changeSets, false);
    return readdirSync(this.#changeSets, { withFileTypes: true })
      .map((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) {
          throw new TildaEngineError("STATE_CORRUPT", "Unexpected ChangeSet directory entry.");
        }
        return entry.name;
      })
      .sort();
  }

  #loadChangeSetHistory(changeSetId: string): ChangeSetRecord[] {
    const directory = resolve(this.#changeSets, assertUuid(changeSetId, "changeSetId"));
    if (!existsSync(directory)) {
      throw new TildaEngineError("CHANGESET_NOT_FOUND", "ChangeSet was not found.");
    }
    const eventNames = this.#eventNames(directory);
    const history = eventNames.map((name) => {
      const record = parseJson<ChangeSetRecord>(this.#runtimeParent, resolve(directory, name));
      assertChangeSet(record);
      if (record.changeSetId !== changeSetId) {
        throw new TildaEngineError("STATE_CORRUPT", "ChangeSet event is stored under the wrong ID.");
      }
      return record;
    });
    for (let index = 1; index < history.length; index += 1) {
      assertChangeSetTransition(history[index - 1]!, history[index]!);
    }
    return history;
  }

  #loadPublicationByDigest(digest: string): PublicationJournalRecord | null {
    const directory = resolve(this.#publications, digest);
    if (!existsSync(directory)) return null;
    const history = this.#loadPublicationHistory(digest);
    return structuredClone(history[history.length - 1]!);
  }

  #loadPublicationHistory(digest: string): PublicationJournalRecord[] {
    assertHexHash(digest, "publication key digest");
    const directory = resolve(this.#publications, digest);
    const eventNames = this.#eventNames(directory);
    if (eventNames.length > 2) {
      throw new TildaEngineError("STATE_CORRUPT", "Publication journal has too many events.");
    }
    const history = eventNames.map((name) => {
      const record = parseJson<PublicationJournalRecord>(
        this.#runtimeParent,
        resolve(directory, name),
      );
      assertPublication(record);
      if (record.keyHash !== digest) {
        throw new TildaEngineError("STATE_CORRUPT", "Publication event is stored under the wrong key.");
      }
      return record;
    });
    if (history.length === 2) {
      const [first, second] = history;
      if (
        first?.state !== "CLAIMED" ||
        second?.state === "CLAIMED" ||
        !isDeepStrictEqual(
          immutablePublicationFields(first!),
          immutablePublicationFields(second!),
        )
      ) {
        throw new TildaEngineError("STATE_CORRUPT", "Publication state transition is invalid.");
      }
    }
    return history;
  }

  #eventNames(directory: string): string[] {
    walkDirectoryTree(this.#runtimeParent, directory, false);
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length === 0) {
      throw new TildaEngineError("STATE_CORRUPT", "State journal has no events.");
    }
    const events = entries
      .map((entry) => {
        const match = EVENT.exec(entry.name);
        if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
          throw new TildaEngineError("STATE_CORRUPT", "State journal contains an unexpected entry.");
        }
        assertPlainFile(this.#runtimeParent, resolve(directory, entry.name));
        return { name: entry.name, sequence: Number(match[1]) };
      })
      .sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]!.sequence !== index + 1) {
        throw new TildaEngineError("STATE_CORRUPT", "State journal sequence has a gap.");
      }
    }
    return events.map((event) => event.name);
  }
}
