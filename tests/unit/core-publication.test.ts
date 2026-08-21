import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AdapterSessionFactory,
  BoundAdapterSession,
  PublicationData,
} from "../../src/adapters/session.js";
import {
  PublicationController,
  PublicPageVerifier,
} from "../../src/core/publication.js";
import { ChangeSetStore } from "../../src/core/store.js";
import {
  TaskAuthorityManager,
  type MintTaskAuthorityInput,
} from "../../src/core/task-authority-manager.js";
import { TaskScopedPublicationController } from "../../src/core/task-authority.js";

const target = {
  kind: "page" as const,
  projectId: "9101",
  pageId: "9201",
};

function intentHash(action: "publish" | "unpublish"): string {
  return createHash("sha256")
    .update(`tilda-publication-v1\0${action}\0${target.projectId}\0${target.pageId}`)
    .digest("hex");
}

function changedHash(value: string): string {
  return createHash("sha256")
    .update(`tilda-publication-changed-v1\0${value}`)
    .digest("hex");
}

class PublicationSession {
  data: PublicationData = {
    changed: "revision-1",
    published: "",
    pageUrl: "editor-page",
    publicUrl: "public-page",
  };
  publishCalls = 0;
  unpublishCalls = 0;
  unpublishReadsAfterDispatch = 0;
  unpublishDispatched = false;
  mode: "success" | "throw-before" | "throw-after" = "success";
  afterRead: (() => void) | undefined;

  readonly factory: AdapterSessionFactory = {
    withSession: async <T>(action: (session: BoundAdapterSession) => Promise<T>) =>
      action(this.boundSession()),
  };

  boundSession(): BoundAdapterSession {
    const unavailable = async () => {
      throw new Error("unused test method");
    };
    return {
      leaseId: "lease-1",
      sessionId: "session-1",
      readPublication: async () => {
        if (
          this.unpublishDispatched &&
          this.unpublishReadsAfterDispatch >= 1 &&
          this.data.published !== ""
        ) {
          this.data = { ...this.data, published: "" };
        }
        if (this.unpublishDispatched) this.unpublishReadsAfterDispatch += 1;
        const result = structuredClone(this.data);
        this.afterRead?.();
        return result;
      },
      publish: async () => {
        this.publishCalls += 1;
        if (this.mode === "throw-before") throw new Error("dispatch failed");
        this.data = { ...this.data, published: "published" };
        if (this.mode === "throw-after") throw new Error("ack lost");
        return {
          operationId: "publish-1",
          requestDispatched: true,
          acknowledgement: "acknowledged" as const,
          publishObserved: false as const,
        };
      },
      unpublish: async () => {
        this.unpublishCalls += 1;
        this.unpublishDispatched = true;
        return {
          operationId: "unpublish-1",
          requestDispatched: true,
          acknowledgement: "acknowledged" as const,
          publishObserved: false as const,
        };
      },
      readStandard: unavailable,
      writeStandard: unavailable,
      readT123: unavailable,
      writeT123: unavailable,
      readZero: unavailable,
      writeZero: unavailable,
      readPageSettings: unavailable,
      writePageSettings: unavailable,
      readPageHeadCode: unavailable,
      writePageHeadCode: unavailable,
    } as BoundAdapterSession;
  }
}

let testRoot: string;
let store: ChangeSetStore;
let session: PublicationSession;

beforeEach(() => {
  testRoot = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "core-publication-test-"));
  store = new ChangeSetStore(testRoot);
  session = new PublicationSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
});

