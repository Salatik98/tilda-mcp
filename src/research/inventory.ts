import { CdpConnection, listCdpTargets, selectTildaTarget } from "./cdp-client.js";
import type { ResearchConfig } from "./config.js";

export interface ProjectInventoryItem {
  id: string;
  title: string | null;
  hrefPath: string | null;
  source: "dom";
}

export interface AccountInventory {
  status: "INVENTORIED";
  capturedAt: string;
  source: "authorized_editor_dom";
  route: string;
  projects: ProjectInventoryItem[];
  warnings: string[];
  privacy: {
    containsSecrets: false;
    containsLeadsOrdersOrCustomerPii: false;
  };
}

const INVENTORY_PROBE = String.raw`(() => {
  const result = new Map();
  const cleanText = (value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, 240) : null;
  };
  const add = (id, title, hrefPath) => {
    if (!id || !/^\d+$/.test(String(id))) return;
    const key = String(id);
    const existing = result.get(key);
    const candidate = { id: key, title: cleanText(title), hrefPath: hrefPath || null, source: "dom" };
    if (!existing || (!existing.title && candidate.title)) result.set(key, candidate);
  };

  for (const element of document.querySelectorAll('[data-project-id]')) {
    const id = element.getAttribute('data-project-id');
    const anchor = element.closest('a[href]') || element.querySelector('a[href]');
    let path = null;
    if (anchor) {
      try { path = new URL(anchor.href, location.href).pathname; } catch {}
    }
    add(id, element.getAttribute('data-project-title') || element.textContent, path);
  }

  for (const anchor of document.querySelectorAll('a[href]')) {
    let parsed;
    try { parsed = new URL(anchor.href, location.href); } catch { continue; }
    let id = parsed.searchParams.get('projectid') || parsed.searchParams.get('projectId');
    if (!id) {
      const match = parsed.pathname.match(/\/(?:project|projects)\/(\d+)(?:\/|$)/i);
      id = match ? match[1] : null;
    }
    if (!id) continue;
    const card = anchor.closest('[data-project-id], [class*="project" i]');
    add(id, anchor.getAttribute('data-project-title') || anchor.textContent || (card && card.textContent), parsed.pathname);
  }

  return {
    route: location.pathname,
    projects: Array.from(result.values()).sort((a, b) => Number(a.id) - Number(b.id))
  };
})()`;

export async function inventoryProjects(config: ResearchConfig): Promise<AccountInventory> {
  const targets = await listCdpTargets(config.cdpUrl);
  const target = selectTildaTarget(targets);
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error("No Tilda page is open in the dedicated CDP browser.");
  }

  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
  try {
    const result = await connection.evaluate<{
      route: string;
      projects: ProjectInventoryItem[];
    }>(INVENTORY_PROBE);
    const warnings: string[] = [];
    if (result.projects.length === 0) {
      warnings.push(
        "No project identities were discoverable in the current DOM. Confirm authentication and the projects route.",
      );
    }

    return {
      status: "INVENTORIED",
      capturedAt: new Date().toISOString(),
      source: "authorized_editor_dom",
      route: result.route,
      projects: result.projects,
      warnings,
      privacy: {
        containsSecrets: false,
        containsLeadsOrdersOrCustomerPii: false,
      },
    };
  } finally {
    connection.close();
  }
}
