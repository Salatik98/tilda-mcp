import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LearnCapabilityRequest } from "../../src/learning/contracts.js";
import {
  FileCapabilityLearningExecutionJournal,
  LearningJournalError,
  learningIdempotencyHash,
  type LearningExecutionClaim,
  type LearningExecutionClaimResult,
} from "../../src/learning/journal.js";

const lineage = {
  taskId: "123e4567-e89b-42d3-a456-426614174000",
  grantHash: `sha256:${"a".repeat(64)}`,
};

function request(
  idempotencyKey: string,
  overrides: Partial<LearnCapabilityRequest> = {},
): LearnCapabilityRequest {
  return {
    mode: "copy-test",
    target: {
      kind: "record",
      projectId: "9101",
      pageId: "9201",
      recordId: "9301",
    },
    targetRole: "test-object",
    capability: "standard.field.patch",
    family: "standard",
    action: "edit",
    dryRun: false,
    idempotencyKey,
    ...overrides,
  };
}

function claimed(result: LearningExecutionClaimResult): LearningExecutionClaim {
  expect(result.kind).toBe("CLAIMED");
  if (result.kind !== "CLAIMED") throw new Error("Expected an atomic journal claim.");
  return result.claim;
}

function allText(root: string): string {
  const collect = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? collect(child) : [readFileSync(child, "utf8")];
  });
  return collect(root).join("\n");
}

function withJournal(
  action: (journal: FileCapabilityLearningExecutionJournal, runtimeRoot: string, root: string) => void,
): void {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-journal-"));
  const root = join(runtimeRoot, "mcp-v1", "learning", "executions");
  try {
    action(
      new FileCapabilityLearningExecutionJournal(
        root,
        runtimeRoot,
        () => "2026-08-20T00:00:00.000Z",
      ),
      runtimeRoot,
      root,
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

describe("durable capability-learning execution journal", () => {
  it("rejects missing runtime and journal roots below a symlink, junction, or redirected ancestor", () => {
    const base = mkdtempSync(join(tmpdir(), "tilda-learning-path-"));
    try {
      const redirectedRuntimeTarget = join(base, "redirected-runtime-target");
      mkdirSync(redirectedRuntimeTarget);
      const runtimeLink = join(base, "runtime-link");
      symlinkSync(
        redirectedRuntimeTarget,
        runtimeLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      const missingRuntime = join(runtimeLink, "missing-runtime");
      expect(() => new FileCapabilityLearningExecutionJournal(
        join(missingRuntime, "executions"),
        missingRuntime,
      )).toThrowError(expect.objectContaining({ code: "LEARNING_JOURNAL_PATH_UNSAFE" }));
      expect(existsSync(join(redirectedRuntimeTarget, "missing-runtime"))).toBe(false);

      const safeRuntime = join(base, "safe-runtime");
      const redirectedRootTarget = join(base, "redirected-root-target");
      mkdirSync(safeRuntime);
      mkdirSync(redirectedRootTarget);
      const rootLink = join(safeRuntime, "root-link");
      symlinkSync(
        redirectedRootTarget,
        rootLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => new FileCapabilityLearningExecutionJournal(
        join(rootLink, "missing", "executions"),
        safeRuntime,
      )).toThrowError(expect.objectContaining({ code: "LEARNING_JOURNAL_PATH_UNSAFE" }));
      expect(existsSync(join(redirectedRootTarget, "missing"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("atomically claims, completes, and persists only hash-bound content-free identity", () => {
    withJournal((journal, runtimeRoot, root) => {
      const rawKey = "learning-secret-idempotency-key";
      const claim = claimed(journal.claim(request(rawKey), lineage));

      expect(claim.record).toMatchObject({
        state: "IN_FLIGHT",
        sequence: 0,
        idempotencyHash: learningIdempotencyHash(rawKey),
        taskId: lineage.taskId,
        grantHash: lineage.grantHash,
      });
      expect(claim.record.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(claim.complete()).toMatchObject({ state: "COMPLETED", sequence: 1, restored: true });

      const reloaded = new FileCapabilityLearningExecutionJournal(root, runtimeRoot);
      expect(reloaded.claim(request(rawKey), lineage)).toMatchObject({
        kind: "COMPLETED",
        record: { state: "COMPLETED" },
      });
      const persisted = allText(root);
      expect(persisted).not.toContain(rawKey);
      expect(persisted).not.toContain("cookie");
      expect(persisted).not.toContain("session");
      expect(persisted).not.toContain("browser");
    });
  });

  it("blocks an in-flight/crashed or ambiguous exact target and serializes every writer on it", () => {
    withJournal((journal) => {
      claimed(journal.claim(request("learning-in-flight-key"), lineage));

      expect(() => journal.claim(request("learning-second-key"), lineage)).toThrowError(
        expect.objectContaining({ code: "LEARNING_TARGET_QUARANTINED" }),
      );
      expect(() => journal.claim(request("learning-other-capability", {
        capability: "standard.block.configure",
        action: "configure",
      }), lineage)).toThrowError(
        expect.objectContaining({ code: "LEARNING_TARGET_QUARANTINED" }),
      );
    });

    withJournal((journal) => {
      const claim = claimed(journal.claim(request("learning-ambiguous-key"), lineage));
      claim.ambiguous("LEARNING_RESTORE_FAILED");
      expect(() => journal.claim(request("learning-after-ambiguous", {
        capability: "standard.block.configure",
        action: "configure",
      }), lineage)).toThrowError(
        expect.objectContaining({ code: "LEARNING_TARGET_QUARANTINED" }),
      );
    });
  });

  it("makes a safely restored failure terminal for the same key but admits one explicit new key", () => {
    withJournal((journal) => {
      const first = request("learning-failed-key");
      claimed(journal.claim(first, lineage)).fail("LEARNING_REPLAY_MISMATCH");

      expect(journal.claim(first, lineage)).toMatchObject({
        kind: "FAILED",
        record: { state: "FAILED", restored: true },
      });
      const next = claimed(journal.claim(request("learning-new-explicit-key"), lineage));
      next.complete();
    });
  });

  it("rejects reuse of one raw key for another exact request or task lineage", () => {
    withJournal((journal) => {
      const key = "learning-conflict-key";
      claimed(journal.claim(request(key), lineage)).complete();

      const otherTarget = request(key, {
        target: {
          kind: "record",
          projectId: "9101",
          pageId: "9201",
          recordId: "9302",
        },
      });
      expect(() => journal.claim(otherTarget, lineage)).toThrowError(
        expect.objectContaining({ code: "LEARNING_IDEMPOTENCY_CONFLICT" }),
      );
      expect(() => journal.claim(request(key), {
        ...lineage,
        taskId: "123e4567-e89b-42d3-a456-426614174001",
      })).toThrowError(LearningJournalError);
    });
  });
});