describe("PublicationController durable idempotency", () => {
  it("persists success and never redispatches after controller restart", async () => {
    const first = new PublicationController(session.factory, store);
    const result = await first.execute("publish", target, {
      dryRun: false,
      idempotencyKey: "publication-success-1",
    });
    expect(result.stateChanged).toBe(true);
    expect(session.publishCalls).toBe(1);

    const restarted = new PublicationController(session.factory, new ChangeSetStore(testRoot));
    const replay = await restarted.execute("publish", target, {
      dryRun: false,
      idempotencyKey: "publication-success-1",
    });
    expect(replay.stateChanged).toBe(false);
    expect(session.publishCalls).toBe(1);
  });

  it("reconciles a thrown acknowledgement when editor reread proves success", async () => {
    session.mode = "throw-after";
    const controller = new PublicationController(session.factory, store);

    const result = await controller.execute("publish", target, {
      dryRun: false,
      idempotencyKey: "publication-reconcile-1",
    });
    expect(result.stateChanged).toBe(true);
    expect(store.loadPublicationAction("publication-reconcile-1")).toMatchObject({
      state: "SUCCEEDED",
      reconciliationCode: "PUBLICATION_ERROR_RECONCILED",
    });
  });

  it("journals an unchanged failure and blocks replay after restart", async () => {
    session.mode = "throw-before";

    await expect(
      new PublicationController(session.factory, store, { delaysMs: [] }).execute("publish", target, {
        dryRun: false,
        idempotencyKey: "publication-failure-1",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_FAILED_UNCHANGED" });
    const restarted = new PublicationController(session.factory, new ChangeSetStore(testRoot));
    await expect(
      restarted.execute("publish", target, {
        dryRun: false,
        idempotencyKey: "publication-failure-1",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(session.publishCalls).toBe(1);
  });

  it("reconciles a delayed unpublish without redispatching the write", async () => {
    session.data = { ...session.data, published: "published" };
    const controller = new PublicationController(session.factory, store, {
      delaysMs: [1],
      delay: async () => undefined,
    });

    const result = await controller.execute("unpublish", target, {
      dryRun: false,
      idempotencyKey: "publication-delayed-unpublish-1",
    });

    expect(result.stateChanged).toBe(true);
    expect(result.after.published).toBe("");
    expect(session.unpublishCalls).toBe(1);
    expect(store.loadPublicationAction("publication-delayed-unpublish-1")).toMatchObject({
      state: "SUCCEEDED",
    });
  });

  it("does not dispatch when a prior durable claim has no terminal journal", async () => {
    store.claimPublicationAction("publication-crash-1", {
      intentHash: intentHash("publish"),
      action: "publish",
      target,
      beforePublished: false,
      beforeChangedHash: changedHash("revision-1"),
    });
    const restarted = new PublicationController(session.factory, new ChangeSetStore(testRoot));

    await expect(
      restarted.execute("publish", target, {
        dryRun: false,
        idempotencyKey: "publication-crash-1",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(session.publishCalls).toBe(0);
    expect(store.loadPublicationAction("publication-crash-1")).toMatchObject({
      state: "FAILED",
      failureCode: "PUBLICATION_PREVIOUS_ATTEMPT_UNCHANGED",
    });
  });

  it("keeps actual publication read, dispatch, and reconciliation under one task lineage", async () => {
    let nextId = 1;
    const authority = new TaskAuthorityManager({
      now: () => new Date("2026-08-20T04:00:00.000Z"),
      createTaskId: () =>
        `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    const authorityInput: MintTaskAuthorityInput = {
      taskDescription: "Publish one exact page and reconcile the editor state",
      mode: "production",
      observeTargets: [],
      writeTargets: [target],
      allowedOperations: [],
      publication: { actions: ["publish"], targets: [target] },
      binding: {
        accountFingerprint: "a".repeat(64),
        inventoryHash: "b".repeat(64),
      },
      ttlMs: 60_000,
    };
    const initial = authority.mint(authorityInput);
    const transitionErrors: unknown[] = [];
    let firstRead = true;
    session.afterRead = () => {
      if (!firstRead) return;
      firstRead = false;
      expect(session.publishCalls).toBe(0);
      expect(authority.currentReceipt()).toEqual(initial);
      try {
        authority.replace({ ...authorityInput, taskDescription: "replacement task" });
      } catch (error) {
        transitionErrors.push(error);
      }
      try {
        authority.clear();
      } catch (error) {
        transitionErrors.push(error);
      }
      expect(authority.currentReceipt()).toEqual(initial);
    };
    const scoped = new TaskScopedPublicationController(
      new PublicationController(session.factory, store, { delaysMs: [] }),
      authority.requireGuard(),
    );

    await expect(scoped.execute("publish", target, {
      dryRun: false,
      idempotencyKey: "scoped-publication-1",
    })).resolves.toMatchObject({
      action: "publish",
      target,
      stateChanged: true,
      dryRun: false,
    });
    expect(session.publishCalls).toBe(1);
    expect(transitionErrors).toHaveLength(2);
    for (const error of transitionErrors) {
      expect(error).toMatchObject({ code: "TASK_AUTHORITY_EXECUTION_IN_PROGRESS" });
    }
    expect(authority.currentReceipt()).toEqual(initial);
    expect(authority.replace({ ...authorityInput, taskDescription: "replacement task" })).toMatchObject({
      taskId: "018f0000-0000-7000-8000-000000000002",
    });
  });
});

describe("PublicPageVerifier", () => {
  it("allows an empty public-domain allowlist but fails closed before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const verifier = new PublicPageVerifier([]);

    await expect(verifier.verify("https://example.test/page")).rejects.toMatchObject({
      code: "PUBLIC_DOMAIN_NOT_ALLOWLISTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe allowlists and URL ambiguity before fetch", async () => {
    expect(() => new PublicPageVerifier(["localhost"])).toThrow(
      expect.objectContaining({ code: "INVALID_PUBLIC_DOMAIN_ALLOWLIST" }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const verifier = new PublicPageVerifier(["lab.example.com"]);

    await expect(verifier.verify("https://lab.example.com/page?token=secret")).rejects.toMatchObject({
      code: "PUBLIC_DOMAIN_NOT_ALLOWLISTED",
    });
    await expect(verifier.verify("https://lab.example.com:444/page")).rejects.toMatchObject({
      code: "PUBLIC_DOMAIN_NOT_ALLOWLISTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs a bounded cache-busted HTML verification", async () => {
    const html =
      '<html><head><title> Lab page </title><link href="https://lab.example.com/page" rel="canonical"></head>' +
      '<body><div id="rec123"></div><div id="record456"></div><div id="rec123"></div></body></html>';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const verifier = new PublicPageVerifier(["lab.example.com"]);

    const result = await verifier.verify("https://lab.example.com/page");
    expect(result).toMatchObject({
      ok: true,
      url: "https://lab.example.com/page",
      title: "Lab page",
      canonicalUrl: "https://lab.example.com/page",
      recordIds: ["123", "456"],
      cacheBusted: true,
    });
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("__tilda_mcp_verify")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("rejects excessive declared response size without reading a body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("small", {
          status: 200,
          headers: {
            "content-type": "text/html",
            "content-length": "5000001",
          },
        }),
      ),
    );
    const verifier = new PublicPageVerifier(["lab.example.com"]);
    await expect(verifier.verify("https://lab.example.com/page")).rejects.toMatchObject({
      code: "PUBLIC_RESPONSE_TOO_LARGE",
    });
  });
});
