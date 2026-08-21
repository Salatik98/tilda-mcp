import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  ChangeSetRecord,
  ChangeSetTaskAuthority,
  ExactTarget,
  SnapshotEnvelope,
} from "../../src/core/contracts.js";
import { TildaEngineError } from "../../src/core/contracts.js";
import { ChangeSetStore } from "../../src/core/store.js";

let testRoot: string;
let store: ChangeSetStore;

const target: ExactTarget = {
  kind: "record",
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};

type RecordOptions = {
  changeSetId?: string;
  updatedAt?: string;
  taskAuthority?: ChangeSetTaskAuthority;
};

const beforeHash = `sha256:${"1".repeat(64)}`;
const afterHash = `sha256:${"2".repeat(64)}`;
const requestHash = `sha256:${"3".repeat(64)}`;

function changeSet(options: RecordOptions = {}): ChangeSetRecord {
  const createdAt = "2026-08-17T00:00:00.000Z";
  const record: ChangeSetRecord = {
    format: "tilda-mcp-changeset-v1",
    changeSetId: options.changeSetId ?? randomUUID(),
    snapshotId: randomUUID(),
    state: "PLANNED",
    createdAt,
    updatedAt: options.updatedAt ?? createdAt,
    adapter: "standard",
    capability: "standard.field.patch",
    target,
    operation: "standard.field.patch",
    requestHash,
    expectedBeforeHash: beforeHash,
    expectedAfterHash: afterHash,
    changedPaths: ["/value"],
    summary: "unit-test changeset",
    ...(options.taskAuthority === undefined
      ? {}
      : { taskAuthority: structuredClone(options.taskAuthority) }),
  };
  return record;
}

function expectEngineCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TildaEngineError);
  expect(thrown).toMatchObject({ code });
}

function removePath(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

beforeEach(() => {
  testRoot = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "core-store-test-"));
  store = new ChangeSetStore(testRoot);
});

afterEach(() => {
  removePath(testRoot);
});

