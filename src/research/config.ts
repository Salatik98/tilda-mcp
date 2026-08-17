import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeLoopbackCdpBaseUrl } from "./cdp-client.js";
import { KNOWN_READ_ONLY_SOURCE_PROJECT_IDS } from "./known-source-corpus.js";

export interface LabPageTarget {
  readonly projectId: string;
  readonly pageId: string;
}

/**
 * Exact, local admission for a previously created disposable lab record.
 * This is deliberately not a remote capability and must never be inferred from
 * a page allowlist alone.
 */
export interface LabRecordTarget extends LabPageTarget {
  readonly recordId: string;
}

export interface LiveInventory {
  readonly accountFingerprint: string;
  /** Complete current live project enumeration, including every lab project. */
  readonly projectIds: readonly string[];
  readonly pageOwnership: Readonly<Record<string, readonly string[]>>;
}

export interface ResearchConfig {
  cdpUrl: string;
  bindingKeyPath: string;
  bindingStatePath: string;
  observatoryHost: string;
  observatoryPort: number;
  accountFingerprint: string | null;
  inventoryHash: string | null;
  labProjectIds: readonly string[] | null;
  readOnlyProjectIds: readonly string[] | null;
  labPageTargets: readonly LabPageTarget[] | null;
  labRecordTargets: readonly LabRecordTarget[] | null;
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

  if (process.env.TILDA_SKIP_ENV_FILE === "extension-stdio-v1") return;

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

function parseRecordTargets(value: string | undefined): readonly LabRecordTarget[] | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "UNSPECIFIED") return null;
  if (trimmed.includes("UNSPECIFIED")) {
    throw new ConfigurationError("LAB_RECORD_TARGETS: UNSPECIFIED must be the entire value.");
  }

  const rawTargets = trimmed.split(",").map((item) => item.trim());
  const seen = new Set<string>();
  const targets = rawTargets.map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined || parts[2] === undefined) {
      throw new ConfigurationError(
        "LAB_RECORD_TARGETS entries must use the exact projectId:pageId:recordId format.",
      );
    }
    const projectId = assertCanonicalId(parts[0], "LAB_RECORD_TARGETS projectId");
    const pageId = assertCanonicalId(parts[1], "LAB_RECORD_TARGETS pageId");
    const recordId = assertCanonicalId(parts[2], "LAB_RECORD_TARGETS recordId");
    const key = `${projectId}:${pageId}:${recordId}`;
    if (seen.has(key)) throw new ConfigurationError("LAB_RECORD_TARGETS contains duplicates.");
    seen.add(key);
    return Object.freeze({ projectId, pageId, recordId });
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

function parseRuntimeStatePath(
  value: string | undefined,
  defaultName: string,
  field: string,
): string {
  const trimmed = value?.trim();
  if (trimmed?.includes("\0")) {
    throw new ConfigurationError(`${field} contains a null byte.`);
  }
  const runtimeDirectory = resolve(process.cwd(), ".tilda-runtime");
  const candidate = resolve(
    process.cwd(),
    trimmed === undefined || trimmed === ""
      ? `.tilda-runtime/${defaultName}`
      : trimmed,
  );
  if (dirname(candidate) !== runtimeDirectory) {
    throw new ConfigurationError(`${field} must be a direct child of ignored .tilda-runtime/.`);
  }
  return candidate;
}

export function assertRuntimeBindingPath(path: string, field: string): string {
  return parseRuntimeStatePath(path, "unused", field);
}

