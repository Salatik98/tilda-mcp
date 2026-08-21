import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import type { ExactTarget } from "../core/contracts.js";
import { canonicalHash } from "../research/hash.js";
import type {
  LearnCapabilityRequest,
  LearningAction,
  LearningTaskLineage,
} from "./contracts.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+){1,5}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,95}$/u;
const ENTRY_FILE = /^([0-9a-f]{64})-([0-9a-f]{64})-(0|1)-(IN_FLIGHT|COMPLETED|FAILED|AMBIGUOUS)\.json$/u;

export const LEARNING_EXECUTION_STATES = [
  "IN_FLIGHT",
  "COMPLETED",
  "FAILED",
  "AMBIGUOUS",
] as const;

export type LearningExecutionState = (typeof LEARNING_EXECUTION_STATES)[number];

/**
 * A content-free durable execution record. The raw idempotency key, Tilda
 * content, browser/session metadata, cookies, headers, and credentials are not
 * representable in this format.
 */
export interface LearningExecutionRecord {
  readonly format: "tilda-learning-execution-journal-v1";
  readonly sequence: 0 | 1;
  readonly state: LearningExecutionState;
  readonly idempotencyHash: string;
  readonly requestHash: string;
  readonly targetHash: string;
  readonly capabilityTargetHash: string;
  readonly target: ExactTarget;
  readonly capability: string;
  readonly action: LearningAction;
  readonly taskId: string;
  readonly grantHash: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failureCode: string | null;
  readonly restored: boolean | null;
}

export interface LearningExecutionClaim {
  readonly record: LearningExecutionRecord;
  complete(): LearningExecutionRecord;
  fail(failureCode: string): LearningExecutionRecord;
  ambiguous(failureCode: string): LearningExecutionRecord;
}

export type LearningExecutionClaimResult =
  | { readonly kind: "CLAIMED"; readonly claim: LearningExecutionClaim }
  | { readonly kind: "COMPLETED"; readonly record: LearningExecutionRecord }
  | { readonly kind: "FAILED"; readonly record: LearningExecutionRecord };

export interface CapabilityLearningExecutionJournal {
  claim(
    request: LearnCapabilityRequest,
    lineage: LearningTaskLineage,
  ): LearningExecutionClaimResult;
}

export type LearningJournalErrorCode =
  | "LEARNING_JOURNAL_PATH_UNSAFE"
  | "LEARNING_JOURNAL_ENTRY_INVALID"
  | "LEARNING_JOURNAL_IO_FAILED"
  | "LEARNING_IDEMPOTENCY_CONFLICT"
  | "LEARNING_IDEMPOTENCY_TERMINAL"
  | "LEARNING_TARGET_QUARANTINED"
  | "LEARNING_EXECUTION_BUSY";

export class LearningJournalError extends Error {
  readonly code: LearningJournalErrorCode;

  constructor(code: LearningJournalErrorCode, message: string) {
    super(message);
    this.name = "LearningJournalError";
    this.code = code;
  }
}

interface JournalIdentity {
  readonly idempotencyHash: string;
  readonly requestHash: string;
  readonly targetHash: string;
  readonly capabilityTargetHash: string;
  readonly target: ExactTarget;
  readonly capability: string;
  readonly action: LearningAction;
  readonly taskId: string;
  readonly grantHash: string;
}

interface HeldLock {
  readonly path: string;
  readonly ownerHash: string;
}

function journalError(code: LearningJournalErrorCode, message: string): never {
  throw new LearningJournalError(code, message);
}

function hashSecret(value: string): string {
  return `sha256:${createHash("sha256")
    .update("tilda-learning-idempotency-v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex")}`;
}

function canonicalTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", `${field} is not a canonical timestamp.`);
  }
  return value;
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", `${field} is not a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", `${field} is not a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", `${field} contains unexpected fields.`);
  }
}

function exactTarget(value: unknown): ExactTarget {
  const object = plainObject(value, "target");
  const id = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[1-9][0-9]*$/u.test(candidate);
  if (object.kind === "project") {
    exactKeys(object, ["kind", "projectId"], "target");
    if (!id(object.projectId)) journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Project target is invalid.");
    return { kind: "project", projectId: object.projectId };
  }
  if (object.kind === "page") {
    exactKeys(object, ["kind", "projectId", "pageId"], "target");
    if (!id(object.projectId) || !id(object.pageId)) journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Page target is invalid.");
    return { kind: "page", projectId: object.projectId, pageId: object.pageId };
  }
  if (object.kind === "record") {
    exactKeys(object, ["kind", "projectId", "pageId", "recordId"], "target");
    if (!id(object.projectId) || !id(object.pageId) || !id(object.recordId)) journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Record target is invalid.");
    return { kind: "record", projectId: object.projectId, pageId: object.pageId, recordId: object.recordId };
  }
  if (object.kind === "element") {
    exactKeys(object, ["kind", "projectId", "pageId", "recordId", "elementId"], "target");
    if (
      !id(object.projectId) ||
      !id(object.pageId) ||
      !id(object.recordId) ||
      typeof object.elementId !== "string" ||
      !/^[A-Za-z0-9_.-]{1,160}$/u.test(object.elementId)
    ) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Element target is invalid.");
    }
    return {
      kind: "element",
      projectId: object.projectId,
      pageId: object.pageId,
      recordId: object.recordId,
      elementId: object.elementId,
    };
  }
  journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Target kind is invalid.");
}

function contained(base: string, target: string, allowBase = false): boolean {
  const fromBase = relative(base, target);
  if (fromBase === "") return allowBase;
  return (
    fromBase !== ".." &&
    !fromBase.startsWith(`..${sep}`) &&
    !isAbsolute(fromBase) &&
    !fromBase.includes(":")
  );
}

function assertNoRedirectedAncestor(target: string): void {
  const absolute = resolve(target);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  const segments = relative(parsed.root, absolute).split(/[\\/]/u).filter(Boolean);
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) break;
    let metadata: ReturnType<typeof lstatSync>;
    let realPath: string;
    try {
      metadata = lstatSync(cursor);
      realPath = realpathSync.native(cursor);
    } catch {
      journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal ancestor could not be verified safely.");
    }
    if (
      metadata.isSymbolicLink() ||
      relative(resolve(cursor), resolve(realPath)) !== ""
    ) {
      journalError(
        "LEARNING_JOURNAL_PATH_UNSAFE",
        "Learning journal path contains a symlink, junction, or redirected reparse ancestor.",
      );
    }
  }
}

function safeDirectory(base: string, target: string, create: boolean): void {
  if (!contained(base, target, true)) {
    journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal path escaped the ignored runtime root.");
  }
  // Check from the volume root before creating anything. Otherwise a missing
  // nested runtime path could be created through an existing junction or
  // reparse-point ancestor outside the intended ignored tree.
  assertNoRedirectedAncestor(base);
  assertNoRedirectedAncestor(target);
  if (create && !existsSync(base)) mkdirSync(base, { recursive: true, mode: 0o700 });
  if (!existsSync(base)) {
    journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Ignored runtime root does not exist.");
  }
  const baseMetadata = lstatSync(base);
  if (!baseMetadata.isDirectory() || baseMetadata.isSymbolicLink()) {
    journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Ignored runtime root is not a regular directory.");
  }
  let cursor = base;
  for (const segment of relative(base, target).split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) {
      if (!create) journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal directory is missing.");
      mkdirSync(cursor, { mode: 0o700 });
    }
    const metadata = lstatSync(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal contains a symlink or non-directory path.");
    }
  }
}

function safeFile(base: string, path: string): void {
  if (!contained(base, path) || !existsSync(path)) {
    journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal entry path is unsafe or missing.");
  }
  safeDirectory(base, resolve(path, ".."), false);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal entry is not a regular file.");
  }
}

function writeExclusive(path: string, value: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      journalError("LEARNING_EXECUTION_BUSY", "A durable learning claim already exists for this execution boundary.");
    }
    if (error instanceof LearningJournalError) throw error;
    journalError("LEARNING_JOURNAL_IO_FAILED", "Learning journal entry could not be created atomically.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function entryFrom(value: unknown): LearningExecutionRecord {
  const object = plainObject(value, "entry");
  exactKeys(object, [
    "format",
    "sequence",
    "state",
    "idempotencyHash",
    "requestHash",
    "targetHash",
    "capabilityTargetHash",
    "target",
    "capability",
    "action",
    "taskId",
    "grantHash",
    "startedAt",
    "finishedAt",
    "failureCode",
    "restored",
  ], "entry");
  if (object.format !== "tilda-learning-execution-journal-v1") {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal format is invalid.");
  }
  if (object.sequence !== 0 && object.sequence !== 1) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal sequence is invalid.");
  }
  if (!(LEARNING_EXECUTION_STATES as readonly unknown[]).includes(object.state)) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal state is invalid.");
  }
  for (const field of ["idempotencyHash", "requestHash", "targetHash", "capabilityTargetHash", "grantHash"] as const) {
    if (typeof object[field] !== "string" || !SHA256.test(object[field])) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", `${field} is not canonical SHA-256.`);
    }
  }
  if (typeof object.capability !== "string" || !CAPABILITY.test(object.capability)) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal capability is invalid.");
  }
  if (typeof object.action !== "string" || ![
    "inspect", "edit", "create", "clone", "move", "reorder", "delete", "configure", "publish", "unpublish",
  ].includes(object.action)) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal action is invalid.");
  }
  if (typeof object.taskId !== "string" || !UUID.test(object.taskId)) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal task lineage is invalid.");
  }
  const target = exactTarget(object.target);
  const expectedTargetHash = canonicalHash({ format: "tilda-learning-target-v1", target });
  const expectedCapabilityTargetHash = canonicalHash({
    format: "tilda-learning-capability-target-v1",
    capability: object.capability,
    target,
  });
  if (
    object.targetHash !== expectedTargetHash ||
    object.capabilityTargetHash !== expectedCapabilityTargetHash
  ) {
    journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal target hashes do not match the exact target identity.");
  }
  const state = object.state as LearningExecutionState;
  const sequence = object.sequence;
  const startedAt = canonicalTimestamp(String(object.startedAt), "startedAt");
  if (sequence === 0) {
    if (state !== "IN_FLIGHT" || object.finishedAt !== null || object.failureCode !== null || object.restored !== null) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Initial learning journal entry is not a valid in-flight claim.");
    }
  } else {
    if (state === "IN_FLIGHT" || typeof object.finishedAt !== "string") {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Final learning journal entry is invalid.");
    }
    const finishedAt = canonicalTimestamp(object.finishedAt, "finishedAt");
    if (Date.parse(finishedAt) < Date.parse(startedAt)) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal completion predates its durable claim.");
    }
    if (state === "COMPLETED") {
      if (object.failureCode !== null || object.restored !== true) {
        journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Completed learning entry must prove exact restoration.");
      }
    } else if (
      typeof object.failureCode !== "string" ||
      !FAILURE_CODE.test(object.failureCode) ||
      (state === "FAILED" ? object.restored !== true : object.restored !== false)
    ) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Failed or ambiguous learning entry has invalid recovery evidence.");
    }
  }
  return {
    format: "tilda-learning-execution-journal-v1",
    sequence,
    state,
    idempotencyHash: object.idempotencyHash as string,
    requestHash: object.requestHash as string,
    targetHash: object.targetHash as string,
    capabilityTargetHash: object.capabilityTargetHash as string,
    target,
    capability: object.capability,
    action: object.action as LearningAction,
    taskId: object.taskId,
    grantHash: object.grantHash as string,
    startedAt,
    finishedAt: object.finishedAt as string | null,
    failureCode: object.failureCode as string | null,
    restored: object.restored as boolean | null,
  };
}

function sameIdentity(record: LearningExecutionRecord, identity: JournalIdentity): boolean {
  return (
    record.idempotencyHash === identity.idempotencyHash &&
    record.requestHash === identity.requestHash &&
    record.targetHash === identity.targetHash &&
    record.capabilityTargetHash === identity.capabilityTargetHash &&
    record.capability === identity.capability &&
    record.action === identity.action &&
    record.taskId === identity.taskId &&
    record.grantHash === identity.grantHash &&
    canonicalHash(record.target) === canonicalHash(identity.target)
  );
}

function identityFor(request: LearnCapabilityRequest, lineage: LearningTaskLineage): JournalIdentity {
  if (
    request.dryRun ||
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length < 8 ||
    request.idempotencyKey.trim() !== request.idempotencyKey
  ) {
    journalError("LEARNING_IDEMPOTENCY_CONFLICT", "Non-dry learning requires one valid idempotency key.");
  }
  if (!UUID.test(lineage.taskId) || !SHA256.test(lineage.grantHash)) {
    journalError("LEARNING_IDEMPOTENCY_CONFLICT", "Learning task lineage is invalid.");
  }
  const idempotencyHash = hashSecret(request.idempotencyKey);
  const target = structuredClone(request.target);
  const targetHash = canonicalHash({ format: "tilda-learning-target-v1", target });
  const capabilityTargetHash = canonicalHash({
    format: "tilda-learning-capability-target-v1",
    capability: request.capability,
    target,
  });
  const requestHash = canonicalHash({
    format: "tilda-learning-request-v1",
    mode: request.mode,
    target,
    targetRole: request.targetRole,
    capability: request.capability,
    family: request.family,
    action: request.action,
    dryRun: false,
    idempotencyHash,
    taskId: lineage.taskId,
    grantHash: lineage.grantHash,
  });
  return {
    idempotencyHash,
    requestHash,
    targetHash,
    capabilityTargetHash,
    target,
    capability: request.capability,
    action: request.action,
    taskId: lineage.taskId,
    grantHash: lineage.grantHash,
  };
}

function entryStem(record: Pick<LearningExecutionRecord, "targetHash" | "idempotencyHash">): string {
  return `${record.targetHash.slice(7)}-${record.idempotencyHash.slice(7)}`;
}

function entryName(record: LearningExecutionRecord): string {
  return `${entryStem(record)}-${record.sequence}-${record.state}.json`;
}

function latestEntries(records: readonly LearningExecutionRecord[]): readonly LearningExecutionRecord[] {
  const grouped = new Map<string, LearningExecutionRecord[]>();
  for (const record of records) {
    const key = `${record.targetHash}|${record.idempotencyHash}`;
    const values = grouped.get(key) ?? [];
    values.push(record);
    grouped.set(key, values);
  }
  const latest: LearningExecutionRecord[] = [];
  for (const values of grouped.values()) {
    values.sort((left, right) => left.sequence - right.sequence);
    if (values.length < 1 || values.length > 2 || values[0]?.sequence !== 0) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal history is incomplete.");
    }
    const first = values[0]!;
    if (values.some((value) => !sameIdentity(value, {
      idempotencyHash: first.idempotencyHash,
      requestHash: first.requestHash,
      targetHash: first.targetHash,
      capabilityTargetHash: first.capabilityTargetHash,
      target: first.target,
      capability: first.capability,
      action: first.action,
      taskId: first.taskId,
      grantHash: first.grantHash,
    }))) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal history changed immutable claim identity.");
    }
    if (values.length === 2 && values[1]?.sequence !== 1) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal final transition is invalid.");
    }
    latest.push(values.at(-1)!);
  }
  return latest;
}

class FileLearningExecutionClaim implements LearningExecutionClaim {
  readonly record: LearningExecutionRecord;
  readonly #entriesRoot: string;
  readonly #runtimeRoot: string;
  readonly #keyLock: HeldLock;
  readonly #targetLock: HeldLock;
  readonly #now: () => string;
  #finalized = false;

  constructor(options: {
    readonly record: LearningExecutionRecord;
    readonly entriesRoot: string;
    readonly runtimeRoot: string;
    readonly keyLock: HeldLock;
    readonly targetLock: HeldLock;
    readonly now: () => string;
  }) {
    this.record = structuredClone(options.record);
    this.#entriesRoot = options.entriesRoot;
    this.#runtimeRoot = options.runtimeRoot;
    this.#keyLock = options.keyLock;
    this.#targetLock = options.targetLock;
    this.#now = options.now;
  }

  complete(): LearningExecutionRecord {
    return this.#finish("COMPLETED", null, true);
  }

  fail(failureCode: string): LearningExecutionRecord {
    return this.#finish("FAILED", failureCode, true);
  }

  ambiguous(failureCode: string): LearningExecutionRecord {
    return this.#finish("AMBIGUOUS", failureCode, false);
  }

  #finish(
    state: Exclude<LearningExecutionState, "IN_FLIGHT">,
    failureCode: string | null,
    restored: boolean,
  ): LearningExecutionRecord {
    if (this.#finalized) {
      journalError("LEARNING_IDEMPOTENCY_TERMINAL", "Learning execution claim is already terminal.");
    }
    if (failureCode !== null && !FAILURE_CODE.test(failureCode)) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning failure code is not a bounded token.");
    }
    const record: LearningExecutionRecord = {
      ...structuredClone(this.record),
      sequence: 1,
      state,
      finishedAt: canonicalTimestamp(this.#now(), "finishedAt"),
      failureCode,
      restored,
    };
    safeDirectory(this.#runtimeRoot, this.#entriesRoot, false);
    writeExclusive(resolve(this.#entriesRoot, entryName(record)), record);
    this.#finalized = true;
    // Keep the exact-target lock until the terminal record is durable. If
    // either cleanup fails, the leftover lock conservatively blocks a retry.
    this.#release(this.#keyLock);
    this.#release(this.#targetLock);
    return structuredClone(record);
  }

  #release(lock: HeldLock): void {
    safeDirectory(this.#runtimeRoot, lock.path, false);
    const ownerPath = resolve(lock.path, "owner.json");
    safeFile(this.#runtimeRoot, ownerPath);
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning lock owner is invalid.");
    }
    const object = plainObject(owner, "lock owner");
    exactKeys(object, ["format", "ownerHash"], "lock owner");
    if (object.format !== "tilda-learning-lock-v1" || object.ownerHash !== lock.ownerHash) {
      journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning lock ownership changed before release.");
    }
    try {
      unlinkSync(ownerPath);
      rmdirSync(lock.path);
    } catch {
      journalError("LEARNING_JOURNAL_IO_FAILED", "Learning lock could not be released safely.");
    }
  }
}

/**
 * Append-only, raw-free execution journal. A `mkdir` claim is the atomic
 * cross-process lock; immutable sequence 0/1 files make crash state explicit.
 */
export class FileCapabilityLearningExecutionJournal implements CapabilityLearningExecutionJournal {
  readonly #runtimeRoot: string;
  readonly #root: string;
  readonly #entriesRoot: string;
  readonly #keyLocksRoot: string;
  readonly #targetLocksRoot: string;
  readonly #now: () => string;

  constructor(
    root: string,
    runtimeRoot: string = resolve(process.cwd(), ".tilda-runtime"),
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#runtimeRoot = resolve(runtimeRoot);
    this.#root = resolve(root);
    if (!contained(this.#runtimeRoot, this.#root, false)) {
      journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning journal root is outside the ignored runtime directory.");
    }
    this.#entriesRoot = resolve(this.#root, "entries");
    this.#keyLocksRoot = resolve(this.#root, "locks", "keys");
    this.#targetLocksRoot = resolve(this.#root, "locks", "targets");
    this.#now = now;
    safeDirectory(this.#runtimeRoot, this.#entriesRoot, true);
    safeDirectory(this.#runtimeRoot, this.#keyLocksRoot, true);
    safeDirectory(this.#runtimeRoot, this.#targetLocksRoot, true);
  }

  claim(request: LearnCapabilityRequest, lineage: LearningTaskLineage): LearningExecutionClaimResult {
    const identity = identityFor(request, lineage);
    const existing = this.#latest();
    const sameKey = existing.filter((record) => record.idempotencyHash === identity.idempotencyHash);
    if (sameKey.length > 1) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "One idempotency hash belongs to multiple journal histories.");
    }
    if (sameKey.length === 1) return this.#existing(sameKey[0]!, identity);
    if (existing.some((record) =>
      record.targetHash === identity.targetHash &&
      (record.state === "IN_FLIGHT" || record.state === "AMBIGUOUS")
    )) {
      journalError("LEARNING_TARGET_QUARANTINED", "This exact target has an unresolved learning execution.");
    }

    const keyLock = this.#acquire(this.#keyLocksRoot, identity.idempotencyHash.slice(7), identity);
    let targetLock: HeldLock | undefined;
    let claimed = false;
    try {
      targetLock = this.#acquire(this.#targetLocksRoot, identity.targetHash.slice(7), identity);
      // Re-read after both atomic locks to close the scan/claim race.
      const current = this.#latest();
      const currentSameKey = current.filter((record) => record.idempotencyHash === identity.idempotencyHash);
      if (currentSameKey.length > 0) {
        journalError("LEARNING_IDEMPOTENCY_CONFLICT", "Idempotency identity appeared during atomic learning claim.");
      }
      if (current.some((record) =>
        record.targetHash === identity.targetHash &&
        (record.state === "IN_FLIGHT" || record.state === "AMBIGUOUS")
      )) {
        journalError("LEARNING_TARGET_QUARANTINED", "This exact target became quarantined during claim.");
      }
      const record: LearningExecutionRecord = {
        format: "tilda-learning-execution-journal-v1",
        sequence: 0,
        state: "IN_FLIGHT",
        ...structuredClone(identity),
        startedAt: canonicalTimestamp(this.#now(), "startedAt"),
        finishedAt: null,
        failureCode: null,
        restored: null,
      };
      writeExclusive(resolve(this.#entriesRoot, entryName(record)), record);
      claimed = true;
      return {
        kind: "CLAIMED",
        claim: new FileLearningExecutionClaim({
          record,
          entriesRoot: this.#entriesRoot,
          runtimeRoot: this.#runtimeRoot,
          keyLock,
          targetLock,
          now: this.#now,
        }),
      };
    } finally {
      if (!claimed) {
        if (targetLock !== undefined) this.#releaseUnclaimed(targetLock);
        this.#releaseUnclaimed(keyLock);
      }
    }
  }

  #existing(record: LearningExecutionRecord, identity: JournalIdentity): LearningExecutionClaimResult {
    if (!sameIdentity(record, identity)) {
      journalError("LEARNING_IDEMPOTENCY_CONFLICT", "Idempotency key hash is already bound to another exact learning request.");
    }
    if (record.state === "COMPLETED") return { kind: "COMPLETED", record: structuredClone(record) };
    if (record.state === "FAILED") return { kind: "FAILED", record: structuredClone(record) };
    journalError("LEARNING_TARGET_QUARANTINED", "This exact learning execution is unresolved and cannot be retried.");
  }

  #latest(): readonly LearningExecutionRecord[] {
    safeDirectory(this.#runtimeRoot, this.#entriesRoot, false);
    let names: string[];
    try {
      names = readdirSync(this.#entriesRoot, { encoding: "utf8" });
    } catch {
      journalError("LEARNING_JOURNAL_IO_FAILED", "Learning journal entries could not be listed.");
    }
    if (names.length > 10_000) {
      journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal exceeds its bounded entry count.");
    }
    const records = names.sort().map((name) => {
      const match = ENTRY_FILE.exec(name);
      if (match === null) {
        journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal contains an unexpected entry.");
      }
      const path = resolve(this.#entriesRoot, name);
      safeFile(this.#runtimeRoot, path);
      let record: LearningExecutionRecord;
      try {
        record = entryFrom(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        if (error instanceof LearningJournalError) throw error;
        journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal entry is not valid JSON.");
      }
      if (
        record.targetHash.slice(7) !== match[1] ||
        record.idempotencyHash.slice(7) !== match[2] ||
        String(record.sequence) !== match[3] ||
        record.state !== match[4]
      ) {
        journalError("LEARNING_JOURNAL_ENTRY_INVALID", "Learning journal filename does not match its immutable record.");
      }
      return record;
    });
    return latestEntries(records);
  }

  #acquire(root: string, name: string, identity: JournalIdentity): HeldLock {
    if (!HEX_SHA256.test(name)) {
      journalError("LEARNING_JOURNAL_PATH_UNSAFE", "Learning lock name is invalid.");
    }
    safeDirectory(this.#runtimeRoot, root, false);
    const path = resolve(root, name);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        journalError("LEARNING_EXECUTION_BUSY", "Another process owns the exact learning execution boundary.");
      }
      journalError("LEARNING_JOURNAL_IO_FAILED", "Learning execution lock could not be acquired.");
    }
    const ownerHash = canonicalHash({
      format: "tilda-learning-lock-owner-v1",
      requestHash: identity.requestHash,
      nonce: randomUUID(),
    });
    try {
      writeExclusive(resolve(path, "owner.json"), {
        format: "tilda-learning-lock-v1",
        ownerHash,
      });
    } catch (error) {
      // A lock directory without a valid owner is deliberately left behind so
      // a crash cannot be mistaken for a safe retry boundary.
      throw error;
    }
    return { path, ownerHash };
  }

  #releaseUnclaimed(lock: HeldLock): void {
    try {
      const ownerPath = resolve(lock.path, "owner.json");
      safeFile(this.#runtimeRoot, ownerPath);
      const owner = plainObject(JSON.parse(readFileSync(ownerPath, "utf8")), "lock owner");
      if (owner.ownerHash !== lock.ownerHash) return;
      unlinkSync(ownerPath);
      rmdirSync(lock.path);
    } catch {
      // Fail closed: an unreleased pre-claim lock blocks reuse. It never grants
      // another writer or removes a lock whose ownership is uncertain.
    }
  }
}

export function learningIdempotencyHash(idempotencyKey: string): string {
  return hashSecret(idempotencyKey);
}
