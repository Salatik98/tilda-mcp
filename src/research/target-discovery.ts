import {
  CdpConnection,
  listCdpTargets,
  selectTildaProjectsTarget,
} from "./cdp-client.js";
import type { ResearchConfig } from "./config.js";
import {
  inventoryProjects,
  type AccountInventory,
  type ProjectInventoryItem,
} from "./inventory.js";

const CANONICAL_ID = /^[1-9][0-9]*$/u;
const MAX_PROJECTS = 256;
const MAX_PAGES = 512;
const MAX_TITLE_CODE_POINTS = 160;
const PROBE_TIMEOUT_MS = 10_000;

export const TARGET_DISCOVERY_LIMITS = Object.freeze({
  projects: MAX_PROJECTS,
  pagesPerProject: MAX_PAGES,
  titleCodePoints: MAX_TITLE_CODE_POINTS,
});

export interface PageDiscoveryItem {
  readonly id: string;
  readonly title: string | null;
  /** Same-origin, canonical editor route only; never a caller-controlled URL. */
  readonly hrefPath: string;
  readonly source: "dom";
}

export interface ProjectPageInventory {
  readonly status: "INVENTORIED";
  readonly capturedAt: string;
  readonly source: "authorized_editor_dom";
  readonly route: "/projects/";
  readonly projectId: string;
  readonly pages: readonly PageDiscoveryItem[];
  readonly warnings: readonly string[];
  readonly privacy: {
    readonly containsSecrets: false;
    readonly containsLeadsOrdersOrCustomerPii: false;
    readonly pageContentRead: false;
    readonly browserStatePersisted: false;
  };
}

export interface TargetDiscoveryProvider {
  inventoryProjects(config: ResearchConfig): Promise<AccountInventory>;
  inventoryProjectPages(config: ResearchConfig, projectId: string): Promise<ProjectPageInventory>;
}

export class TargetDiscoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TargetDiscoveryError";
  }
}

export interface ProjectPageDiscoveryProbe {
  readonly host: string;
  readonly route: string;
  readonly href: string;
  readonly authenticated: boolean;
  readonly uiReady: boolean;
  readonly projectId: string | null;
  readonly pages: readonly PageDiscoveryItem[];
  readonly pageCardCount: number;
  readonly expectedPageCount: number | null;
  readonly paginationDetected: boolean;
  readonly failures: readonly string[];
}