function readPersistedBinding(path: string): {
  accountFingerprint: string;
  inventoryHash: string;
} | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigurationError("Local binding state must be a regular non-symlink file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigurationError("Local binding state is not valid JSON.");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { format?: unknown }).format !== "tilda-local-binding-v1"
  ) {
    throw new ConfigurationError("Local binding state has an unsupported format.");
  }
  const accountFingerprint = parseAccountFingerprint(
    String((parsed as { accountFingerprint?: unknown }).accountFingerprint ?? ""),
  );
  const inventoryHash = parseInventoryHash(
    String((parsed as { inventoryHash?: unknown }).inventoryHash ?? ""),
  );
  if (accountFingerprint === null || inventoryHash === null) {
    throw new ConfigurationError("Local binding state is incomplete.");
  }
  return { accountFingerprint, inventoryHash };
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

  const bindingKeyPath = parseRuntimeStatePath(
    process.env.TILDA_BINDING_KEY_PATH,
    "account-binding.key",
    "TILDA_BINDING_KEY_PATH",
  );
  const bindingStatePath = parseRuntimeStatePath(
    process.env.TILDA_BINDING_STATE_PATH,
    "account-binding.json",
    "TILDA_BINDING_STATE_PATH",
  );
  if (bindingKeyPath === bindingStatePath) {
    throw new ConfigurationError(
      "TILDA_BINDING_KEY_PATH and TILDA_BINDING_STATE_PATH must be different files.",
    );
  }
  const configuredAccountFingerprint = parseAccountFingerprint(
    process.env.TILDA_ACCOUNT_FINGERPRINT,
  );
  const configuredInventoryHash = parseInventoryHash(
    process.env.TILDA_INVENTORY_HASH,
  );
  const persistedBinding =
    configuredAccountFingerprint === null && configuredInventoryHash === null
      ? readPersistedBinding(bindingStatePath)
      : null;

  return {
    cdpUrl: normalizeLoopbackCdpBaseUrl(
      process.env.TILDA_CDP_URL?.trim() || "http://127.0.0.1:9222",
    ),
    bindingKeyPath,
    bindingStatePath,
    observatoryHost: process.env.OBSERVATORY_HOST?.trim() || "127.0.0.1",
    observatoryPort: parsePort(process.env.OBSERVATORY_PORT),
    accountFingerprint:
      configuredAccountFingerprint ?? persistedBinding?.accountFingerprint ?? null,
    inventoryHash: configuredInventoryHash ?? persistedBinding?.inventoryHash ?? null,
    labProjectIds: parseIdList(process.env.LAB_PROJECT_IDS, "LAB_PROJECT_IDS"),
    readOnlyProjectIds: parseIdList(
      process.env.READ_ONLY_PROJECT_IDS,
      "READ_ONLY_PROJECT_IDS",
    ),
    labPageTargets: parsePageTargets(process.env.LAB_PAGE_TARGETS),
    labRecordTargets: parseRecordTargets(process.env.LAB_RECORD_TARGETS),
    publicTestDomains: parseDomainList(process.env.PUBLIC_TEST_DOMAINS),
    officialApiConfigured: Boolean(
      process.env.TILDA_PUBLIC_KEY?.trim() && process.env.TILDA_SECRET_KEY?.trim(),
    ),
  };
}

export function isConfiguredLiveBindingMatch(
  config: ResearchConfig,
  inventory: LiveInventory,
): boolean {
  try {
    assertLiveBinding(config, inventory);
    return true;
  } catch {
    return false;
  }
}

