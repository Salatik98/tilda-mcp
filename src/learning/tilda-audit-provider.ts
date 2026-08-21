import type { ExactTarget } from "../core/contracts.js";
import { canonicalHash } from "../research/hash.js";
import type { ResearchConfig, LabPageTarget, LabRecordTarget } from "../research/config.js";
import type { LoopbackBrowserReadAuthority } from "../control/browser-authority.js";
import type {
  EditorRecordIdentity,
  ExactEditorPageSnapshot,
  ExactEditorRecordRead,
  RenderedBlockLibraryIndex,
} from "../research/browser-session.js";
import type {
  AuditCheck,
  AuditFinding,
  AuditReport,
  AuditRequest,
  TildaAuditProvider,
} from "./contracts.js";

const ID = /^[1-9][0-9]*$/;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,96}$/;
const MAX_SHAPE_NODES = 5_000;
const MAX_SHAPE_DEPTH = 12;

export type TildaAuditAuthorityRunner = <T>(
  config: ResearchConfig,
  action: (authority: LoopbackBrowserReadAuthority) => Promise<T>,
) => Promise<T>;

const defaultReadAuthorityRunner: TildaAuditAuthorityRunner = async (config, action) => {
  const { withLoopbackBrowserReadAuthority } = await import("../control/browser-authority.js");
  return withLoopbackBrowserReadAuthority(config, action);
};

interface AuditContext {
  readonly authority: LoopbackBrowserReadAuthority;
  readonly target: ExactTarget;
  readonly projectKnown: boolean;
  readonly pageOwned: boolean;
  readonly page: ExactEditorPageSnapshot | null;
  readonly record: EditorRecordIdentity | null;
  readonly recordRead: ExactEditorRecordRead | null;
  readonly pageReadBlocked: boolean;
  readonly recordReadBlocked: boolean;
  readonly elementPresent: boolean | null;
  readonly payloadShapeHash: string | null;
  readonly library: RenderedBlockLibraryIndex | null;
  readonly libraryReadBlocked: boolean;
}

function pageTarget(target: ExactTarget): LabPageTarget {
  if (target.kind === "project") {
    throw new Error("A page target is required.");
  }
  return { projectId: target.projectId, pageId: target.pageId };
}

function recordTarget(target: ExactTarget): LabRecordTarget {
  if (target.kind !== "record" && target.kind !== "element") {
    throw new Error("A record target is required.");
  }
  return { projectId: target.projectId, pageId: target.pageId, recordId: target.recordId };
}

function samePageTarget(left: LabPageTarget, right: ExactTarget): boolean {
  return right.kind !== "project" && left.projectId === right.projectId && left.pageId === right.pageId;
}

function sameRecordTarget(left: LabRecordTarget, right: ExactTarget): boolean {
  return (
    (right.kind === "record" || right.kind === "element") &&
    left.projectId === right.projectId &&
    left.pageId === right.pageId &&
    left.recordId === right.recordId
  );
}

function safeIdentity(identity: EditorRecordIdentity): Record<string, string> {
  const values = [identity.recordId, identity.recordType, identity.recordCode, identity.recordCategory];
  if (values.some((value) => !SAFE_TOKEN.test(value))) {
    throw new Error("The editor returned an unsafe record identity.");
  }
  return {
    recordId: identity.recordId,
    recordType: identity.recordType,
    recordCode: identity.recordCode,
    recordCategory: identity.recordCategory,
  };
}

function contentFreeShape(value: unknown, state = { nodes: 0 }, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_SHAPE_NODES || depth > MAX_SHAPE_DEPTH) return { kind: "truncated" };
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "string", bytes: new TextEncoder().encode(value).byteLength };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      items: value.slice(0, 256).map((entry) => contentFreeShape(entry, state, depth + 1)),
    };
  }
  if (typeof value !== "object") return { kind: typeof value };
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort().slice(0, 512);
  return {
    kind: "object",
    keys,
    values: Object.fromEntries(keys.map((key) => [key, contentFreeShape(objectValue[key], state, depth + 1)])),
  };
}

function shapeHash(value: unknown): string {
  return canonicalHash(contentFreeShape(value));
}

function containsOpaqueId(value: unknown, wanted: string, state = { nodes: 0 }, depth = 0): boolean {
  state.nodes += 1;
  if (state.nodes > MAX_SHAPE_NODES || depth > MAX_SHAPE_DEPTH) return false;
  if (value === wanted) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsOpaqueId(entry, wanted, state, depth + 1));
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === wanted || containsOpaqueId(entry, wanted, state, depth + 1)) return true;
  }
  return false;
}

function recordDescriptorHash(records: readonly EditorRecordIdentity[]): string {
  return canonicalHash(records.map((record) => safeIdentity(record)));
}