const PROJECT_PAGE_DISCOVERY_PROBE = String.raw`(() => {
  const canonicalId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : null;
  };
  const parsedUrl = (value) => {
    try { return new URL(value, location.href); } catch { return null; }
  };
  const cleanTitle = (value) => {
    const normalized = String(value == null ? '' : value)
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized ? Array.from(normalized).slice(0, 160).join('') : null;
  };
  const current = new URL(location.href);
  const projectId = canonicalId(current.searchParams.get('projectid') || current.searchParams.get('projectId'));
  const authenticated = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    const url = parsedUrl(anchor.getAttribute('href'));
    return url && url.origin === location.origin && url.pathname === '/login/exit/';
  });
  const pages = [];
  const failures = [];
  const seen = new Set();
  const cards = Array.from(document.querySelectorAll('.td-page[id^="page"]'));
  for (const card of cards) {
    const cardId = canonicalId(String(card.id || '').replace(/^page/, ''));
    const matchingLinks = [];
    for (const anchor of card.querySelectorAll('a[href]')) {
      const url = parsedUrl(anchor.getAttribute('href'));
      if (!url || url.origin !== location.origin || url.pathname !== '/page/') continue;
      const pageId = canonicalId(url.searchParams.get('pageid') || url.searchParams.get('pageId'));
      const owner = canonicalId(url.searchParams.get('projectid') || url.searchParams.get('projectId'));
      if (pageId && (!owner || owner === projectId)) matchingLinks.push({ anchor, pageId });
    }
    const linkedIds = new Set(matchingLinks.map((entry) => entry.pageId));
    if (!cardId || linkedIds.size !== 1 || !linkedIds.has(cardId) || seen.has(cardId)) {
      failures.push('PAGE_CARD_IDENTITY_AMBIGUOUS');
      continue;
    }
    seen.add(cardId);
    const titleNode = card.querySelector(
      '[data-page-title], .td-page__name, .td-page__title, .td-page__info__title, [class*="page-title" i]'
    );
    const title = cleanTitle(
      card.getAttribute('data-page-title') ||
      (titleNode && (titleNode.getAttribute('data-page-title') || titleNode.getAttribute('title') || titleNode.textContent)) ||
      matchingLinks.map((entry) => entry.anchor.getAttribute('title')).find(Boolean) ||
      ''
    );
    const hrefPath = '/page/?pageid=' + encodeURIComponent(cardId) + '&projectid=' + encodeURIComponent(projectId || '');
    pages.push({ id: cardId, title, hrefPath, source: 'dom' });
  }
  const expectedCounts = new Set();
  for (const element of document.querySelectorAll('.td-plan__text')) {
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    const usedIndex = Math.max(text.toLocaleLowerCase('ru').lastIndexOf('использовано'), text.toLocaleLowerCase('en').lastIndexOf('used'));
    if (usedIndex < 0) continue;
    const used = text.slice(usedIndex);
    const match = used.match(/страниц(?:ы|а)?\s*[—–\-:]\s*(\d+)/i) || used.match(/pages?\s*[—–\-:]\s*(\d+)/i);
    if (match && match[1] !== undefined) expectedCounts.add(Number(match[1]));
  }
  const paginationDetected = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    if ((anchor.getAttribute('rel') || '').split(/\s+/).includes('next')) return true;
    const url = parsedUrl(anchor.getAttribute('href'));
    if (!url || url.origin !== location.origin || url.pathname !== '/projects/') return false;
    const owner = canonicalId(url.searchParams.get('projectid') || url.searchParams.get('projectId'));
    if (owner !== projectId) return false;
    return ['offset', 'p', 'page', 'pagenum', 'start'].some((key) => url.searchParams.has(key));
  });
  return {
    host: location.hostname,
    route: location.pathname,
    href: location.href,
    authenticated,
    uiReady: document.readyState === 'complete' && Boolean(
      document.querySelector('.td-page[id^="page"], .td-plan__text, input[type="password"]') || /\/login|\/signin/i.test(location.pathname)
    ),
    projectId,
    pages: pages.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)),
    pageCardCount: cards.length,
    expectedPageCount: expectedCounts.size === 1 ? Array.from(expectedCounts)[0] : null,
    paginationDetected,
    failures
  };
})()`;

const ROOT_READY_PROBE = String.raw`(() => ({
  host: location.hostname,
  route: location.pathname,
  href: location.href,
  ready: document.readyState === 'complete'
}))()`;

function cleanTitle(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized === ""
    ? null
    : Array.from(normalized).slice(0, MAX_TITLE_CODE_POINTS).join("");
}

