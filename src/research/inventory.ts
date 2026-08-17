import { createHmac, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CdpConnection,
  listCdpTargets,
  selectTildaProjectsTarget,
  type CdpTarget,
} from "./cdp-client.js";
import {
  createLoopbackCdpTrustedBrowserSession,
  type TrustedBrowserSession,
} from "./browser-session.js";
import {
  assertRuntimeBindingPath,
  hashLiveInventory,
  type LiveInventory,
  type ResearchConfig,
} from "./config.js";
import type {
  IdentityProbe,
  ProjectPagesProbe,
  ProjectsRootProbe,
  TrustedProbeProject,
} from "./probes.js";
import { connectExtensionStdioTrustedBrowserSession } from "./transports/extension-stdio.js";

export type { TrustedProbeProject } from "./probes.js";

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

export type TrustedBindingBlockCode =
  | "PROJECTS_TARGET_NOT_FOUND"
  | "BINDING_KEY_UNAVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "SAFE_ACCOUNT_ID_UNAVAILABLE"
  | "INVENTORY_ENUMERATION_FAILED"
  | "INCOMPLETE_PROJECT_INVENTORY"
  | "INCOMPLETE_PAGE_INVENTORY"
  | "AMBIGUOUS_PAGE_OWNERSHIP"
  | "INVALID_CAPTURE"
  | "CAPTURE_FAILED";

/** Raw values exist only in memory between CDP evaluation and HMAC derivation. */
export interface SameSessionInventoryProbe {
  host: string;
  route: string;
  authenticated: boolean;
  stableAccountIdentity: string | null;
  accountIdentitySource:
    | "identity_hidden_useruid"
    | "identity_global_username"
    | null;
  projectIds: string[];
  projectCardCount: number;
  expectedProjectCount: number | null;
  projectPaginationDetected: boolean;
  projects: TrustedProbeProject[];
  failures: Array<{ code: string; projectId?: string }>;
}

export interface TrustedBindingBlocked {
  status: "BLOCKED";
  code: TrustedBindingBlockCode;
  message: string;
}

export interface TrustedBindingEstablished {
  readonly status: "BOUND";
  readonly capturedAt: string;
  readonly source: "trusted_same_session_cdp";
  readonly route: "/projects/";
  readonly accountFingerprint: string;
  readonly inventoryHash: string;
  readonly inventory: LiveInventory;
  readonly projectCount: number;
  readonly pageCount: number;
  /** Capture provenance only. This object is never a reusable write ticket. */
  readonly captureContext: {
    readonly cdpTargetId: string | null;
    readonly expiresAt: string | null;
  };
  readonly privacy: {
    readonly rawAccountIdPersisted: false;
    readonly titlesOrContentPersisted: false;
    readonly cookiesOrSessionDataPersisted: false;
  };
}

export type TrustedBindingCapture = TrustedBindingBlocked | TrustedBindingEstablished;

export type TrustedCapturePhase =
  | "root"
  | "identity_pass_1"
  | "project_pass_1"
  | "identity_pass_2"
  | "project_pass_2"
  | "restore_root"
  | "derive";

export interface TrustedCaptureProgress {
  readonly phase: TrustedCapturePhase;
  readonly state: "started" | "completed";
  readonly elapsedMs: number;
  readonly projectOrdinal?: number;
  readonly projectCount?: number;
}

const activeTrustedCaptures = new WeakMap<
  object,
  { targetId: string; expiresAt: number }
>();

const INVENTORY_PROBE = String.raw`(() => {
  const result = new Map();
  const cleanText = (value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, 240) : null;
  };
  const add = (id, title, hrefPath) => {
    if (!id || !/^[1-9]\d*$/.test(String(id))) return;
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
    if (parsed.origin !== location.origin || parsed.pathname !== '/projects/') continue;
    const id = parsed.searchParams.get('projectid') || parsed.searchParams.get('projectId');
    if (!id) continue;
    const card = anchor.closest('[data-project-id], [class*="project" i]');
    add(id, anchor.getAttribute('data-project-title') || anchor.textContent || (card && card.textContent), parsed.pathname);
  }

  return {
    route: location.pathname,
    projects: Array.from(result.values()).sort((a, b) => Number(a.id) - Number(b.id))
  };
})()`;


const CANONICAL_ID = /^[1-9][0-9]*$/;
const BINDING_KEY_PREFIX = "tilda-agent-os-binding-key-v1:";
const ACCOUNT_FINGERPRINT_DOMAIN = "tilda-agent-os/account-fingerprint/v1\0";
const GLOBAL_USERNAME_FINGERPRINT_PREFIX = "identity_global_username\0";

function stableGlobalUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    Array.from(value).length <= 128 &&
    value === value.trim() &&
    value === value.normalize("NFC") &&
    !/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(value)
  );
}

function compareCanonicalIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : left < right ? -1 : 1;
}

function blocked(code: TrustedBindingBlockCode, message: string): TrustedBindingBlocked {
  return { status: "BLOCKED", code, message };
}

export function deriveTrustedBindingFromProbe(
  probe: SameSessionInventoryProbe,
  machineKey: Uint8Array,
  capturedAt = new Date().toISOString(),
): TrustedBindingCapture {
  if (probe.host !== "tilda.ru" || probe.route !== "/projects/") {
    return blocked("INVALID_CAPTURE", "Trusted capture must originate from https://tilda.ru/projects/.");
  }
  if (!probe.authenticated) {
    return blocked("AUTHENTICATION_REQUIRED", "The projects UI is not authenticated.");
  }
  if (probe.failures.length > 0) {
    return blocked(
      "INVENTORY_ENUMERATION_FAILED",
      `Same-session inventory reads failed (${probe.failures.map((failure) => failure.code).join(", ")}).`,
    );
  }
  const stableAccountIdentity = probe.stableAccountIdentity;
  if (
    typeof stableAccountIdentity !== "string" ||
    !(
      (probe.accountIdentitySource === "identity_hidden_useruid" &&
        CANONICAL_ID.test(stableAccountIdentity)) ||
      (probe.accountIdentitySource === "identity_global_username" &&
        stableGlobalUsername(stableAccountIdentity))
    )
  ) {
    return blocked(
      "SAFE_ACCOUNT_ID_UNAVAILABLE",
      "No stable non-content account identity was safely available; binding remains blocked.",
    );
  }

  const projectIds = [...probe.projectIds].sort(compareCanonicalIds);
  if (
    projectIds.length === 0 ||
    new Set(projectIds).size !== projectIds.length ||
    projectIds.some((id) => !CANONICAL_ID.test(id)) ||
    probe.projectPaginationDetected ||
    !Number.isSafeInteger(probe.projectCardCount) ||
    probe.projectCardCount !== projectIds.length ||
    probe.expectedProjectCount === null ||
    !Number.isSafeInteger(probe.expectedProjectCount) ||
    probe.expectedProjectCount !== projectIds.length
  ) {
    return blocked("INCOMPLETE_PROJECT_INVENTORY", "The current project enumeration is empty, duplicate, or noncanonical.");
  }
  const projectEntries = [...probe.projects].sort((left, right) =>
    compareCanonicalIds(left.id, right.id),
  );
  if (
    projectEntries.length !== projectIds.length ||
    projectEntries.some((project, index) => project.id !== projectIds[index])
  ) {
    return blocked(
      "INCOMPLETE_PROJECT_INVENTORY",
      "Every current project must have exactly one same-session page-inventory result.",
    );
  }

  const pageOwnership: Record<string, readonly string[]> = {};
  const pageOwners = new Map<string, string>();
  let pageCount = 0;
  for (const project of projectEntries) {
    if (!CANONICAL_ID.test(project.id) || project.paginationDetected) {
      return blocked(
        "INCOMPLETE_PAGE_INVENTORY",
        `Complete page enumeration could not be proven for project ${project.id}.`,
      );
    }
    const pageIds = [...project.pageIds].sort(compareCanonicalIds);
    if (
      new Set(pageIds).size !== pageIds.length ||
      pageIds.some((id) => !CANONICAL_ID.test(id)) ||
      !Number.isSafeInteger(project.pageCardCount) ||
      project.pageCardCount !== pageIds.length ||
      project.expectedPageCount === null ||
      !Number.isSafeInteger(project.expectedPageCount) ||
      project.expectedPageCount < 0 ||
      project.expectedPageCount !== pageIds.length
    ) {
      return blocked(
        "INCOMPLETE_PAGE_INVENTORY",
        `The observed page IDs do not match the UI page count for project ${project.id}.`,
      );
    }
    for (const pageId of pageIds) {
      const priorOwner = pageOwners.get(pageId);
      if (priorOwner !== undefined) {
        return blocked(
          "AMBIGUOUS_PAGE_OWNERSHIP",
          `Page ${pageId} is claimed by both project ${priorOwner} and ${project.id}.`,
        );
      }
      pageOwners.set(pageId, project.id);
    }
    pageOwnership[project.id] = Object.freeze(pageIds);
    pageCount += pageIds.length;
  }

  if (machineKey.byteLength !== 32) {
    return blocked("BINDING_KEY_UNAVAILABLE", "The local binding key is missing or invalid.");
  }
  const accountFingerprint = createHmac("sha256", machineKey)
    .update(ACCOUNT_FINGERPRINT_DOMAIN, "utf8")
    .update(
      probe.accountIdentitySource === "identity_global_username"
        ? GLOBAL_USERNAME_FINGERPRINT_PREFIX
        : "",
      "utf8",
    )
    .update(stableAccountIdentity, "utf8")
    .digest("hex");
  const inventory: LiveInventory = Object.freeze({
    accountFingerprint,
    projectIds: Object.freeze(projectIds),
    pageOwnership: Object.freeze(pageOwnership),
  });
  const inventoryHash = hashLiveInventory(inventory);

  return {
    status: "BOUND",
    capturedAt,
    source: "trusted_same_session_cdp",
    route: "/projects/",
    accountFingerprint,
    inventoryHash,
    inventory,
    projectCount: projectIds.length,
    pageCount,
    captureContext: {
      cdpTargetId: null,
      expiresAt: null,
    },
    privacy: {
      rawAccountIdPersisted: false,
      titlesOrContentPersisted: false,
      cookiesOrSessionDataPersisted: false,
    },
  };
}

