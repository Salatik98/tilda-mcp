import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface LabPageTarget {
  readonly projectId: string;
  readonly pageId: string;
}

export interface LiveInventory {
  readonly accountFingerprint: string;
  /** Complete current live project enumeration, including every lab project. */
  readonly projectIds: readonly string[];
  readonly pageOwnership: Readonly<Record<string, readonly string[]>>;
}

export interface ResearchConfig {
  cdpUrl: string;
  observatoryHost: string;
  observatoryPort: number;
  accountFingerprint: string | null;
  inventoryHash: string | null;
  labProjectIds: readonly string[] | null;
  readOnlyProjectIds: readonly string[] | null;
  labPageTargets: readonly LabPageTarget[] | null;
  publicTestDomains: readonly string[] | null;
  officialApiConfigured: boolean;
}

export class ConfigurationError extends Error {
  readonly code = "INVALID_RESEARCH_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class TargetNotAllowlistedError extends Error {
  readonly code = "TARGET_NOT_ALLOWLISTED";

  constructor(message: string) {
    super(message);
    this.name = "TargetNotAllowlistedError";
  }
}

let environmentLoaded = false;

function loadLocalEnvironment(): void {
  if (environmentLoaded) return;
  environmentLoaded = true;

  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
}

const CANONICAL_TILDA_ID = /^[1-9][0-9]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function compareCanonicalIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertCanonicalId(value: string, field: string): string {
  if (!CANONICAL_TILDA_ID.test(value)) {
    throw new ConfigurationError(
      `${field} must contain canonical positive decimal Tilda IDs only.`,
    );
  }
  return value;
}

function parseIdList(value: string | undefined, field: string): readonly string[] | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "UNSPECIFIED") return null;
  if (trimmed.includes("UNSPECIFIED")) {
    throw new ConfigurationError(`${field}: UNSPECIFIED must be the entire value.`);
  }

  const rawIds = trimmed.split(",").map((item) => item.trim());
  if (rawIds.some((id) => id === "")) {
    throw new ConfigurationError(`${field} contains an empty ID.`);
  }
  const ids = rawIds.map((id) => assertCanonicalId(id, field));
  if (new Set(ids).size !== ids.length) {
    throw new ConfigurationError(`${field} contains duplicate IDs.`);
  }
  return Object.freeze(ids);
}

function parsePageTargets(value: string | undefined): readonly LabPageTarget[] | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "UNSPECIFIED") return null;
  if (trimmed.includes("UNSPECIFIED")) {
    throw new ConfigurationError("LAB_PAGE_TARGETS: UNSPECIFIED must be the entire value.");
  }

  const rawTargets = trimmed.split(",").map((item) => item.trim());
  const seen = new Set<string>();
  const targets = rawTargets.map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ConfigurationError(
        "LAB_PAGE_TARGETS entries must use the exact projectId:pageId format.",
      );
    }
    const projectId = assertCanonicalId(parts[0], "LAB_PAGE_TARGETS projectId");
    const pageId = assertCanonicalId(parts[1], "LAB_PAGE_TARGETS pageId");
    const key = `${projectId}:${pageId}`;
    if (seen.has(key)) throw new ConfigurationError("LAB_PAGE_TARGETS contains duplicates.");
    seen.add(key);
    return Object.freeze({ projectId, pageId });
  });
  return Object.freeze(targets);
}

function parseOpaqueBinding(value: string | undefined, field: string): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "UNSPECIFIED") return null;
  if (trimmed.includes("UNSPECIFIED") || /[\s,;*]/.test(trimmed)) {
    throw new ConfigurationError(`${field} contains invalid characters.`);
  }
  return trimmed;
}

function parseInventoryHash(value: string | undefined): string | null {
  const parsed = parseOpaqueBinding(value, "TILDA_INVENTORY_HASH");
  if (parsed !== null && !SHA256_HEX.test(parsed)) {
    throw new ConfigurationError("TILDA_INVENTORY_HASH must be a lowercase SHA-256 hex digest.");
  }
  return parsed;
}

function parseAccountFingerprint(value: string | undefined): string | null {
  const parsed = parseOpaqueBinding(value, "TILDA_ACCOUNT_FINGERPRINT");
  if (parsed !== null && !SHA256_HEX.test(parsed)) {
    throw new ConfigurationError(
      "TILDA_ACCOUNT_FINGERPRINT must be a lowercase HMAC-SHA-256 hex digest.",
    );
  }
  return parsed;
}