describe("ChangeSetStore", () => {
  it("persists an immutable snapshot of caller-owned state", () => {
    const snapshotTarget: ExactTarget = { ...target };
    const snapshotInput: Omit<SnapshotEnvelope, "format" | "snapshotId" | "createdAt"> = {
      adapter: "standard",
      target: snapshotTarget,
      stateHash: beforeHash,
      revision: "revision-1",
      summary: "unit-test snapshot",
    };

    const snapshot = store.createSnapshot(snapshotInput);
    const persistedSnapshot = structuredClone(snapshot);
    snapshotTarget.projectId = "mutated-after-create";

    expect(store.loadSnapshot(snapshot.snapshotId)).toEqual(persistedSnapshot);
  });

  it("keeps ChangeSet state append-only and rejects stale events", () => {
    const first = changeSet();
    store.createChangeSet(first);
    const second: ChangeSetRecord = {
      ...first,
      state: "APPLIED",
      updatedAt: "2026-08-17T00:00:01.000Z",
      appliedHash: afterHash,
      verification: {
        checkedAt: "2026-08-17T00:00:01.000Z",
        expectedHash: afterHash,
        actualHash: afterHash,
        exactMatch: true,
      },
    };
    store.appendChangeSet(second);

    const stale: ChangeSetRecord = {
      ...second,
      state: "FAILED",
      updatedAt: "2026-08-17T00:00:00.500Z",
      failureCode: "UNIT_TEST_FAILURE",
    };
    expectEngineCode(() => store.appendChangeSet(stale), "STALE_CHANGESET");

    const eventDir = resolve(testRoot, "changesets", first.changeSetId);
    expect(readdirSync(eventDir).sort()).toEqual(["000001.json", "000002.json"]);
    expect(JSON.parse(readFileSync(resolve(eventDir, "000001.json"), "utf8"))).toEqual(first);
    expect(store.loadChangeSet(first.changeSetId)).toEqual(second);
  });

  it("supports idempotency lookup and rejects a conflicting key without orphan state", () => {
    const key = "phase2-idempotency-1";
    const first = store.createChangeSet(changeSet(), key);

    expect(store.findByIdempotencyKey(key)).toEqual(first);
    expect(store.findByIdempotencyKey("phase2-idempotency-2")).toBeNull();

    const conflicting = changeSet();
    expectEngineCode(() => store.createChangeSet(conflicting, key), "IDEMPOTENCY_CONFLICT");
    expectEngineCode(() => store.loadChangeSet(conflicting.changeSetId), "CHANGESET_NOT_FOUND");
  });

  it("persists only an idempotency digest and blocks a new key after an action claim", () => {
    const rawKey = "phase2-private-idempotency-value";
    const record = store.createChangeSet(changeSet(), rawKey);
    const eventPath = resolve(testRoot, "changesets", record.changeSetId, "000001.json");
    const persisted = readFileSync(eventPath, "utf8");

    expect(persisted).not.toContain(rawKey);
    expect(record.planIdempotencyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.claimActionIdempotency("phase2-apply-key-1", "apply", record.changeSetId)).toBe(
      "CLAIMED",
    );
    expect(store.claimActionIdempotency("phase2-apply-key-1", "apply", record.changeSetId)).toBe(
      "REPLAY",
    );
    expectEngineCode(
      () => store.claimActionIdempotency("phase2-apply-key-2", "apply", record.changeSetId),
      "RECOVERY_REQUIRED",
    );
  });

  it("rejects immutable-field changes and invalid state transitions", () => {
    const first = store.createChangeSet(changeSet());
    expectEngineCode(
      () =>
        store.appendChangeSet({
          ...first,
          summary: "tampered immutable summary",
          updatedAt: "2026-08-17T00:00:01.000Z",
        }),
      "JOURNAL_IMMUTABLE_FIELD_CHANGED",
    );

    const invalidTransition: ChangeSetRecord = {
      ...first,
      state: "VERIFIED",
      updatedAt: "2026-08-17T00:00:01.000Z",
      appliedHash: afterHash,
      verification: {
        checkedAt: "2026-08-17T00:00:01.000Z",
        expectedHash: afterHash,
        actualHash: afterHash,
        exactMatch: true,
      },
    };
    expectEngineCode(
      () => store.appendChangeSet(invalidTransition),
      "INVALID_STATE_TRANSITION",
    );
  });

  it("validates and preserves immutable task authority provenance", () => {
    const taskAuthority = {
      taskId: "018f0000-0000-7000-8000-000000000001",
      grantHash: `sha256:${"a".repeat(64)}`,
    };
    const first = store.createChangeSet(changeSet({ taskAuthority }));
    expect(store.loadChangeSet(first.changeSetId).taskAuthority).toEqual(taskAuthority);

    expectEngineCode(() => store.appendChangeSet({
      ...first,
      taskAuthority: {
        ...taskAuthority,
        grantHash: `sha256:${"b".repeat(64)}`,
      },
      updatedAt: "2026-08-17T00:00:01.000Z",
    }), "JOURNAL_IMMUTABLE_FIELD_CHANGED");

    expectEngineCode(() => store.createChangeSet(changeSet({
      taskAuthority: {
        taskId: "not-a-task-id",
        grantHash: taskAuthority.grantHash,
      },
    })), "STATE_CORRUPT");
  });

  it("detects an event-sequence gap without overwriting the unexpected file", () => {
    const first = store.createChangeSet(changeSet());
    const eventDir = resolve(testRoot, "changesets", first.changeSetId);
    const unexpected = resolve(eventDir, "000003.json");
    writeFileSync(unexpected, "sentinel", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const second: ChangeSetRecord = {
      ...first,
      state: "FAILED",
      updatedAt: "2026-08-17T00:00:01.000Z",
      failureCode: "UNIT_TEST_FAILURE",
    };

    expectEngineCode(() => store.appendChangeSet(second), "STATE_CORRUPT");
    expect(readFileSync(unexpected, "utf8")).toBe("sentinel");
    expect(existsSync(resolve(eventDir, "000002.json"))).toBe(false);
  });

  it("fails closed for malformed state IDs and idempotency keys", () => {
    expectEngineCode(() => store.loadSnapshot("not-a-uuid"), "INVALID_STATE_ID");
    expectEngineCode(() => store.loadChangeSet("not-a-uuid"), "INVALID_STATE_ID");
    expectEngineCode(() => store.findByIdempotencyKey("short"), "INVALID_IDEMPOTENCY_KEY");
    expectEngineCode(() => store.findByIdempotencyKey(" too-long-by-policy "), "INVALID_IDEMPOTENCY_KEY");
  });

  it("refuses a held mutation lock without invoking the mutation", async () => {
    const lockPath = resolve(testRoot, "mutation.lock");
    writeFileSync(lockPath, "held by another process", { encoding: "utf8", flag: "wx", mode: 0o600 });
    let invoked = false;

    await expect(
      store.withMutationLock(async () => {
        invoked = true;
        return "must not run";
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_OPERATION" });
    expect(invoked).toBe(false);

    unlinkSync(lockPath);
    await expect(store.withMutationLock(async () => "released")).resolves.toBe("released");
  });

  it("rejects a state root outside the workspace runtime directory", () => {
    const outsideRoot = resolve(process.cwd(), `core-store-outside-${randomUUID()}`);
    expectEngineCode(() => new ChangeSetStore(outsideRoot), "UNSAFE_STATE_PATH");
    expect(existsSync(outsideRoot)).toBe(false);
  });

  it("rejects a symlink used as the state root when the platform permits symlinks", () => {
    const outsideRoot = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "core-store-symlink-target-"));
    const link = resolve(process.cwd(), ".tilda-runtime", `core-store-symlink-${randomUUID()}`);
    try {
      try {
        symlinkSync(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return;
      }
      expectEngineCode(() => new ChangeSetStore(link), "UNSAFE_STATE_PATH");
    } finally {
      removePath(link);
      removePath(outsideRoot);
    }
  });

  it("rejects a symlinked ancestor that would redirect state outside the runtime directory", () => {
    const outsideRoot = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "core-store-ancestor-target-"));
    const link = resolve(process.cwd(), ".tilda-runtime", `core-store-ancestor-${randomUUID()}`);
    const redirectedRoot = resolve(link, "nested");
    try {
      try {
        symlinkSync(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return;
      }
      expectEngineCode(() => new ChangeSetStore(redirectedRoot), "UNSAFE_STATE_PATH");
    } finally {
      removePath(link);
      removePath(outsideRoot);
    }
  });
});