function markTrustedCaptureForCurrentProcess(
  derived: TrustedBindingEstablished,
  targetId: string,
): TrustedBindingEstablished {
  const expiresAt = Date.now() + 30_000;
  const capture: TrustedBindingEstablished = Object.freeze({
    ...derived,
    captureContext: Object.freeze({
      cdpTargetId: targetId,
      expiresAt: new Date(expiresAt).toISOString(),
    }),
    privacy: Object.freeze({ ...derived.privacy }),
  });
  activeTrustedCaptures.set(capture, { targetId, expiresAt });
  return capture;
}

export function isFreshTrustedBindingCapture(
  capture: TrustedBindingCapture | null,
): capture is TrustedBindingEstablished {
  if (capture === null || capture.status !== "BOUND") return false;
  const state = activeTrustedCaptures.get(capture);
  return state !== undefined && Date.now() <= state.expiresAt;
}

function parseBindingKey(source: string): Uint8Array {
  const normalized = source.trim();
  if (!normalized.startsWith(BINDING_KEY_PREFIX)) {
    throw new Error("Local binding key has an unsupported format.");
  }
  const encoded = normalized.slice(BINDING_KEY_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(encoded)) {
    throw new Error("Local binding key has an unsupported format.");
  }
  return Buffer.from(encoded, "hex");
}

async function readOrCreateBindingKey(
  path: string,
  createIfMissing: boolean,
): Promise<Uint8Array | null> {
  path = assertRuntimeBindingPath(path, "TILDA_BINDING_KEY_PATH");
  const directory = dirname(path);
  try {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("Local .tilda-runtime must be a regular non-symlink directory.");
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : null;
    if (code !== "ENOENT") throw error;
    if (!createIfMissing) return null;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("Local .tilda-runtime must be a regular non-symlink directory.");
    }
  }

  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Local binding key must be a regular non-symlink file.");
    }
    return parseBindingKey(await readFile(path, "utf8"));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : null;
    if (code !== "ENOENT") throw error;
  }
  if (!createIfMissing) return null;

  const generated = randomBytes(32);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${BINDING_KEY_PREFIX}${generated.toString("hex")}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return generated;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : null;
    if (code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Local binding key must be a regular non-symlink file.");
    }
    return parseBindingKey(await readFile(path, "utf8"));
  }
}

export interface TrustedCaptureOptions {
  createBindingKey?: boolean;
  overallTimeoutMs?: number;
  onProgress?: (progress: TrustedCaptureProgress) => void;
}

export type TrustedBrowserSessionLifecycle = "capture_owned" | "caller_owned";

/**
 * Run the trusted two-pass binding protocol on a supplied session. The default
 * preserves the historical capture-owned lifecycle. A caller-owned session is
 * restored to its exact root but deliberately left open so an adapter-owned
 * authority can retain the same underlying browser connection.
 */
