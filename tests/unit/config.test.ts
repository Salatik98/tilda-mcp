import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLabPageTarget,
  assertLabProjectTarget,
  assertLabRecordTarget,
  ConfigurationError,
  hashLiveInventory,
  isWriteAllowlistSyntacticallyValid,
  type LiveInventory,
  loadConfig,
  TargetNotAllowlistedError,
} from "../../src/research/config.js";
import { KNOWN_READ_ONLY_SOURCE_PROJECT_IDS } from "../../src/research/known-source-corpus.js";

const MANAGED_KEYS = [
  "TILDA_ACCOUNT_FINGERPRINT",
  "TILDA_INVENTORY_HASH",
  "TILDA_BINDING_KEY_PATH",
  "TILDA_BINDING_STATE_PATH",
  "LAB_PROJECT_IDS",
  "LAB_PAGE_TARGETS",
  "LAB_RECORD_TARGETS",
  "READ_ONLY_PROJECT_IDS",
  "PUBLIC_TEST_DOMAINS",
  "TILDA_PUBLIC_KEY",
  "TILDA_SECRET_KEY",
  "TILDA_CDP_URL",
] as const;

beforeEach(() => {
  process.env.TILDA_BINDING_KEY_PATH = ".tilda-runtime/unit-test-binding.key";
  process.env.TILDA_BINDING_STATE_PATH = ".tilda-runtime/unit-test-binding.json";
});

function liveInventory(overrides: Partial<LiveInventory> = {}): LiveInventory {
  return {
    accountFingerprint: "b".repeat(64),
    projectIds: ["123", "456", "999", "10001", "10002", "10003", "10004", "10005"],
    pageOwnership: {
      "123": ["9001"],
      "456": ["9002"],
      "999": [],
      "10001": [],
      "10002": [],
      "10003": [],
      "10004": [],
      "10005": [],
    },
    ...overrides,
  };
}

function configureBoundLab(inventory = liveInventory()): void {
  process.env.TILDA_ACCOUNT_FINGERPRINT = inventory.accountFingerprint;
  process.env.TILDA_INVENTORY_HASH = hashLiveInventory(inventory);
  process.env.LAB_PROJECT_IDS = "123,456";
  process.env.READ_ONLY_PROJECT_IDS = "999,10001,10002,10003,10004,10005";
  process.env.LAB_PAGE_TARGETS = "123:9001,456:9002";
  process.env.LAB_RECORD_TARGETS = "UNSPECIFIED";
}

afterEach(() => {
  for (const key of MANAGED_KEYS) delete process.env[key];
});