function compareCanonicalIds(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function exactProjectRoute(probe: ProjectPageDiscoveryProbe, projectId: string): boolean {
  try {
    const url = new URL(probe.href);
    return probe.host === "tilda.ru" &&
      probe.route === "/projects/" &&
      url.protocol === "https:" &&
      url.hostname === "tilda.ru" &&
      url.pathname === "/projects/" &&
      (url.searchParams.get("projectid") ?? url.searchParams.get("projectId")) === projectId &&
      probe.projectId === projectId;
  } catch {
    return false;
  }
}

export function validateProjectInventoryForDiscovery(inventory: AccountInventory): AccountInventory {
  if (inventory.route !== "/projects/") {
    throw new TargetDiscoveryError(
      "DISCOVERY_ROUTE_REJECTED",
      "Project discovery requires the exact top-level Tilda projects route.",
    );
  }
  if (inventory.projects.length > MAX_PROJECTS) {
    throw new TargetDiscoveryError(
      "DISCOVERY_LIMIT_EXCEEDED",
      `Project discovery is bounded to ${MAX_PROJECTS} projects.`,
    );
  }
  const seen = new Set<string>();
  const projects: ProjectInventoryItem[] = inventory.projects.map((project) => {
    if (!CANONICAL_ID.test(project.id) || seen.has(project.id)) {
      throw new TargetDiscoveryError(
        "DISCOVERY_IDENTITY_AMBIGUOUS",
        "Project discovery returned a missing, duplicate, or non-canonical project identity.",
      );
    }
    seen.add(project.id);
    return {
      id: project.id,
      title: cleanTitle(project.title),
      hrefPath: `/projects/?projectid=${project.id}`,
      source: "dom",
    };
  });
  projects.sort((left, right) => compareCanonicalIds(left.id, right.id));
  return { ...inventory, projects };
}

export function deriveProjectPageInventory(
  probe: ProjectPageDiscoveryProbe,
  projectId: string,
  capturedAt = new Date().toISOString(),
): ProjectPageInventory {
  if (!CANONICAL_ID.test(projectId)) {
    throw new TargetDiscoveryError(
      "DISCOVERY_TARGET_INVALID",
      "Page discovery requires one canonical project ID.",
    );
  }
  if (!exactProjectRoute(probe, projectId)) {
    throw new TargetDiscoveryError(
      "DISCOVERY_ROUTE_REJECTED",
      "Page discovery did not remain on the exact same-origin project route.",
    );
  }
  if (!probe.authenticated) {
    throw new TargetDiscoveryError(
      "AUTHENTICATION_REQUIRED",
      "Page discovery requires the authenticated Tilda project UI.",
    );
  }
  if (!probe.uiReady) {
    throw new TargetDiscoveryError("DISCOVERY_UI_NOT_READY", "The project page list is not ready.");
  }
  if (probe.paginationDetected) {
    throw new TargetDiscoveryError(
      "DISCOVERY_PAGINATION_UNSUPPORTED",
      "Page discovery refuses a partial paginated project inventory.",
    );
  }
  if (probe.pages.length > MAX_PAGES || probe.pageCardCount > MAX_PAGES) {
    throw new TargetDiscoveryError(
      "DISCOVERY_LIMIT_EXCEEDED",
      `Page discovery is bounded to ${MAX_PAGES} pages per project.`,
    );
  }
  if (
    probe.failures.length > 0 ||
    probe.pageCardCount !== probe.pages.length ||
    (probe.expectedPageCount !== null && probe.expectedPageCount !== probe.pages.length)
  ) {
    throw new TargetDiscoveryError(
      "DISCOVERY_IDENTITY_AMBIGUOUS",
      "Page cards, page identities, or the rendered page count did not match exactly.",
    );
  }
  const seen = new Set<string>();
  const pages = probe.pages.map((page) => {
    if (!CANONICAL_ID.test(page.id) || seen.has(page.id)) {
      throw new TargetDiscoveryError(
        "DISCOVERY_IDENTITY_AMBIGUOUS",
        "Page discovery returned a duplicate or non-canonical page identity.",
      );
    }
    seen.add(page.id);
    return Object.freeze({
      id: page.id,
      title: cleanTitle(page.title),
      hrefPath: `/page/?pageid=${page.id}&projectid=${projectId}`,
      source: "dom" as const,
    });
  }).sort((left, right) => compareCanonicalIds(left.id, right.id));
  return Object.freeze({
    status: "INVENTORIED",
    capturedAt,
    source: "authorized_editor_dom",
    route: "/projects/",
    projectId,
    pages: Object.freeze(pages),
    warnings: Object.freeze(pages.filter((page) => page.title === null).length === 0
      ? []
      : ["Some page titles were absent from the rendered project cards."]),
    privacy: Object.freeze({
      containsSecrets: false,
      containsLeadsOrdersOrCustomerPii: false,
      pageContentRead: false,
      browserStatePersisted: false,
    }),
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProjectProbe(
  connection: CdpConnection,
  projectId: string,
): Promise<ProjectPageDiscoveryProbe> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  let last: ProjectPageDiscoveryProbe | null = null;
  while (Date.now() < deadline) {
    try {
      last = await connection.evaluate<ProjectPageDiscoveryProbe>(PROJECT_PAGE_DISCOVERY_PROBE);
      if (last.uiReady && exactProjectRoute(last, projectId)) return last;
    } catch {
      // A navigation may briefly invalidate the execution context; retry only this read.
    }
    await delay(125);
  }
  throw new TargetDiscoveryError(
    "DISCOVERY_UI_NOT_READY",
    `Timed out waiting for the exact rendered project page list (last route ${last?.route ?? "unknown"}).`,
  );
}

async function restoreRoot(connection: CdpConnection): Promise<void> {
  const rootUrl = "https://tilda.ru/projects/";
  const navigation = await connection.send<{ errorText?: string }>("Page.navigate", { url: rootUrl });
  if (navigation.errorText) {
    throw new TargetDiscoveryError(
      "DISCOVERY_ROOT_RESTORE_FAILED",
      "Could not restore the dedicated Tilda tab to the projects root.",
    );
  }
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const probe = await connection.evaluate<{
        host: string;
        route: string;
        href: string;
        ready: boolean;
      }>(ROOT_READY_PROBE);
      const url = new URL(probe.href);
      if (
        probe.ready &&
        probe.host === "tilda.ru" &&
        probe.route === "/projects/" &&
        url.origin === "https://tilda.ru" &&
        url.pathname === "/projects/" &&
        url.search === ""
      ) return;
    } catch {
      // Same bounded navigation read retry as above.
    }
    await delay(125);
  }
  throw new TargetDiscoveryError(
    "DISCOVERY_ROOT_RESTORE_FAILED",
    "Timed out restoring the dedicated Tilda tab to the projects root.",
  );
}

export async function inventoryProjectPages(
  config: ResearchConfig,
  projectId: string,
): Promise<ProjectPageInventory> {
  if (!CANONICAL_ID.test(projectId)) {
    throw new TargetDiscoveryError(
      "DISCOVERY_TARGET_INVALID",
      "Page discovery requires one canonical project ID.",
    );
  }
  const targets = await listCdpTargets(config.cdpUrl);
  const target = selectTildaProjectsTarget(targets);
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new TargetDiscoveryError(
      "PROJECTS_TARGET_NOT_FOUND",
      "Open the authenticated top-level https://tilda.ru/projects/ route in the dedicated browser.",
    );
  }
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
  let result: ProjectPageInventory | null = null;
  let operationError: unknown = null;
  try {
    await connection.send("Page.enable");
    const route = new URL("https://tilda.ru/projects/");
    route.searchParams.set("projectid", projectId);
    const navigation = await connection.send<{ errorText?: string }>("Page.navigate", { url: route.href });
    if (navigation.errorText) {
      throw new TargetDiscoveryError(
        "DISCOVERY_NAVIGATION_FAILED",
        "Could not open the exact read-only Tilda project route.",
      );
    }
    result = deriveProjectPageInventory(await waitForProjectProbe(connection, projectId), projectId);
  } catch (error) {
    operationError = error;
  }
  try {
    await restoreRoot(connection);
  } catch (restoreError) {
    connection.close();
    throw restoreError;
  }
  connection.close();
  if (operationError !== null) throw operationError;
  if (result === null) {
    throw new TargetDiscoveryError("DISCOVERY_FAILED", "Page discovery produced no result.");
  }
  return result;
}

export async function inventoryProjectsForDiscovery(
  config: ResearchConfig,
): Promise<AccountInventory> {
  return validateProjectInventoryForDiscovery(await inventoryProjects(config));
}

export const loopbackTargetDiscoveryProvider: TargetDiscoveryProvider = Object.freeze({
  inventoryProjects: inventoryProjectsForDiscovery,
  inventoryProjectPages,
});
