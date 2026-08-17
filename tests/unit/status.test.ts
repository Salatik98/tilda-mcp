import { describe, expect, it } from "vitest";
import type { ResearchConfig } from "../../src/research/config.js";
import { buildSafetyStatus } from "../../src/research/status.js";

function config(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    cdpUrl: "http://127.0.0.1:9222",
    observatoryHost: "127.0.0.1",
    observatoryPort: 4765,
    accountFingerprint: "b".repeat(64),
    inventoryHash: "a".repeat(64),
    labProjectIds: ["123"],
    readOnlyProjectIds: ["999", "1001", "1002"],
    labPageTargets: [{ projectId: "123", pageId: "9001" }],
    publicTestDomains: null,
    officialApiConfigured: false,
    ...overrides,
  };
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
});
