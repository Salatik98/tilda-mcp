import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ExactTarget } from "../core/contracts.js";
import {
  LEARNING_ACTIONS,
  LEARNING_FAMILIES,
  LEARNING_TARGET_ROLES,
  type CapabilityRecipe,
  type CapabilityRecipeTrace,
} from "./contracts.js";

const HASH = /^sha256:[0-9a-f]{64}$/i;
const ID = /^[1-9][0-9]*$/;
const TOKEN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const RECIPE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ELEMENT_ID = /^[A-Za-z0-9_.-]{1,160}$/;
const PATH = /^[A-Za-z0-9_.[\]-]{1,160}$/;
const TRACE_PHASES = ["before", "after", "replay", "restore"] as const;
const TRACE_CHANNELS = ["dom", "runtime", "network"] as const;
const TRANSPORTS = ["authenticated_request", "editor_runtime", "deterministic_dom", "semantic_ui"] as const;

export type RecipeRegistryErrorCode =
  | "REGISTRY_PATH_UNSAFE"
  | "REGISTRY_ENTRY_INVALID"
  | "REGISTRY_IO_FAILED";

export class RecipeRegistryError extends Error {
  readonly code: RecipeRegistryErrorCode;

  constructor(code: RecipeRegistryErrorCode, message: string) {
    super(message);
    this.name = "RecipeRegistryError";
    this.code = code;
  }
}

function targetKey(target: ExactTarget): string {
  switch (target.kind) {
    case "project":
      return `project:${target.projectId}`;
    case "page":
      return `page:${target.projectId}:${target.pageId}`;
    case "record":
      return `record:${target.projectId}:${target.pageId}:${target.recordId}`;
    case "element":
      return `element:${target.projectId}:${target.pageId}:${target.recordId}:${target.elementId}`;
  }
}

export function capabilityRecipeKey(capability: string, target: ExactTarget): string {
  return `${capability}|${targetKey(target)}`;
}

/** Registry abstraction lets a future adapter persist recipes without changing MCP. */
export interface CapabilityRecipeRegistry {
  upsert(recipe: CapabilityRecipe): CapabilityRecipe;
  find(capability: string, target: ExactTarget): CapabilityRecipe | null;
  list(): readonly CapabilityRecipe[];
}

/** Safe default for tests and disconnected runs; no remote or file state is touched. */
export class InMemoryCapabilityRecipeRegistry implements CapabilityRecipeRegistry {
  readonly #recipes = new Map<string, CapabilityRecipe>();

  upsert(recipe: CapabilityRecipe): CapabilityRecipe {
    const copy = structuredClone(recipe);
    this.#recipes.set(capabilityRecipeKey(recipe.capability, recipe.target), copy);
    return structuredClone(copy);
  }

  find(capability: string, target: ExactTarget): CapabilityRecipe | null {
    const recipe = this.#recipes.get(capabilityRecipeKey(capability, target));
    return recipe === undefined ? null : structuredClone(recipe);
  }

  list(): readonly CapabilityRecipe[] {
    return [...this.#recipes.values()].map((recipe) => structuredClone(recipe));
  }
}

function contained(base: string, target: string, allowBase = false): boolean {
  const pathFromBase = relative(base, target);
  if (pathFromBase === "") return allowBase;
  return (
    pathFromBase !== ".." &&
    !pathFromBase.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromBase) &&
    !pathFromBase.includes(":")
  );
}

function assertNoRedirectedAncestor(target: string): void {
  const absolute = resolve(target);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  for (const segment of relative(parsed.root, absolute).split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) break;
    let metadata: ReturnType<typeof lstatSync>;
    let realPath: string;
    try {
      metadata = lstatSync(cursor);
      realPath = realpathSync.native(cursor);
    } catch {
      throw new RecipeRegistryError(
        "REGISTRY_PATH_UNSAFE",
        "Recipe registry ancestor could not be verified safely.",
      );
    }
    if (
      metadata.isSymbolicLink() ||
      relative(resolve(cursor), resolve(realPath)) !== ""
    ) {
      throw new RecipeRegistryError(
        "REGISTRY_PATH_UNSAFE",
        "Recipe registry path contains a symlink, junction, or redirected reparse ancestor.",
      );
    }
  }
}

function safeDirectory(base: string, target: string, create: boolean): void {
  if (!contained(base, target, true)) {
    throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry path escaped the ignored runtime root.");
  }
  // Verify the complete existing ancestor chain before recursively creating a
  // missing runtime or registry directory through a redirected Windows path.
  assertNoRedirectedAncestor(base);
  assertNoRedirectedAncestor(target);
  if (create && !existsSync(base)) mkdirSync(base, { recursive: true, mode: 0o700 });
  if (!existsSync(base)) throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Ignored runtime root does not exist.");
  const baseMetadata = lstatSync(base);
  if (!baseMetadata.isDirectory() || baseMetadata.isSymbolicLink()) {
    throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Ignored runtime root is not a regular directory.");
  }
  let cursor = base;
  for (const segment of relative(base, target).split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) {
      if (!create) throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry directory is missing.");
      mkdirSync(cursor, { mode: 0o700 });
      continue;
    }
    const metadata = lstatSync(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry contains a symlink or non-directory path.");
    }
  }
}

