import type { ResearchConfig } from "../research/config.js";
import {
  loopbackTargetDiscoveryProvider,
  type TargetDiscoveryProvider,
} from "../research/target-discovery.js";
import type { TildaMcpResult } from "./protocol.js";

export type TargetDiscoveryQuery =
  | { readonly kind: "inventory" }
  | { readonly kind: "page_inventory"; readonly projectId: string };

export function isTargetDiscoveryQuery(
  query: { readonly kind: string },
): query is TargetDiscoveryQuery {
  return query.kind === "inventory" || query.kind === "page_inventory";
}

/**
 * Read-only target discovery. It deliberately runs before exact task
 * authorization and never creates, replaces, or widens a task grant.
 */
export async function executeTargetDiscoveryQuery(
  config: ResearchConfig,
  query: TargetDiscoveryQuery,
  provider: TargetDiscoveryProvider = loopbackTargetDiscoveryProvider,
): Promise<TildaMcpResult> {
  if (query.kind === "inventory") {
    const inventory = await provider.inventoryProjects(config);
    return {
      ok: true,
      code: "TARGETS_DISCOVERED",
      summary: "Discovered bounded project identities for target selection only; no task authority was minted.",
      stateChanged: false,
      target: null,
      capability: "target.discovery.read",
      adapter: "browser-target-discovery-v1",
      snapshotId: null,
      changeSetId: null,
      verification: {
        discoveryOnly: true,
        authorityMinted: false,
        capturedAt: inventory.capturedAt,
        projects: inventory.projects,
        projectCount: inventory.projects.length,
        warnings: inventory.warnings,
        privacy: inventory.privacy,
      },
      diagnosticsRef: null,
    };
  }

  const inventory = await provider.inventoryProjectPages(config, query.projectId);
  return {
    ok: true,
    code: "PAGES_DISCOVERED",
    summary: "Discovered bounded page identities for target selection only; no task authority was minted.",
    stateChanged: false,
    target: { kind: "project", projectId: query.projectId },
    capability: "target.discovery.read",
    adapter: "browser-target-discovery-v1",
    snapshotId: null,
    changeSetId: null,
    verification: {
      discoveryOnly: true,
      authorityMinted: false,
      capturedAt: inventory.capturedAt,
      projectId: inventory.projectId,
      pages: inventory.pages,
      pageCount: inventory.pages.length,
      warnings: inventory.warnings,
      privacy: inventory.privacy,
    },
    diagnosticsRef: null,
  };
}
