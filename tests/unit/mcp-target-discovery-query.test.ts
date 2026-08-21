import { describe, expect, it, vi } from "vitest";
import type { ResearchConfig } from "../../src/research/config.js";
import type { TargetDiscoveryProvider } from "../../src/research/target-discovery.js";
import {
  executeTargetDiscoveryQuery,
  isTargetDiscoveryQuery,
} from "../../src/mcp/target-discovery-query.js";

const config = {} as ResearchConfig;

function provider(): TargetDiscoveryProvider {
  return {
    inventoryProjects: vi.fn(async () => ({
      status: "INVENTORIED" as const,
      capturedAt: "2026-08-20T04:00:00.000Z",
      source: "authorized_editor_dom" as const,
      route: "/projects/",
      projects: [
        { id: "22", title: "Main", hrefPath: "/projects/?projectid=22", source: "dom" as const },
      ],
      warnings: [],
      privacy: {
        containsSecrets: false as const,
        containsLeadsOrdersOrCustomerPii: false as const,
      },
    })),
    inventoryProjectPages: vi.fn(async (_config: ResearchConfig, projectId: string) => ({
      status: "INVENTORIED" as const,
      capturedAt: "2026-08-20T04:00:00.000Z",
      source: "authorized_editor_dom" as const,
      route: "/projects/" as const,
      projectId,
      pages: [
        {
          id: "901",
          title: "Landing",
          hrefPath: "/page/?pageid=901&projectid=22",
          source: "dom" as const,
        },
      ],
      warnings: [],
      privacy: {
        containsSecrets: false as const,
        containsLeadsOrdersOrCustomerPii: false as const,
        pageContentRead: false as const,
        browserStatePersisted: false as const,
      },
    })),
  };
}

describe("MCP target discovery query", () => {
  it("returns projects as discovery-only data without authority or state changes", async () => {
    const discovery = provider();
    const result = await executeTargetDiscoveryQuery(config, { kind: "inventory" }, discovery);

    expect(result).toMatchObject({
      ok: true,
      code: "TARGETS_DISCOVERED",
      stateChanged: false,
      target: null,
      capability: "target.discovery.read",
      verification: {
        discoveryOnly: true,
        authorityMinted: false,
        projectCount: 1,
        projects: [{ id: "22", title: "Main" }],
      },
    });
    expect(discovery.inventoryProjects).toHaveBeenCalledOnce();
    expect(discovery.inventoryProjectPages).not.toHaveBeenCalled();
  });

  it("returns pages under one canonical project target and no write grant", async () => {
    const discovery = provider();
    const result = await executeTargetDiscoveryQuery(
      config,
      { kind: "page_inventory", projectId: "22" },
      discovery,
    );

    expect(result).toMatchObject({
      ok: true,
      code: "PAGES_DISCOVERED",
      stateChanged: false,
      target: { kind: "project", projectId: "22" },
      verification: {
        discoveryOnly: true,
        authorityMinted: false,
        pageCount: 1,
        pages: [{ id: "901", title: "Landing" }],
      },
    });
    expect(discovery.inventoryProjectPages).toHaveBeenCalledWith(config, "22");
  });

  it("recognizes only the two compact discovery query kinds", () => {
    expect(isTargetDiscoveryQuery({ kind: "inventory" })).toBe(true);
    expect(isTargetDiscoveryQuery({ kind: "page_inventory" })).toBe(true);
    expect(isTargetDiscoveryQuery({ kind: "page" })).toBe(false);
  });
});
