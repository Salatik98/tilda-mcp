import { describe, expect, it, vi } from "vitest";

import {
  acquireLoopbackBrowserAuthority,
  acquireLoopbackBrowserReadAuthority,
  type LoopbackBrowserAuthorityDependencies,
} from "../../src/control/browser-authority.js";
import type { AuthorityOwnedLoopbackBrowserSession } from "../../src/research/browser-session.js";
import {
  hashLiveInventory,
  type LiveInventory,
  type ResearchConfig,
} from "../../src/research/config.js";
import type { TrustedBindingEstablished } from "../../src/research/inventory.js";

const ROOT_TARGET = Object.freeze({
  id: "root-test",
  type: "page",
  title: "Projects",
  url: "https://tilda.ru/projects/",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/root-test",
});
const SOURCE_PAGE = Object.freeze({ projectId: "8101", pageId: "8201" });
const LAB_PAGE = Object.freeze({ projectId: "9101", pageId: "9201" });

function fixture(): {
  config: ResearchConfig;
  inventory: LiveInventory;
  binding: TrustedBindingEstablished;
} {
  const accountFingerprint = "a".repeat(64);
  const inventory: LiveInventory = Object.freeze({
    accountFingerprint,
    projectIds: Object.freeze([SOURCE_PAGE.projectId, LAB_PAGE.projectId]),
    pageOwnership: Object.freeze({
      [SOURCE_PAGE.projectId]: Object.freeze([SOURCE_PAGE.pageId]),
      [LAB_PAGE.projectId]: Object.freeze([LAB_PAGE.pageId]),
    }),
  });
  const inventoryHash = hashLiveInventory(inventory);
  const config: ResearchConfig = {
    cdpUrl: "http://127.0.0.1:9222",
    bindingKeyPath: "C:\\workspace\\.tilda-runtime\\account-binding.key",
    bindingStatePath: "C:\\workspace\\.tilda-runtime\\account-binding.json",
    observatoryHost: "127.0.0.1",
    observatoryPort: 4765,
    accountFingerprint,
    inventoryHash,
    labProjectIds: [LAB_PAGE.projectId],
    readOnlyProjectIds: [SOURCE_PAGE.projectId],
    labPageTargets: [LAB_PAGE],
    labRecordTargets: [],
    publicTestDomains: ["example.test"],
    officialApiConfigured: false,
  };
  const binding: TrustedBindingEstablished = Object.freeze({
    status: "BOUND",
    capturedAt: new Date(1_000).toISOString(),
    source: "trusted_same_session_cdp",
    route: "/projects/",
    accountFingerprint,
    inventoryHash,
    inventory,
    projectCount: 2,
    pageCount: 2,
    captureContext: Object.freeze({
      cdpTargetId: ROOT_TARGET.id,
      expiresAt: new Date(20_000).toISOString(),
    }),
    privacy: Object.freeze({
      rawAccountIdPersisted: false,
      titlesOrContentPersisted: false,
      cookiesOrSessionDataPersisted: false,
    }),
  });
  return { config, inventory, binding };
}

function fakeSession() {
  const readPageHeadCode = vi.fn(async (target: typeof LAB_PAGE) => ({
    uiReady: true,
    host: "tilda.ru",
    route: "/projects/editheadcode/",
    href: `https://tilda.ru/projects/editheadcode/?pageid=${target.pageId}&projectid=${target.projectId}`,
    target,
    code: "<meta name=\"baseline\">",
    saveFunctionHash: "f".repeat(64),
  }));
  const writePageHeadCode = vi.fn(async () => ({
    dispatched: true as const,
    httpOk: true,
    status: 200,
    responseBytes: 2,
  }));
  const publishPage = vi.fn();
  const session = {
    transport: "loopback_cdp",
    sessionId: ROOT_TARGET.id,
    readPageHeadCode,
    writePageHeadCode,
    publishPage,
    restoreRoot: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
  } as unknown as AuthorityOwnedLoopbackBrowserSession;
  return { session, readPageHeadCode, writePageHeadCode, publishPage };
}

function dependencies(
  binding: TrustedBindingEstablished,
  session: AuthorityOwnedLoopbackBrowserSession,
): LoopbackBrowserAuthorityDependencies {
  return {
    listTargets: vi.fn(async () => [ROOT_TARGET]),
    openSession: vi.fn(async () => session),
    captureBinding: vi.fn(async () => binding),
    isFreshBinding: (capture): capture is TrustedBindingEstablished => capture?.status === "BOUND",
    now: () => 1_000,
    randomId: () => "operation-test",
  };
}

describe("page HEAD browser authority", () => {
  it("compares exact current code before one lab write and never publishes", async () => {
    const { config, binding } = fixture();
    const fake = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, fake.session),
    );
    try {
      await expect(
        authority.adapter.writePageHeadCode(
          LAB_PAGE,
          "<meta name=\"replacement\">",
          "<meta name=\"baseline\">",
        ),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
      expect(fake.readPageHeadCode).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect(fake.writePageHeadCode).toHaveBeenCalledWith(
        LAB_PAGE,
        "<meta name=\"replacement\">",
        "<meta name=\"baseline\">",
        12_000,
      );
      expect(fake.publishPage).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it("rejects stale or source-target HEAD writes before dispatch", async () => {
    const { config, binding } = fixture();
    for (const scenario of ["stale", "source"] as const) {
      const fake = fakeSession();
      const authority = await acquireLoopbackBrowserAuthority(
        config,
        {},
        dependencies(binding, fake.session),
      );
      try {
        const target = scenario === "source" ? SOURCE_PAGE : LAB_PAGE;
        await expect(
          authority.adapter.writePageHeadCode(target, "replacement", "not-current"),
        ).rejects.toMatchObject({ code: scenario === "source" ? "TARGET_REJECTED" : "STALE_TARGET" });
        expect(fake.writePageHeadCode).not.toHaveBeenCalled();
        if (scenario === "source") expect(fake.readPageHeadCode).not.toHaveBeenCalled();
      } finally {
        await authority.close();
      }
    }
  });

  it("allows an exact classified read-only source page without exposing a writer", async () => {
    const { config, binding } = fixture();
    const fake = fakeSession();
    const authority = await acquireLoopbackBrowserReadAuthority(
      config,
      {},
      dependencies(binding, fake.session),
    );
    try {
      await expect(authority.reader.readPageHeadCode(SOURCE_PAGE)).resolves.toMatchObject({
        target: SOURCE_PAGE,
        code: "<meta name=\"baseline\">",
      });
      expect("writePageHeadCode" in authority.reader).toBe(false);
    } finally {
      await authority.close();
    }
  });
});