export async function captureTrustedLiveBindingWithSession(
  config: ResearchConfig,
  session: TrustedBrowserSession,
  options: TrustedCaptureOptions = {},
  lifecycle: TrustedBrowserSessionLifecycle = "capture_owned",
): Promise<TrustedBindingCapture> {
  if (lifecycle !== "capture_owned" && lifecycle !== "caller_owned") {
    throw new Error("Trusted browser session lifecycle is invalid.");
  }
  const startedAt = Date.now();
  const overallTimeoutMs = Math.max(
    12_000,
    Math.min(options.overallTimeoutMs ?? 90_000, 180_000),
  );
  const deadline = startedAt + overallTimeoutMs;
  let phase: TrustedCapturePhase = "root";
  const progress = (
    nextPhase: TrustedCapturePhase,
    state: "started" | "completed",
    projectOrdinal?: number,
    projectCount?: number,
  ): void => {
    phase = nextPhase;
    try {
      options.onProgress?.(
        Object.freeze({
          phase: nextPhase,
          state,
          elapsedMs: Date.now() - startedAt,
          ...(projectOrdinal === undefined ? {} : { projectOrdinal }),
          ...(projectCount === undefined ? {} : { projectCount }),
        }),
      );
    } catch {
      // Diagnostic observers cannot change the safety result.
    }
  };
  const remainingProbeTimeout = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Trusted capture exceeded its ${overallTimeoutMs}ms read-only deadline during ${phase}.`,
      );
    }
    return Math.min(12_000, remaining);
  };
  let rootProbe: ProjectsRootProbe | null = null;
  let identityProbe: IdentityProbe | null = null;
  let identityRecheck: IdentityProbe | null = null;
  const projectProbes: ProjectPagesProbe[] = [];
  const projectRechecks: ProjectPagesProbe[] = [];
  let captureError: unknown = null;
  let restoreError: unknown = null;
  try {
    progress("root", "started");
    rootProbe = await session.readRoot(remainingProbeTimeout());
    progress("root", "completed");
    if (rootProbe.host !== "tilda.ru" || rootProbe.route !== "/projects/") {
      return blocked(
        "INVALID_CAPTURE",
        "Trusted capture must start at the exact top-level Tilda projects route.",
      );
    }

    progress("identity_pass_1", "started");
    identityProbe = await session.readIdentity(remainingProbeTimeout());
    progress("identity_pass_1", "completed");
    for (let index = 0; index < rootProbe.projectIds.length; index += 1) {
      const projectId = rootProbe.projectIds[index]!;
      progress("project_pass_1", "started", index + 1, rootProbe.projectIds.length);
      projectProbes.push(
        await session.readProject(projectId, remainingProbeTimeout()),
      );
      progress("project_pass_1", "completed", index + 1, rootProbe.projectIds.length);
    }
    progress("identity_pass_2", "started");
    identityRecheck = await session.readIdentity(remainingProbeTimeout());
    progress("identity_pass_2", "completed");
    for (let index = 0; index < rootProbe.projectIds.length; index += 1) {
      const projectId = rootProbe.projectIds[index]!;
      progress("project_pass_2", "started", index + 1, rootProbe.projectIds.length);
      projectRechecks.push(
        await session.readProject(projectId, remainingProbeTimeout()),
      );
      progress("project_pass_2", "completed", index + 1, rootProbe.projectIds.length);
    }
  } catch (error) {
    captureError = error;
  } finally {
    try {
      progress("restore_root", "started");
      const restored = await session.restoreRoot(12_000);
      if (
        rootProbe !== null &&
        (restored.host !== rootProbe.host ||
          restored.route !== rootProbe.route ||
          restored.projectCardCount !== rootProbe.projectCardCount ||
          restored.projectIds.join(",") !== rootProbe.projectIds.join(",") ||
          restored.projectPaginationDetected !== rootProbe.projectPaginationDetected ||
          JSON.stringify(restored.failures) !== JSON.stringify(rootProbe.failures) ||
          !restored.authenticated)
      ) {
        restoreError = new Error("The projects UI changed during the same-session capture.");
      }
      progress("restore_root", "completed");
    } catch (error) {
      restoreError = error;
    }
    if (lifecycle === "capture_owned") {
      await session.close().catch((error: unknown) => {
        restoreError ??= error;
      });
    }
  }

  if (
    captureError !== null ||
    restoreError !== null ||
    rootProbe === null ||
    identityProbe === null ||
    identityRecheck === null
  ) {
    return blocked(
      "CAPTURE_FAILED",
      restoreError !== null
        ? `The trusted capture failed to restore and reread the top-level projects UI during ${phase}.`
        : `The trusted same-session inventory capture did not complete during ${phase}.`,
    );
  }

  const failures: Array<{ code: string; projectId?: string }> = [
    ...rootProbe.failures,
  ];
  if (
    identityProbe.host !== "tilda.ru" ||
    identityProbe.route !== "/identity/" ||
    !identityProbe.authenticated
  ) {
    failures.push({ code: "IDENTITY_NOT_AUTHENTICATED" });
  }
  if (
    identityRecheck.host !== identityProbe.host ||
    identityRecheck.route !== identityProbe.route ||
    !identityRecheck.authenticated ||
    identityRecheck.accountIdentitySource !== identityProbe.accountIdentitySource ||
    identityRecheck.stableAccountIdentity !== identityProbe.stableAccountIdentity
  ) {
    failures.push({ code: "SAME_SESSION_ACCOUNT_DRIFT" });
  }
  if (JSON.stringify(projectRechecks) !== JSON.stringify(projectProbes)) {
    failures.push({ code: "SAME_SESSION_INVENTORY_DRIFT" });
  }
  for (let index = 0; index < projectProbes.length; index += 1) {
    const project = projectProbes[index];
    const expectedProjectId = rootProbe.projectIds[index];
    if (project === undefined || expectedProjectId === undefined) {
      failures.push({ code: "PROJECT_READ_FAILED" });
      continue;
    }
    failures.push(...project.failures);
    if (
      project.host !== "tilda.ru" ||
      project.route !== "/projects/" ||
      project.id !== expectedProjectId ||
      !project.authenticated
    ) {
      failures.push({ code: "PROJECT_IDENTITY_MISMATCH", projectId: expectedProjectId });
    }
  }

  const expectedProjectCounts = projectProbes.map(
    (project) => project.expectedProjectCount,
  );
  const expectedProjectCount =
    expectedProjectCounts.length === rootProbe.projectIds.length &&
    expectedProjectCounts.every(
      (count) => count !== null && count === expectedProjectCounts[0],
    )
      ? (expectedProjectCounts[0] ?? null)
      : null;

  const probe: SameSessionInventoryProbe = {
    host: rootProbe.host,
    route: rootProbe.route,
    authenticated: rootProbe.authenticated,
    stableAccountIdentity: identityProbe.stableAccountIdentity,
    accountIdentitySource: identityProbe.accountIdentitySource,
    projectIds: rootProbe.projectIds,
    projectCardCount: rootProbe.projectCardCount,
    expectedProjectCount,
    projectPaginationDetected: rootProbe.projectPaginationDetected,
    projects: projectProbes.map(({ id, pageIds, pageCardCount, expectedPageCount, paginationDetected }) => ({
      id,
      pageIds,
      pageCardCount,
      expectedPageCount,
      paginationDetected,
    })),
    failures,
  };

  progress("derive", "started");
  const validation = deriveTrustedBindingFromProbe(probe, new Uint8Array(32));
  if (validation.status === "BLOCKED") return validation;
  const machineKey = await readOrCreateBindingKey(
    config.bindingKeyPath,
    options.createBindingKey === true,
  );
  if (machineKey === null) {
    return blocked(
      "BINDING_KEY_UNAVAILABLE",
      "Run the explicit bind command to create the ignored local machine binding key.",
    );
  }
  const derived = deriveTrustedBindingFromProbe(probe, machineKey);
  progress("derive", "completed");
  return derived.status === "BOUND"
    ? markTrustedCaptureForCurrentProcess(derived, session.sessionId)
    : derived;
}

export async function captureTrustedLiveBinding(
  config: ResearchConfig,
  options: TrustedCaptureOptions = {},
): Promise<TrustedBindingCapture> {
  const targets = await listCdpTargets(config.cdpUrl);
  const target = selectTildaProjectsTarget(targets);
  if (target?.webSocketDebuggerUrl === undefined) {
    return blocked(
      "PROJECTS_TARGET_NOT_FOUND",
      "Open the authenticated top-level https://tilda.ru/projects/ route in the dedicated CDP browser.",
    );
  }
  const session = await createLoopbackCdpTrustedBrowserSession(target);
  return captureTrustedLiveBindingWithSession(config, session, options);
}

export async function captureTrustedLiveBindingFromExtensionStdio(
  config: ResearchConfig,
  attachedByExactTabBroker: boolean,
  options: TrustedCaptureOptions = {},
): Promise<TrustedBindingCapture> {
  const session = await connectExtensionStdioTrustedBrowserSession({
    attachedByExactTabBroker,
  });
  return captureTrustedLiveBindingWithSession(config, session, options);
}

export async function inventoryProjects(config: ResearchConfig): Promise<AccountInventory> {
  const targets = await listCdpTargets(config.cdpUrl);
  const target = selectTildaProjectsTarget(targets);
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error("No top-level Tilda projects page is open in the dedicated CDP browser.");
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