function parseDomainList(value: string | undefined): readonly string[] | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "UNSPECIFIED") return null;
  if (trimmed.includes("UNSPECIFIED")) {
    throw new ConfigurationError("PUBLIC_TEST_DOMAINS: UNSPECIFIED must be the entire value.");
  }
  const domains = trimmed.split(",").map((entry) => entry.trim().toLowerCase());
  if (domains.some((domain) => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))) {
    throw new ConfigurationError("PUBLIC_TEST_DOMAINS contains an invalid hostname.");
  }
  if (new Set(domains).size !== domains.length) {
    throw new ConfigurationError("PUBLIC_TEST_DOMAINS contains duplicates.");
  }
  return Object.freeze(domains);
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "4765", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigurationError("OBSERVATORY_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

function canonicalLiveInventory(inventory: LiveInventory): string {
  const accountFingerprint = parseAccountFingerprint(
    inventory.accountFingerprint,
  );
  if (accountFingerprint === null) {
    throw new ConfigurationError("Live account fingerprint is required.");
  }
  const projectIds = inventory.projectIds
    .map((id) => assertCanonicalId(id, "live projectId"))
    .sort(compareCanonicalIds);
  if (
    projectIds.length === 0 ||
    new Set(projectIds).size !== projectIds.length
  ) {
    throw new ConfigurationError(
      "Live project inventory is empty or contains duplicates.",
    );
  }
  const pageOwnership = Object.entries(inventory.pageOwnership)
    .map(([projectId, pageIds]) => {
      const canonicalProjectId = assertCanonicalId(projectId, "live page owner projectId");
      const canonicalPageIds = pageIds
        .map((pageId) => assertCanonicalId(pageId, "live owned pageId"))
        .sort(compareCanonicalIds);
      if (new Set(canonicalPageIds).size !== canonicalPageIds.length) {
        throw new ConfigurationError(
          `Live page inventory for project ${canonicalProjectId} contains duplicates.`,
        );
      }
      return [canonicalProjectId, canonicalPageIds] as const;
    })
    .sort(([left], [right]) => compareCanonicalIds(left, right));
  const pageOwners = new Map<string, string>();
  for (const [projectId, pageIds] of pageOwnership) {
    for (const pageId of pageIds) {
      const priorOwner = pageOwners.get(pageId);
      if (priorOwner !== undefined) {
        throw new ConfigurationError(
          `Live page ${pageId} is claimed by multiple projects: ${priorOwner}, ${projectId}.`,
        );
      }
      pageOwners.set(pageId, projectId);
    }
  }
  const ownershipProjectIds = pageOwnership.map(([projectId]) => projectId);
  if (
    ownershipProjectIds.length !== projectIds.length ||
    ownershipProjectIds.some((projectId, index) => projectId !== projectIds[index])
  ) {
    throw new ConfigurationError(
      "Live page ownership must contain one entry for every current project and no others.",
    );
  }
  return JSON.stringify({
    format: "tilda-live-inventory-v1",
    accountFingerprint,
    projectIds,
    pageOwnership,
  });
}

/** Canonicalize and hash a trusted same-session capture; this function does not make input trusted. */
export function hashLiveInventory(inventory: LiveInventory): string {
  return createHash("sha256").update(canonicalLiveInventory(inventory)).digest("hex");
}

export function loadConfig(): ResearchConfig {
  loadLocalEnvironment();

  return {
    cdpUrl: process.env.TILDA_CDP_URL?.trim() || "http://127.0.0.1:9222",
    observatoryHost: process.env.OBSERVATORY_HOST?.trim() || "127.0.0.1",
    observatoryPort: parsePort(process.env.OBSERVATORY_PORT),
    accountFingerprint: parseAccountFingerprint(process.env.TILDA_ACCOUNT_FINGERPRINT),
    inventoryHash: parseInventoryHash(process.env.TILDA_INVENTORY_HASH),
    labProjectIds: parseIdList(process.env.LAB_PROJECT_IDS, "LAB_PROJECT_IDS"),
    readOnlyProjectIds: parseIdList(
      process.env.READ_ONLY_PROJECT_IDS,
      "READ_ONLY_PROJECT_IDS",
    ),
    labPageTargets: parsePageTargets(process.env.LAB_PAGE_TARGETS),
    publicTestDomains: parseDomainList(process.env.PUBLIC_TEST_DOMAINS),
    officialApiConfigured: Boolean(
      process.env.TILDA_PUBLIC_KEY?.trim() && process.env.TILDA_SECRET_KEY?.trim(),
    ),
  };
}

export function isWriteAllowlistSyntacticallyValid(config: ResearchConfig): boolean {
  if (
    config.accountFingerprint === null ||
    config.inventoryHash === null ||
    config.labProjectIds === null ||
    config.readOnlyProjectIds === null
  ) {
    return false;
  }
  if (
    !SHA256_HEX.test(config.accountFingerprint) ||
    !SHA256_HEX.test(config.inventoryHash) ||
    config.labProjectIds.length === 0 ||
    config.readOnlyProjectIds.length === 0 ||
    config.labProjectIds.some((id) => !CANONICAL_TILDA_ID.test(id)) ||
    config.readOnlyProjectIds.some((id) => !CANONICAL_TILDA_ID.test(id)) ||
    new Set(config.labProjectIds).size !== config.labProjectIds.length ||
    new Set(config.readOnlyProjectIds).size !== config.readOnlyProjectIds.length
  ) {
    return false;
  }
  const protectedProjects = new Set(config.readOnlyProjectIds);
  return !config.labProjectIds.some((projectId) => protectedProjects.has(projectId));
}

function assertLiveBinding(config: ResearchConfig, inventory: LiveInventory): void {
  if (config.accountFingerprint === null || config.inventoryHash === null) {
    throw new TargetNotAllowlistedError(
      "The allowlist is not bound to an authenticated account fingerprint and inventory hash.",
    );
  }
  if (
    inventory.accountFingerprint !== config.accountFingerprint ||
    hashLiveInventory(inventory) !== config.inventoryHash
  ) {
    throw new TargetNotAllowlistedError(
      "Live account fingerprint or inventory hash does not match the configured allowlist binding.",
    );
  }
  const liveProjectIds = inventory.projectIds.map((id) =>
    assertCanonicalId(id, "live projectId"),
  );
  if (liveProjectIds.length === 0 || new Set(liveProjectIds).size !== liveProjectIds.length) {
    throw new TargetNotAllowlistedError(
      "Live project inventory is empty or contains duplicates.",
    );
  }
  if (config.readOnlyProjectIds === null) {
    throw new TargetNotAllowlistedError(
      "READ_ONLY_PROJECT_IDS is UNSPECIFIED; writes remain blocked until source corpus is protected.",
    );
  }
  if (config.labProjectIds === null) {
    throw new TargetNotAllowlistedError("LAB_PROJECT_IDS is UNSPECIFIED.");
  }
  const classified = new Set([...config.readOnlyProjectIds, ...config.labProjectIds]);
  const unclassified = liveProjectIds.filter((projectId) => !classified.has(projectId));
  if (unclassified.length > 0) {
    throw new TargetNotAllowlistedError(
      `Current live projects are not classified read-only or lab: ${unclassified.join(", ")}.`,
    );
  }
  const absentLabs = config.labProjectIds.filter(
    (projectId) => !liveProjectIds.includes(projectId),
  );
  if (absentLabs.length > 0) {
    throw new TargetNotAllowlistedError(
      `Configured lab projects are absent from the current live inventory: ${absentLabs.join(", ")}.`,
    );
  }
}

function assertProjectGate(
  config: ResearchConfig,
  projectId: string,
  inventory: LiveInventory,
): void {
  const canonicalProjectId = assertCanonicalId(projectId, "target projectId");
  if (config.labProjectIds === null) {
    throw new TargetNotAllowlistedError(
      "LAB_PROJECT_IDS is UNSPECIFIED; all remote writes are blocked.",
    );
  }
  assertLiveBinding(config, inventory);
  const readOnlyProjectIds = config.readOnlyProjectIds;
  if (readOnlyProjectIds === null) {
    throw new TargetNotAllowlistedError(
      "READ_ONLY_PROJECT_IDS is UNSPECIFIED; writes remain blocked.",
    );
  }
  const overlap = config.labProjectIds.filter((id) => readOnlyProjectIds.includes(id));
  if (overlap.length > 0) {
    throw new TargetNotAllowlistedError(
      `LAB_PROJECT_IDS overlaps READ_ONLY_PROJECT_IDS: ${overlap.join(", ")}.`,
    );
  }
  if (readOnlyProjectIds.includes(canonicalProjectId)) {
    throw new TargetNotAllowlistedError(`Project ${canonicalProjectId} is explicitly read-only.`);
  }
  if (!config.labProjectIds.includes(canonicalProjectId)) {
    throw new TargetNotAllowlistedError(
      `Project ${canonicalProjectId} is not in LAB_PROJECT_IDS.`,
    );
  }
}

/** Project-scoped guard. Never use this for page, record, element, asset, or publish actions. */
export function assertLabProjectTarget(
  config: ResearchConfig,
  target: { projectId: string },
  inventory: LiveInventory,
): void {
  assertProjectGate(config, target.projectId, inventory);
}

/** Mandatory guard for every page/record/element/publish action. */
export function assertLabPageTarget(
  config: ResearchConfig,
  target: LabPageTarget,
  inventory: LiveInventory,
): void {
  assertProjectGate(config, target.projectId, inventory);
  const canonicalPageId = assertCanonicalId(target.pageId, "target pageId");
  const liveOwnedPages = inventory.pageOwnership[target.projectId];
  if (
    liveOwnedPages === undefined ||
    !liveOwnedPages.map((id) => assertCanonicalId(id, "live owned pageId")).includes(canonicalPageId)
  ) {
    throw new TargetNotAllowlistedError(
      `Live inventory does not bind page ${canonicalPageId} to project ${target.projectId}.`,
    );
  }
  if (config.labPageTargets === null) {
    throw new TargetNotAllowlistedError(
      "LAB_PAGE_TARGETS is UNSPECIFIED; page-scoped writes are blocked.",
    );
  }
  const matched = config.labPageTargets.some(
    (candidate) =>
      candidate.projectId === target.projectId && candidate.pageId === canonicalPageId,
  );
  if (!matched) {
    throw new TargetNotAllowlistedError(
      `Page target ${target.projectId}:${canonicalPageId} is not in LAB_PAGE_TARGETS.`,
    );
  }
}