function capabilityNames(recordCode: string, hasStructuredField: boolean): readonly string[] {
  if (recordCode === "T123") return ["t123.code.read", "t123.code.replace"];
  if (recordCode === "T396") {
    return [
      "zero.model.read",
      "zero.leaf.patch",
      "zero.responsive.patch",
      "zero.shape.clone",
    ];
  }
  return hasStructuredField ? ["standard.field.patch"] : ["record.read"];
}

function pageCapabilities(page: ExactEditorPageSnapshot): readonly string[] {
  return [...new Set(page.records.flatMap((record) => capabilityNames(record.recordCode, false)))].sort();
}

function finding(
  code: string,
  severity: AuditFinding["severity"],
  summary: string,
  evidenceHash?: string,
): AuditFinding {
  if (!SAFE_TOKEN.test(code) || summary.length === 0 || summary.length > 512) {
    throw new Error("Audit finding was not sanitized.");
  }
  return evidenceHash === undefined
    ? { code, severity, summary }
    : { code, severity, summary, evidenceHash };
}

function reportStatus(findings: readonly AuditFinding[]): AuditReport["status"] {
  if (findings.some((item) => item.severity === "blocked")) return "BLOCKED";
  if (findings.some((item) => item.severity === "warning")) return "WARN";
  return "PASS";
}

function targetIdentityHash(target: ExactTarget): string {
  return canonicalHash(target);
}

function requested(checks: readonly AuditCheck[], check: AuditCheck): boolean {
  return checks.includes(check);
}

/**
 * Read-only audit provider backed by the existing fixed authority reader. It
 * never opens an arbitrary URL or exposes raw editor payloads; payloads are
 * reduced to content-free shape hashes before findings are returned.
 */
export class LoopbackTildaAuditProvider implements TildaAuditProvider {
  readonly #runner: TildaAuditAuthorityRunner;
  readonly #timeoutMs: number | undefined;