export async function persistLocalBinding(
  config: ResearchConfig,
  binding: {
    accountFingerprint: string;
    inventoryHash: string;
  },
): Promise<void> {
  const accountFingerprint = parseAccountFingerprint(binding.accountFingerprint);
  const inventoryHash = parseInventoryHash(binding.inventoryHash);
  if (accountFingerprint === null || inventoryHash === null) {
    throw new ConfigurationError("A complete account fingerprint and inventory hash are required.");
  }

  const statePath = assertRuntimeBindingPath(
    config.bindingStatePath,
    "TILDA_BINDING_STATE_PATH",
  );
  if (
    statePath ===
    assertRuntimeBindingPath(config.bindingKeyPath, "TILDA_BINDING_KEY_PATH")
  ) {
    throw new ConfigurationError("The binding state file must not replace the binding key.");
  }
  const stateDirectory = dirname(statePath);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(stateDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new ConfigurationError("Local .tilda-runtime must be a regular non-symlink directory.");
  }
  if (existsSync(statePath)) {
    const metadata = await lstat(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ConfigurationError("Local binding state must be a regular non-symlink file.");
    }
  }

  const updated = `${JSON.stringify(
    {
      format: "tilda-local-binding-v1",
      accountFingerprint,
      inventoryHash,
    },
    null,
    2,
  )}\n`;
  const temporaryPath = resolve(
    stateDirectory,
    `.account-binding-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

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
  const knownSourceProjects = new Set<string>(KNOWN_READ_ONLY_SOURCE_PROJECT_IDS);
  return (
    KNOWN_READ_ONLY_SOURCE_PROJECT_IDS.every((id) => protectedProjects.has(id)) &&
    !config.labProjectIds.some(
      (projectId) => protectedProjects.has(projectId) || knownSourceProjects.has(projectId),
    )
  );
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
  const knownSourceProjects = new Set<string>(KNOWN_READ_ONLY_SOURCE_PROJECT_IDS);
  const missingPermanentProtection = KNOWN_READ_ONLY_SOURCE_PROJECT_IDS.filter(
    (projectId) => !config.readOnlyProjectIds?.includes(projectId),
  );
  if (missingPermanentProtection.length > 0) {
    throw new TargetNotAllowlistedError(
      `Permanent source-corpus projects are missing from READ_ONLY_PROJECT_IDS: ${missingPermanentProtection.join(", ")}.`,
    );
  }
  if (config.labProjectIds === null) {
    throw new TargetNotAllowlistedError("LAB_PROJECT_IDS is UNSPECIFIED.");
  }
  const prohibitedLabSources = config.labProjectIds.filter((projectId) =>
    knownSourceProjects.has(projectId),
  );
  if (prohibitedLabSources.length > 0) {
    throw new TargetNotAllowlistedError(
      `Permanent source-corpus projects cannot be lab targets: ${prohibitedLabSources.join(", ")}.`,
    );
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

/**
 * Mandatory record-level guard for an existing fixture used by EXP-05.
 * EXP-06 may create an unknown record within its same-session transaction;
 * that temporary scope never changes this persistent local admission list.
 */
export function assertLabRecordTarget(
  config: ResearchConfig,
  target: LabRecordTarget,
  inventory: LiveInventory,
): LabRecordTarget {
  const canonicalTarget = canonicalExactLabRecordTarget(target, "target record");
  assertLabPageTarget(config, canonicalTarget, inventory);
  if (config.labRecordTargets === null) {
    throw new TargetNotAllowlistedError(
      "LAB_RECORD_TARGETS is UNSPECIFIED; existing-record writes are blocked.",
    );
  }
  const matched = config.labRecordTargets.some(
    (candidate) => {
      const canonicalCandidate = canonicalExactLabRecordTarget(
        candidate,
        "configured LAB_RECORD_TARGETS record",
      );
      return (
        canonicalCandidate.projectId === canonicalTarget.projectId &&
        canonicalCandidate.pageId === canonicalTarget.pageId &&
        canonicalCandidate.recordId === canonicalTarget.recordId
      );
    },
  );
  if (!matched) {
    throw new TargetNotAllowlistedError(
      `Record target ${canonicalTarget.projectId}:${canonicalTarget.pageId}:${canonicalTarget.recordId} is not in LAB_RECORD_TARGETS.`,
    );
  }
  return canonicalTarget;
}

function canonicalExactLabRecordTarget(value: unknown, field: string): LabRecordTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TargetNotAllowlistedError(
      `${field} must contain exactly projectId, pageId, and recordId.`,
    );
  }
  let keys: readonly PropertyKey[];
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TargetNotAllowlistedError(`${field} could not be inspected safely.`);
  }
  const expectedKeys = ["projectId", "pageId", "recordId"] as const;
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => keys.includes(key))
  ) {
    throw new TargetNotAllowlistedError(
      `${field} must contain exactly projectId, pageId, and recordId; extra or inherited target fields are forbidden.`,
    );
  }
  const ownStringValue = (key: (typeof expectedKeys)[number]): string => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TargetNotAllowlistedError(`${field}.${key} must be an own string data property.`);
    }
    return descriptor.value;
  };
  return Object.freeze({
    projectId: assertCanonicalId(ownStringValue("projectId"), `${field} projectId`),
    pageId: assertCanonicalId(ownStringValue("pageId"), `${field} pageId`),
    recordId: assertCanonicalId(ownStringValue("recordId"), `${field} recordId`),
  });
}