describe("research configuration", () => {
  it("blocks all writes when the lab allowlist is unspecified", () => {
    process.env.LAB_PROJECT_IDS = "UNSPECIFIED";
    const config = loadConfig();
    expect(() => assertLabProjectTarget(config, { projectId: "123" }, liveInventory())).toThrow(
      TargetNotAllowlistedError,
    );
  });

  it("accepts only exact bound project/page pairs", () => {
    configureBoundLab();
    const config = loadConfig();

    expect(isWriteAllowlistSyntacticallyValid(config)).toBe(true);
    expect(() => assertLabProjectTarget(config, { projectId: "123" }, liveInventory())).not.toThrow();
    expect(() => assertLabPageTarget(config, { projectId: "123", pageId: "9001" }, liveInventory())).not.toThrow();
    expect(() => assertLabPageTarget(config, { projectId: "456", pageId: "9001" }, liveInventory())).toThrow(
      /does not bind page 9001 to project 456/,
    );
    expect(() => assertLabPageTarget(config, { projectId: "123", pageId: "9002" }, liveInventory())).toThrow(
      /does not bind page 9002 to project 123/,
    );
  });

  it("blocks overlapping lab/read-only configuration globally", () => {
    configureBoundLab();
    process.env.READ_ONLY_PROJECT_IDS = "123,999,10001,10002,10003,10004,10005";
    const config = loadConfig();

    expect(isWriteAllowlistSyntacticallyValid(config)).toBe(false);
    expect(() => assertLabProjectTarget(config, { projectId: "456" }, liveInventory())).toThrow(
      /overlaps READ_ONLY_PROJECT_IDS: 123/,
    );
  });

  it("blocks writes until account fingerprint and inventory hash are configured", () => {
    process.env.LAB_PROJECT_IDS = "123";
    process.env.READ_ONLY_PROJECT_IDS = "999,10001,10002,10003,10004,10005";
    const config = loadConfig();

    expect(isWriteAllowlistSyntacticallyValid(config)).toBe(false);
    expect(() => assertLabProjectTarget(config, { projectId: "123" }, liveInventory())).toThrow(
      /account fingerprint and inventory hash/,
    );
  });

  it("requires a nonempty protected source corpus before writes", () => {
    configureBoundLab();
    process.env.READ_ONLY_PROJECT_IDS = "UNSPECIFIED";
    const config = loadConfig();

    expect(isWriteAllowlistSyntacticallyValid(config)).toBe(false);
    expect(() => assertLabProjectTarget(config, { projectId: "123" }, liveInventory())).toThrow(
      /READ_ONLY_PROJECT_IDS is UNSPECIFIED/,
    );
  });

  it.each([
    ["mixed unspecified", "LAB_PROJECT_IDS", "UNSPECIFIED,123"],
    ["wildcard", "LAB_PROJECT_IDS", "*"],
    ["leading zero", "LAB_PROJECT_IDS", "0123"],
    ["plus sign", "LAB_PROJECT_IDS", "+123"],
    ["page wildcard", "LAB_PAGE_TARGETS", "123:*"],
    ["unbound page", "LAB_PAGE_TARGETS", "9001"],
  ])("rejects noncanonical %s configuration", (_label, key, value) => {
    process.env[key] = value;
    expect(() => loadConfig()).toThrow(ConfigurationError);
  });

  it("rejects noncanonical target IDs", () => {
    configureBoundLab();
    const config = loadConfig();
    expect(() => assertLabProjectTarget(config, { projectId: "0123" }, liveInventory())).toThrow(
      ConfigurationError,
    );
    expect(() => assertLabPageTarget(config, { projectId: "123", pageId: "*" }, liveInventory())).toThrow(
      ConfigurationError,
    );
  });

  it("blocks page-scoped writes when page targets are unspecified", () => {
    configureBoundLab();
    process.env.LAB_PAGE_TARGETS = "UNSPECIFIED";
    const config = loadConfig();
    expect(() => assertLabPageTarget(config, { projectId: "123", pageId: "9001" }, liveInventory())).toThrow(
      /LAB_PAGE_TARGETS is UNSPECIFIED/,
    );
  });

  it("admits an existing record only from its exact local triple", () => {
    configureBoundLab();
    process.env.LAB_RECORD_TARGETS = "123:9001:8000";
    const config = loadConfig();

    expect(() => assertLabRecordTarget(
      config,
      { projectId: "123", pageId: "9001", recordId: "8000" },
      liveInventory(),
    )).not.toThrow();
    expect(() => assertLabRecordTarget(
      config,
      { projectId: "123", pageId: "9001", recordId: "8001" },
      liveInventory(),
    )).toThrow(/not in LAB_RECORD_TARGETS/);
    expect(() => assertLabRecordTarget(
      config,
      { projectId: "456", pageId: "9002", recordId: "8000" },
      liveInventory(),
    )).toThrow(/not in LAB_RECORD_TARGETS/);
  });

  it("rejects element-bearing and otherwise non-exact runtime record targets", () => {
    configureBoundLab();
    process.env.LAB_RECORD_TARGETS = "123:9001:8000";
    const config = loadConfig();
    const elementBearing = {
      projectId: "123",
      pageId: "9001",
      recordId: "8000",
      elementId: "tn-9",
    };
    expect(() => assertLabRecordTarget(
      config,
      elementBearing as never,
      liveInventory(),
    )).toThrow(/must contain exactly projectId, pageId, and recordId/);

    const inheritedElement = Object.create({ elementId: "tn-9" }) as {
      projectId: string;
      pageId: string;
      recordId: string;
    };
    inheritedElement.projectId = "123";
    inheritedElement.pageId = "9001";
    inheritedElement.recordId = "8000";
    expect(() => assertLabRecordTarget(config, inheritedElement, liveInventory())).toThrow(
      /extra or inherited target fields are forbidden/,
    );
  });

  it.each([
    ["record wildcard", "123:9001:*"],
    ["record leading zero", "123:9001:08000"],
    ["record missing segment", "123:9001"],
    ["duplicate record", "123:9001:8000,123:9001:8000"],
  ])("rejects non-exact LAB_RECORD_TARGETS: %s", (_label, value) => {
    configureBoundLab();
    process.env.LAB_RECORD_TARGETS = value;
    expect(() => loadConfig()).toThrow(ConfigurationError);
  });

  it("rejects stale or fabricated live account and inventory bindings", () => {
    configureBoundLab();
    const config = loadConfig();

    expect(() => assertLabProjectTarget(
      config,
      { projectId: "123" },
      liveInventory({ accountFingerprint: "different-account" }),
    )).toThrow(/does not match/);
    const changedOwnership = liveInventory({
      pageOwnership: {
        ...liveInventory().pageOwnership,
        "123": ["9001", "9003"],
      },
    });
    expect(() => assertLabProjectTarget(
      config,
      { projectId: "123" },
      changedOwnership,
    )).toThrow(/does not match/);
  });

  it("rejects incomplete source-corpus coverage and unproven page ownership", () => {
    const baseline = liveInventory();
    const expandedInventory = liveInventory({
      projectIds: [...baseline.projectIds, "777"],
      pageOwnership: { ...baseline.pageOwnership, "777": [] },
    });
    configureBoundLab(expandedInventory);
    const config = loadConfig();

    expect(() => assertLabProjectTarget(
      config,
      { projectId: "123" },
      expandedInventory,
    )).toThrow(/not classified read-only or lab: 777/);
    const wrongOwnership = liveInventory({
      pageOwnership: { ...baseline.pageOwnership, "123": ["9003"] },
    });
    process.env.TILDA_INVENTORY_HASH = hashLiveInventory(wrongOwnership);
    const ownershipConfig = loadConfig();
    expect(() => assertLabPageTarget(
      ownershipConfig,
      { projectId: "123", pageId: "9001" },
      wrongOwnership,
    )).toThrow(/does not bind page 9001 to project 123/);
  });

  it("requires a complete project/page ownership inventory and present lab projects", () => {
    configureBoundLab();
    const missingOwnership = liveInventory({
      pageOwnership: { "123": ["9001"], "456": ["9002"] },
    });
    expect(() => hashLiveInventory(missingOwnership)).toThrow(/one entry for every current project/);

    const baseline = liveInventory();
    const missingLab = liveInventory({
      projectIds: baseline.projectIds.filter((projectId) => projectId !== "456"),
      pageOwnership: Object.fromEntries(
        Object.entries(baseline.pageOwnership).filter(([projectId]) => projectId !== "456"),
      ),
    });
    process.env.TILDA_INVENTORY_HASH = hashLiveInventory(missingLab);
    const config = loadConfig();
    expect(() => assertLabProjectTarget(config, { projectId: "123" }, missingLab)).toThrow(
      /Configured lab projects are absent.*456/,
    );
  });

  it("ships no private source-corpus identifiers", () => {
    expect(KNOWN_READ_ONLY_SOURCE_PROJECT_IDS).toEqual([]);
  });

  it("requires every page ID to have exactly one project owner", () => {
    const baseline = liveInventory();
    const duplicateOwnership = liveInventory({
      pageOwnership: { ...baseline.pageOwnership, "999": ["9001"] },
    });
    expect(() => hashLiveInventory(duplicateOwnership)).toThrow(
      /page 9001 is claimed by multiple projects: 123, 999/,
    );
  });

  it("requires a canonical HMAC fingerprint", () => {
    process.env.TILDA_ACCOUNT_FINGERPRINT = "account-fingerprint-v1";
    expect(() => loadConfig()).toThrow(/lowercase HMAC-SHA-256/);
  });

  it("keeps the binding key and state inside ignored .tilda-runtime", () => {
    process.env.TILDA_BINDING_KEY_PATH = "binding.key";
    expect(() => loadConfig()).toThrow(/direct child of ignored \.tilda-runtime/);

    process.env.TILDA_BINDING_KEY_PATH = ".tilda-runtime/unit-test-binding.key";
    process.env.TILDA_BINDING_STATE_PATH = "../binding.json";
    expect(() => loadConfig()).toThrow(/direct child of ignored \.tilda-runtime/);

    process.env.TILDA_BINDING_STATE_PATH = ".tilda-runtime/unit-test-binding.key";
    expect(() => loadConfig()).toThrow(/must be different files/);
  });

  it("accepts only a loopback CDP endpoint", () => {
    process.env.TILDA_CDP_URL = "https://example.com:9222";
    expect(() => loadConfig()).toThrow(/loopback HTTP endpoint/);

    process.env.TILDA_CDP_URL = "http://127.0.0.1:9222";
    expect(loadConfig().cdpUrl).toBe("http://127.0.0.1:9222");
  });

  it("does not consider a partial official API credential pair configured", () => {
    process.env.TILDA_PUBLIC_KEY = "public-only";
    const config = loadConfig();
    expect(config.officialApiConfigured).toBe(false);
  });
});