  constructor(
    readonly config: ResearchConfig,
    runner: TildaAuditAuthorityRunner = defaultReadAuthorityRunner,
    timeoutMs?: number,
  ) {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000)) {
      throw new Error("Audit timeout must be a positive integer no greater than 12000 ms.");
    }
    this.#runner = runner;
    this.#timeoutMs = timeoutMs;
  }

  async audit(request: AuditRequest): Promise<AuditReport> {
    return this.#runner(this.config, async (authority) => {
      authority.assertFresh();
      const context = await this.#loadContext(authority, request.target, request.checks);
      const findings = this.#findings(context, request);
      authority.assertFresh();
      return {
        format: "tilda-audit-v1",
        target: structuredClone(request.target),
        status: reportStatus(findings),
        checks: [...request.checks],
        findings,
        adapter: "browser-audit-v1",
        observedAt: new Date().toISOString(),
      };
    });
  }

  async #loadContext(
    authority: LoopbackBrowserReadAuthority,
    target: ExactTarget,
    checks: readonly AuditCheck[],
  ): Promise<AuditContext> {
    const projectKnown =
      authority.inventory.projectIds.includes(target.projectId) &&
      (this.config.readOnlyProjectIds?.includes(target.projectId) === true ||
        this.config.labProjectIds?.includes(target.projectId) === true);
    if (target.kind === "project") {
      return {
        authority,
        target,
        projectKnown,
        pageOwned: false,
        page: null,
        record: null,
        recordRead: null,
        pageReadBlocked: false,
        recordReadBlocked: false,
        elementPresent: null,
        payloadShapeHash: null,
        library: null,
        libraryReadBlocked: false,
      };
    }

    const ownedPages = authority.inventory.pageOwnership[target.projectId] ?? [];
    const pageOwned = ownedPages.includes(target.pageId);
    let page: ExactEditorPageSnapshot | null = null;
    let pageReadBlocked = false;
    try {
      if (projectKnown && pageOwned) page = await authority.reader.readEditorPage(pageTarget(target), this.#timeoutMs);
      else pageReadBlocked = true;
    } catch {
      pageReadBlocked = true;
    }

    let library: RenderedBlockLibraryIndex | null = null;
    let libraryReadBlocked = false;
    if (requested(checks, "capability") && page !== null) {
      try {
        library = await authority.reader.readRenderedBlockLibrary(pageTarget(target), this.#timeoutMs);
      } catch {
        libraryReadBlocked = true;
      }
    }

    if (target.kind === "page" || page === null) {
      return {
        authority,
        target,
        projectKnown,
        pageOwned,
        page,
        record: null,
        recordRead: null,
        pageReadBlocked,
        recordReadBlocked: false,
        elementPresent: null,
        payloadShapeHash: null,
        library,
        libraryReadBlocked,
      };
    }
    const record = page.records.find((candidate) => candidate.recordId === target.recordId) ?? null;
    if (record === null) {
      return {
        authority,
        target,
        projectKnown,
        pageOwned,
        page,
        record: null,
        recordRead: null,
        pageReadBlocked,
        recordReadBlocked: true,
        elementPresent: null,
        payloadShapeHash: null,
        library,
        libraryReadBlocked,
      };
    }

    const needsRecordRead =
      target.kind === "element" ||
      requested(checks, "structure") ||
      requested(checks, "capability") ||
      requested(checks, "revision");
    if (!needsRecordRead) {
      return {
        authority,
        target,
        projectKnown,
        pageOwned,
        page,
        record,
        recordRead: null,
        pageReadBlocked,
        recordReadBlocked: false,
        elementPresent: null,
        payloadShapeHash: null,
        library,
        libraryReadBlocked,
      };
    }

    let recordRead: ExactEditorRecordRead | null = null;
    let recordReadBlocked = false;
    try {
      const exactRecord = recordTarget(target);
      recordRead =
        record.recordCode === "T123"
          ? await authority.reader.readT123Content(exactRecord, this.#timeoutMs)
          : record.recordCode === "T396"
            ? await authority.reader.readZeroServerRepresentation(exactRecord, this.#timeoutMs)
            : await authority.reader.readStandardSettings(exactRecord, this.#timeoutMs);
      if (!sameRecordTarget(recordRead.target, target) || recordRead.identity.recordId !== record.recordId) {
        recordReadBlocked = true;
        recordRead = null;
      }
    } catch {
      recordReadBlocked = true;
    }
    const elementPresent =
      target.kind === "element" && recordRead !== null
        ? containsOpaqueId(recordRead.payload, target.elementId)
        : target.kind === "element"
          ? false
          : null;
    return {
      authority,
      target,
      projectKnown,
      pageOwned,
      page,
      record,
      recordRead,
      pageReadBlocked,
      recordReadBlocked,
      elementPresent,
      payloadShapeHash: recordRead === null ? null : shapeHash(recordRead.payload),
      library,
      libraryReadBlocked,
    };
  }

  #findings(context: AuditContext, request: AuditRequest): readonly AuditFinding[] {
    const { target, page, record, recordRead } = context;
    const findings: AuditFinding[] = [];
    const identityHash = targetIdentityHash(target);

    if (requested(request.checks, "identity")) {
      if (!context.projectKnown) {
        findings.push(finding("audit.identity.missing", "blocked", "Exact project identity is absent from the bound inventory."));
      } else if (target.kind === "project") {
        findings.push(finding("audit.identity.ok", "info", "Exact project identity matched the bound inventory.", identityHash));
      } else if (context.pageReadBlocked || page === null || !samePageTarget(page.target, target)) {
        findings.push(finding("audit.identity.blocked", "blocked", "Exact page identity could not be proven by a read-back."));
      } else if (target.kind === "page") {
        findings.push(finding("audit.identity.ok", "info", "Exact page identity matched the editor read-back.", identityHash));
      } else if (record === null || record.recordId !== target.recordId) {
        findings.push(finding("audit.identity.missing", "blocked", "Exact record identity is absent from the page read-back."));
      } else if (target.kind === "record") {
        findings.push(finding("audit.identity.ok", "info", "Exact record identity matched the page read-back.", canonicalHash(safeIdentity(record))));
      } else if (context.elementPresent === true) {
        findings.push(finding("audit.identity.ok", "info", "Exact element identity was found inside the verified record container.", canonicalHash({ recordId: record.recordId, element: "present" })));
      } else {
        findings.push(finding("audit.identity.missing", "blocked", "Exact element identity was not found in the verified record payload."));
      }
    }

    if (requested(request.checks, "ownership")) {
      if (!context.projectKnown) {
        findings.push(finding("audit.ownership.blocked", "blocked", "Project ownership is not present in the bound inventory."));
      } else if (target.kind === "project" || context.pageOwned) {
        findings.push(finding("audit.ownership.ok", "info", "Exact target ownership matched the bound project inventory.", canonicalHash({ projectId: target.projectId, pageOwned: context.pageOwned })));
      } else {
        findings.push(finding("audit.ownership.blocked", "blocked", "Page ownership did not match the bound project inventory."));
      }
    }

    if (requested(request.checks, "structure")) {
      if (!context.projectKnown) {
        findings.push(finding("audit.structure.blocked", "blocked", "Structure cannot be inspected outside the bound inventory."));
      } else if (target.kind === "project") {
        const pageIds = authorityPageIds(context.authority, target.projectId);
        findings.push(finding("audit.structure.ok", "info", `Bound project structure contains ${pageIds.length} pages.`, canonicalHash({ projectId: target.projectId, pageIds })));
      } else if (page === null || context.pageReadBlocked) {
        findings.push(finding("audit.structure.blocked", "blocked", "Page structure could not be read back."));
      } else if (target.kind === "page") {
        findings.push(finding("audit.structure.ok", "info", `Page structure contains ${page.records.length} classified records.`, recordDescriptorHash(page.records)));
      } else if (record === null || recordRead === null || context.recordReadBlocked) {
        findings.push(finding("audit.structure.blocked", "blocked", "Record structure could not be read back through its classified adapter."));
      } else if (target.kind === "record") {
        findings.push(finding("audit.structure.ok", "info", "Record structure was read and reduced to a content-free shape hash.", context.payloadShapeHash ?? undefined));
      } else if (context.elementPresent === true) {
        findings.push(finding("audit.structure.ok", "info", "Element container structure was read and the exact element was found.", context.payloadShapeHash ?? undefined));
      } else {
        findings.push(finding("audit.structure.blocked", "blocked", "Exact element structure could not be proven."));
      }
    }

    if (requested(request.checks, "capability")) {
      if (!context.projectKnown) {
        findings.push(finding("audit.capability.blocked", "blocked", "Capabilities cannot be attributed outside the bound inventory."));
      } else if (target.kind === "project") {
        findings.push(finding("audit.capability.page_required", "warning", "Capability inventory requires an exact page or record target."));
      } else if (page === null || context.pageReadBlocked) {
        findings.push(finding("audit.capability.blocked", "blocked", "Capabilities could not be classified without a page read-back."));
      } else if (target.kind === "page") {
        if (context.libraryReadBlocked || context.library === null) {
          findings.push(finding("audit.capability.blocked", "blocked", "The standard block-library capability index could not be read back."));
        } else {
          const capabilities = pageCapabilities(page);
          const libraryShape = {
            recordFamilies: capabilities,
            categories: context.library.categories.length,
            templates: context.library.templates.length,
          };
          findings.push(finding("audit.capability.ok", "info", `Read-only capability inventory found ${capabilities.length} record families and ${context.library.templates.length} library templates.`, canonicalHash(libraryShape)));
        }
      } else if (record === null || recordRead === null || context.recordReadBlocked) {
        findings.push(finding("audit.capability.blocked", "blocked", "Record capability could not be classified through a verified adapter read."));
      } else if (target.kind === "element" && context.elementPresent !== true) {
        findings.push(finding("audit.capability.blocked", "blocked", "Element capability cannot be inferred without exact element ownership."));
      } else {
        const capabilities = capabilityNames(record.recordCode, recordRead.writableField !== undefined);
        findings.push(finding("audit.capability.ok", "info", `Typed capability inventory found ${capabilities.length} supported paths for the classified record.`, canonicalHash(capabilities)));
      }
    }

    if (requested(request.checks, "revision")) {
      if (target.kind === "project") {
        findings.push(finding("audit.revision.inventory", "info", "Bound inventory hash is the available project-level revision evidence.", context.authority.metadata.inventoryHash.startsWith("sha256:") ? context.authority.metadata.inventoryHash : canonicalHash(context.authority.metadata.inventoryHash)));
      } else if (page === null || context.pageReadBlocked) {
        findings.push(finding("audit.revision.blocked", "blocked", "Revision evidence requires a successful page read-back."));
      } else if (target.kind === "page") {
        findings.push(finding("audit.revision.shape", "warning", "No monotonic editor revision was exposed; page flags and structure hash are available.", canonicalHash({ changed: page.changed, published: page.published, records: page.records.map((item) => item.recordId) })));
      } else if (context.payloadShapeHash === null) {
        findings.push(finding("audit.revision.blocked", "blocked", "Record revision evidence requires a successful classified adapter read."));
      } else {
        findings.push(finding("audit.revision.shape", "warning", "No monotonic editor revision was exposed; a content-free adapter shape hash is available.", context.payloadShapeHash));
      }
    }

    if (requested(request.checks, "publication")) {
      if (target.kind === "project") {
        findings.push(finding("audit.publication.page_required", "warning", "Publication status is page-scoped and requires an exact page target."));
      } else if (page === null || context.pageReadBlocked) {
        findings.push(finding("audit.publication.blocked", "blocked", "Publication status could not be read back."));
      } else {
        const published = page.published !== null && page.published !== "";
        findings.push(finding("audit.publication.ok", "info", `Page publication flag was read; published=${published}.`, canonicalHash({ published })));
      }
    }

    return findings;
  }
}

function authorityPageIds(authority: LoopbackBrowserReadAuthority, projectId: string): readonly string[] {
  return authority.inventory.pageOwnership[projectId] ?? [];
}
