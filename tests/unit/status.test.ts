import { describe, expect, it } from "vitest";
import {
  hashLiveInventory,
  type LiveInventory,
  type ResearchConfig,
} from "../../src/research/config.js";
import type { TrustedBindingEstablished } from "../../src/research/inventory.js";
import { buildSafetyStatus } from "../../src/research/status.js";

function config(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    cdpUrl: "http://127.0.0.1:9222",
    bindingKeyPath: ".tilda-runtime/test-binding.key",
    bindingStatePath: ".tilda-runtime/test-binding.json",
    observatoryHost: "127.0.0.1",
    observatoryPort: 4765,
    accountFingerprint: "b".repeat(64),
    inventoryHash: "a".repeat(64),
    labProjectIds: ["123"],
    readOnlyProjectIds: ["999", "10001", "10002", "10003", "10004", "10005"],
    labPageTargets: [{ projectId: "123", pageId: "9001" }],
    labRecordTargets: null,
    publicTestDomains: null,
    officialApiConfigured: false,
    ...overrides,
  };
}

function liveInventory(): LiveInventory {
  return {
    accountFingerprint: "b".repeat(64),
    projectIds: ["123", "999", "10001", "10002", "10003", "10004", "10005"],
    pageOwnership: {
      "123": ["9001"],
      "999": [],
      "10001": [],
      "10002": [],
      "10003": [],
      "10004": [],
      "10005": [],
    },
  };
}

function boundConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  const inventory = liveInventory();
  return config({
    accountFingerprint: inventory.accountFingerprint,
    inventoryHash: hashLiveInventory(inventory),
    ...overrides,
  });
}

describe("status safety", () => {
  it("never emits a global unblocked signal before live account/inventory matching exists", () => {
    expect(buildSafetyStatus(config())).toMatchObject({
      projectAllowlistSyntacticallyValid: true,
      writesBlocked: true,
      pageWritesBlocked: true,
    });
  });

  it("stays blocked when page targets or account binding are absent", () => {
    expect(buildSafetyStatus(config({ labPageTargets: null }))).toMatchObject({
      labPageTargetsConfigured: false,
      writesBlocked: true,
      pageWritesBlocked: true,
    });
    expect(buildSafetyStatus(config({ accountFingerprint: null }))).toMatchObject({
      allowlistBoundToInventory: false,
      projectAllowlistSyntacticallyValid: false,
      writesBlocked: true,
    });
  });

  it("does not treat a caller-fabricated matching inventory as reusable write authorization", () => {
    const inventory = liveInventory();
    const fabricated: TrustedBindingEstablished = {
      status: "BOUND",
      capturedAt: new Date().toISOString(),
      source: "trusted_same_session_cdp",
      route: "/projects/",
      accountFingerprint: inventory.accountFingerprint,
      inventoryHash: hashLiveInventory(inventory),
      inventory,
      projectCount: inventory.projectIds.length,
      pageCount: 1,
      captureContext: {
        cdpTargetId: "fabricated-target",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      privacy: {
        rawAccountIdPersisted: false,
        titlesOrContentPersisted: false,
        cookiesOrSessionDataPersisted: false,
      },
    };

    expect(buildSafetyStatus(boundConfig(), fabricated)).toMatchObject({
      liveInventoryCaptured: false,
      allowlistBoundToInventory: false,
      writesBlocked: true,
      pageWritesBlocked: true,
      writePreflightWouldPass: false,
      pageWritePreflightWouldPass: false,
      requiresFreshWriteTimeCapture: true,
      writeAuthorizationReusable: false,
    });
  });
});