function safeFile(base: string, path: string): void {
  if (!contained(base, path) || !existsSync(path)) {
    throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry file path is unsafe or missing.");
  }
  safeDirectory(base, resolve(path, ".."), false);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry entry is not a regular file.");
  }
}

function exactObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", `${field} is not a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", `${field} is not a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", `${field} contains unexpected fields.`);
  }
}

function exactTarget(value: unknown): ExactTarget {
  const object = exactObject(value, "target");
  if (object.kind === "project") {
    exactKeys(object, ["kind", "projectId"], "target");
    if (typeof object.projectId !== "string" || !ID.test(object.projectId)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe target project ID is invalid.");
    return { kind: "project", projectId: object.projectId };
  }
  if (object.kind === "page") {
    exactKeys(object, ["kind", "projectId", "pageId"], "target");
    if (typeof object.projectId !== "string" || !ID.test(object.projectId) || typeof object.pageId !== "string" || !ID.test(object.pageId)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe target page IDs are invalid.");
    return { kind: "page", projectId: object.projectId, pageId: object.pageId };
  }
  if (object.kind === "record") {
    exactKeys(object, ["kind", "projectId", "pageId", "recordId"], "target");
    if (typeof object.projectId !== "string" || !ID.test(object.projectId) || typeof object.pageId !== "string" || !ID.test(object.pageId) || typeof object.recordId !== "string" || !ID.test(object.recordId)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe target record IDs are invalid.");
    return { kind: "record", projectId: object.projectId, pageId: object.pageId, recordId: object.recordId };
  }
  if (object.kind === "element") {
    exactKeys(object, ["kind", "projectId", "pageId", "recordId", "elementId"], "target");
    if (typeof object.projectId !== "string" || !ID.test(object.projectId) || typeof object.pageId !== "string" || !ID.test(object.pageId) || typeof object.recordId !== "string" || !ID.test(object.recordId) || typeof object.elementId !== "string" || !ELEMENT_ID.test(object.elementId)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe target element identity is invalid.");
    return { kind: "element", projectId: object.projectId, pageId: object.pageId, recordId: object.recordId, elementId: object.elementId };
  }
  throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe target kind is invalid.");
}

function trace(value: unknown, index: number): CapabilityRecipeTrace {
  const object = exactObject(value, `traces[${index}]`);
  exactKeys(object, ["phase", "traceId", "channels", "eventCount", "digest"], `traces[${index}]`);
  if (object.phase !== TRACE_PHASES[index]) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe trace phases are incomplete or out of order.");
  if (typeof object.traceId !== "string" || !RECIPE_ID.test(object.traceId) || typeof object.digest !== "string" || !HASH.test(object.digest)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe trace receipt is invalid.");
  if (!Number.isSafeInteger(object.eventCount) || (object.eventCount as number) < 1 || (object.eventCount as number) > 100_000) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe trace event count is invalid.");
  const channels = object.channels;
  if (!Array.isArray(channels) || channels.length !== TRACE_CHANNELS.length || TRACE_CHANNELS.some((channel) => !channels.includes(channel))) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe trace channels are incomplete.");
  return {
    phase: object.phase as CapabilityRecipeTrace["phase"],
    traceId: object.traceId as string,
    channels: [...channels] as CapabilityRecipeTrace["channels"],
    eventCount: object.eventCount as number,
    digest: object.digest as string,
  };
}

function validateRecipe(value: unknown): CapabilityRecipe {
  const object = exactObject(value, "recipe");
  exactKeys(object, ["format", "recipeId", "capability", "family", "action", "mode", "target", "targetRole", "adapterId", "transport", "registeredAt", "changedPaths", "beforeHash", "afterHash", "replayHash", "restoredHash", "traces"], "recipe");
  if (object.format !== "tilda-capability-recipe-v1" || object.mode !== "copy-test") throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe format or mode is unsupported.");
  if (typeof object.recipeId !== "string" || !RECIPE_ID.test(object.recipeId) || typeof object.capability !== "string" || !/^[a-z][a-z0-9]*(?:\.[a-z0-9]+){1,5}$/.test(object.capability) || !LEARNING_FAMILIES.includes(object.family as typeof LEARNING_FAMILIES[number]) || !LEARNING_ACTIONS.includes(object.action as typeof LEARNING_ACTIONS[number]) || !LEARNING_TARGET_ROLES.includes(object.targetRole as typeof LEARNING_TARGET_ROLES[number])) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe identity fields are invalid.");
  if (typeof object.adapterId !== "string" || !TOKEN.test(object.adapterId) || typeof object.registeredAt !== "string" || Number.isNaN(Date.parse(object.registeredAt)) || !TRANSPORTS.includes(object.transport as typeof TRANSPORTS[number])) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe adapter metadata is invalid.");
  const target = exactTarget(object.target);
  for (const key of ["beforeHash", "afterHash", "replayHash", "restoredHash"] as const) {
    if (typeof object[key] !== "string" || !HASH.test(object[key])) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe state hash is invalid.");
  }
  if (!Array.isArray(object.changedPaths) || object.changedPaths.some((path) => typeof path !== "string" || !PATH.test(path))) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe changed paths are invalid.");
  if (!Array.isArray(object.traces) || object.traces.length !== TRACE_PHASES.length) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe must contain four phase traces.");
  const traces = object.traces.map((entry, index) => trace(entry, index));
  return {
    format: "tilda-capability-recipe-v1",
    recipeId: object.recipeId as string,
    capability: object.capability as string,
    family: object.family as CapabilityRecipe["family"],
    action: object.action as CapabilityRecipe["action"],
    mode: "copy-test",
    target,
    targetRole: object.targetRole as CapabilityRecipe["targetRole"],
    adapterId: object.adapterId as string,
    transport: object.transport as CapabilityRecipe["transport"],
    registeredAt: object.registeredAt as string,
    changedPaths: [...object.changedPaths] as string[],
    beforeHash: object.beforeHash as string,
    afterHash: object.afterHash as string,
    replayHash: object.replayHash as string,
    restoredHash: object.restoredHash as string,
    traces,
  };
}

function recipeDigest(recipe: Pick<CapabilityRecipe, "capability" | "target">): string {
  return createHash("sha256").update(capabilityRecipeKey(recipe.capability, recipe.target)).digest("hex");
}

/**
 * Durable raw-free recipe registry. `runtimeRoot` must be the caller's ignored
 * runtime directory; every directory and entry is lstat-checked and any
 * symlink, unexpected file, path escape, or malformed JSON fails closed.
 */
export class FileCapabilityRecipeRegistry implements CapabilityRecipeRegistry {
  readonly #runtimeRoot: string;
  readonly #root: string;

  constructor(root: string, runtimeRoot: string = resolve(process.cwd(), ".tilda-runtime")) {
    this.#runtimeRoot = resolve(runtimeRoot);
    this.#root = resolve(root);
    if (!contained(this.#runtimeRoot, this.#root, false)) {
      throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry root is outside the ignored runtime directory.");
    }
    safeDirectory(this.#runtimeRoot, this.#root, true);
  }

  upsert(recipe: CapabilityRecipe): CapabilityRecipe {
    const validated = validateRecipe(recipe);
    safeDirectory(this.#runtimeRoot, this.#root, false);
    const path = resolve(this.#root, `${recipeDigest(validated)}.json`);
    let existing = false;
    try {
      const metadata = lstatSync(path);
      existing = true;
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry entry is not a regular file.");
      }
    } catch (error) {
      if (error instanceof RecipeRegistryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry entry could not be inspected safely.");
      }
    }
    if (existing) {
      const existing = this.#read(path);
      if (recipeDigest(existing) !== recipeDigest(validated)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe registry key does not match its content.");
    }
    try {
      writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
      safeFile(this.#root, path);
    } catch (error) {
      if (error instanceof RecipeRegistryError) throw error;
      throw new RecipeRegistryError("REGISTRY_IO_FAILED", "Recipe registry entry could not be written.");
    }
    return structuredClone(validated);
  }

  find(capability: string, target: ExactTarget): CapabilityRecipe | null {
    safeDirectory(this.#runtimeRoot, this.#root, false);
    const path = resolve(this.#root, `${recipeDigest({ capability, target })}.json`);
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry entry is not a regular file.");
      }
    } catch (error) {
      if (error instanceof RecipeRegistryError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new RecipeRegistryError("REGISTRY_PATH_UNSAFE", "Recipe registry entry could not be inspected safely.");
    }
    const recipe = this.#read(path);
    if (recipeDigest(recipe) !== recipeDigest({ capability, target })) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe registry key does not match its content.");
    return structuredClone(recipe);
  }

  list(): readonly CapabilityRecipe[] {
    safeDirectory(this.#runtimeRoot, this.#root, false);
    let entries: { readonly name: string; isSymbolicLink(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(this.#root, { withFileTypes: true, encoding: "utf8" });
    } catch {
      throw new RecipeRegistryError("REGISTRY_IO_FAILED", "Recipe registry directory could not be read.");
    }
    return entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}\.json$/i.test(entry.name)) {
          throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe registry contains an unexpected entry.");
        }
        const path = resolve(this.#root, entry.name);
        const recipe = this.#read(path);
        if (recipeDigest(recipe) !== entry.name.slice(0, -5)) throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe registry key does not match its content.");
        return recipe;
      })
      .map((recipe) => structuredClone(recipe));
  }

  #read(path: string): CapabilityRecipe {
    safeFile(this.#root, path);
    try {
      return validateRecipe(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (error instanceof RecipeRegistryError) throw error;
      throw new RecipeRegistryError("REGISTRY_ENTRY_INVALID", "Recipe registry entry is not valid JSON.");
    }
  }
}
