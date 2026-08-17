import { createHash } from "node:crypto";
import { PageLifecycleController } from "../adapters/page-lifecycle.js";
import { PageHeadCodeAdapter } from "../adapters/page-head-code.js";
import { PageSettingsAdapter } from "../adapters/page-settings.js";
import { StaticAdapterRegistry } from "../adapters/registry.js";
import { StandardFieldAdapter } from "../adapters/standard.js";
import { T123CodeAdapter } from "../adapters/t123.js";
import { ZeroModelAdapter } from "../adapters/zero.js";
import {
  decodeT123Once,
  LoopbackAdapterSessionFactory,
  LoopbackPageLifecycleTransport,
} from "../control/adapter-session-factory.js";
import { withLoopbackBrowserReadAuthority } from "../control/browser-authority.js";
import type { ChangeRequest, ExactTarget, PageTarget } from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";
import { TildaChangeSetEngine } from "../core/engine.js";
import { PublicationController, PublicPageVerifier } from "../core/publication.js";
import { ChangeSetStore } from "../core/store.js";
import { canonicalHash } from "../research/hash.js";
import { captureTrustedLiveBinding } from "../research/inventory.js";
import { loadConfig, type ResearchConfig } from "../research/config.js";
import { getTildaStatus } from "../research/status.js";
import type { TildaMcpResult, TildaMcpTarget, TildaMcpToolName } from "./protocol.js";
import type { TildaMcpService } from "./service.js";

interface QueryInput {
  query:
    | { kind: "project" | "page"; target: ExactTarget }
    | { kind: "page_head_code"; target: ExactTarget; includePayload?: boolean }
    | { kind: "record" | "element"; target: ExactTarget; includePayload?: boolean }
    | { kind: "changeset"; changeSetId: string }
    | { kind: "snapshot"; snapshotId: string };
}

export interface McpRuntimeCapability {
  readonly capability: string;
  readonly adapter: string | null;
  readonly status:
    | "AVAILABLE_WITH_FRESH_AUTHORITY"
    | "TRANSPORT_UNAVAILABLE"
    | "TARGET_BINDING_UNAVAILABLE";
  readonly executionAvailable: boolean;
  readonly reason: string;
}

/**
 * These are transport-composition statuses, not evidence claims. In
 * particular, a class in the adapter registry does not make its browser
 * transport executable.
 */
export const DEFAULT_MCP_RUNTIME_CAPABILITIES: readonly McpRuntimeCapability[] = [
  {
    capability: "standard.field.patch",
    adapter: "standard-field-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback browser authority and allowlisted lab record.",
  },
  {
    capability: "t123.code.replace",
    adapter: "t123-code-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback browser authority and allowlisted lab record.",
  },
  {
    capability: "zero.leaf.patch",
    adapter: "zero-model-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback authority and clean bound T396 child-frame runtime.",
  },
  {
    capability: "zero.responsive.patch",
    adapter: "zero-model-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback authority and the reproduced shape left-res-480 contract.",
  },
  {
    capability: "zero.shape.clone",
    adapter: "zero-model-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback authority and strict appended-shape clone transition.",
  },
  {
    capability: "page.seo.patch",
    adapter: "page-settings-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback authority and full formpageedit meta_descr-only diff.",
  },
  {
    capability: "page.head.code.replace",
    adapter: "page-head-code-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact loopback authority and full page-specific HEAD code replacement.",
  },
  {
    capability: "page.publish",
    adapter: "publication-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact lab page authority, explicit idempotency key, and editor reread reconciliation.",
  },
  {
    capability: "page.unpublish",
    adapter: "publication-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact lab page authority, explicit idempotency key, and editor reread reconciliation.",
  },
  {
    capability: "page.lifecycle.duplicate_verify_reorder_restore_cleanup",
    adapter: "page-lifecycle-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Runs only the fixed duplicate-parity-reorder-restore-temp-cleanup transaction on the exact lab source.",
  },
  {
    capability: "page.verify_live",
    adapter: "public-http-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Executes only when one exact lab page and one exact public HTTPS domain are configured.",
  },
];

export const MAX_MCP_QUERY_PAYLOAD_BYTES = 256_000;
const PAGE_LIFECYCLE_CAPABILITY = "page.lifecycle.duplicate_verify_reorder_restore_cleanup";

/**
 * Raw editor data can contain full T123 code and arbitrary block content.
 * It is omitted unless explicitly requested, and still never exceeds a
 * bounded response suitable for an MCP result.
 */
export function boundedQueryPayload(
  payload: unknown,
  includePayload: boolean,
): Record<string, unknown> {
  let serialized: string;
  try {
    const candidate = JSON.stringify(payload);
    if (candidate === undefined) throw new Error("not JSON serializable");
    serialized = candidate;
  } catch {
    return {
      included: false,
      reason: "PAYLOAD_SERIALIZATION_FAILED",
      bytes: null,
      hash: null,
    };
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const hash = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
  if (!includePayload) {
    return { included: false, reason: "PAYLOAD_OMITTED_BY_DEFAULT", bytes, hash };
  }
  if (bytes > MAX_MCP_QUERY_PAYLOAD_BYTES) {
    return { included: false, reason: "PAYLOAD_TOO_LARGE", bytes, hash };
  }
  return { included: true, bytes, hash, payload };
}

function baseResult(
  overrides: Partial<TildaMcpResult> & Pick<TildaMcpResult, "ok" | "code" | "summary">,
): TildaMcpResult {
  return {
    stateChanged: false,
    target: null,
    capability: null,
    adapter: null,
    snapshotId: null,
    changeSetId: null,
    verification: null,
    diagnosticsRef: null,
    ...overrides,
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TildaEngineError("INVALID_INPUT", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactTarget(value: unknown): TildaMcpTarget | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (typeof target.kind !== "string" || typeof target.projectId !== "string") return null;
  if (target.kind === "project") return { kind: "project", projectId: target.projectId };
  if (typeof target.pageId !== "string") return null;
  if (target.kind === "page") {
    return { kind: "page", projectId: target.projectId, pageId: target.pageId };
  }
  if (typeof target.recordId !== "string") return null;
  if (target.kind === "record") {
    return {
      kind: "record",
      projectId: target.projectId,
      pageId: target.pageId,
      recordId: target.recordId,
    };
  }
  if (target.kind !== "element" || typeof target.elementId !== "string") return null;
  return {
    kind: "element",
    projectId: target.projectId,
    pageId: target.pageId,
    recordId: target.recordId,
    elementId: target.elementId,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof TildaEngineError) return error.code;
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^[A-Z][A-Z0-9_]*$/.test((error as { code: string }).code)
  ) {
    return (error as { code: string }).code;
  }
  return "MCP_OPERATION_FAILED";
}

function safeErrorSummary(error: unknown): string {
  return error instanceof TildaEngineError
    ? error.message
    : "The local Tilda authority blocked or could not complete the operation.";
}

function changeSetResult(
  action: "plan" | "apply" | "verify" | "rollback",
  result: Awaited<ReturnType<TildaChangeSetEngine["plan"]>>,
  engine: TildaChangeSetEngine,
): TildaMcpResult {
  const record = result.changeSet;
  const isDryRun =
    action === "plan" ||
    ((action === "apply" || action === "rollback") && result.dryRun);
  const planHash = canonicalHash({
    changeSetId: record.changeSetId,
    snapshotId: record.snapshotId,
    target: record.target,
    operation: record.operation,
    requestHash: record.requestHash,
    expectedBeforeHash: record.expectedBeforeHash,
    expectedAfterHash: record.expectedAfterHash,
  });
  return baseResult({
    ok: true,
    code:
      isDryRun && action !== "plan"
        ? "DRY_RUN"
        : action === "plan"
          ? "CHANGESET_PLANNED"
          : `CHANGESET_${record.state}`,
    summary: record.summary,
    stateChanged: result.stateChanged,
    target: record.target,
    capability: record.capability,
    adapter: record.adapter,
    snapshotId: record.snapshotId,
    changeSetId: record.changeSetId,
    verification: {
      dryRun: isDryRun,
      expectedBeforeHash: record.expectedBeforeHash,
      expectedAfterHash: record.expectedAfterHash,
      changedPaths: record.changedPaths,
      ...(record.verification === undefined ? {} : { latest: record.verification }),
    },
    planHash,
    operationState: record.state,
    rollbackAvailable: engine.vault.has(record.changeSetId),
  });
}

function targetOf(input: Readonly<Record<string, unknown>>): TildaMcpTarget | null {
  const direct = input.target;
  const request = input.request;
  const query = input.query;
  const value =
    direct ??
    (request !== null && typeof request === "object" && !Array.isArray(request)
      ? (request as Record<string, unknown>).target
      : undefined) ??
    (query !== null && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>).target
      : undefined);
  return exactTarget(value);
}

export class EngineTildaMcpService implements TildaMcpService {
  constructor(
    readonly config: ResearchConfig,
    readonly engine: TildaChangeSetEngine,
    readonly publication: PublicationController,
    readonly publicVerifier: PublicPageVerifier,
    readonly runtimeCapabilities: readonly McpRuntimeCapability[] = DEFAULT_MCP_RUNTIME_CAPABILITIES,
    readonly pageLifecycle: PageLifecycleController | null = null,
  ) {}

  private capabilityStatus(capability: string): McpRuntimeCapability {
    const configured = this.runtimeCapabilities.find((entry) => entry.capability === capability) ?? {
      capability,
      adapter: null,
      status: "TRANSPORT_UNAVAILABLE",
      executionAvailable: false,
      reason: "No executable MCP transport is registered for this capability.",
    };
    if (capability === PAGE_LIFECYCLE_CAPABILITY && this.pageLifecycle === null) {
      return {
        ...configured,
        status: "TRANSPORT_UNAVAILABLE",
        executionAvailable: false,
        reason: "The fixed page-lifecycle transport is not connected to this service instance.",
      };
    }
    return configured;
  }

  private blockedCapability(capability: string, target: TildaMcpTarget | null): TildaMcpResult {
    const status = this.capabilityStatus(capability);
    const code =
      status.status === "TARGET_BINDING_UNAVAILABLE"
        ? "PUBLIC_TARGET_BINDING_UNAVAILABLE"
        : "CAPABILITY_TRANSPORT_UNAVAILABLE";
    return baseResult({
      ok: false,
      code,
      summary: status.reason,
      target,
      capability,
      adapter: status.adapter,
      blockedReasons: [status.status],
    });
  }

  private canExecute(capability: string): boolean {
    return this.capabilityStatus(capability).executionAvailable;
  }

  private capabilityReport(): readonly Record<string, unknown>[] {
    const engineAdapters = this.engine.capabilities();
    const owned = new Map<string, string>();
    for (const adapter of engineAdapters) {
      for (const capability of adapter.capabilities) owned.set(capability, adapter.adapter);
    }
    const reported = this.runtimeCapabilities.map((configured) => {
      const status = this.capabilityStatus(configured.capability);
      return ({
      capability: status.capability,
      adapter: status.adapter ?? owned.get(status.capability) ?? null,
      status: status.status,
      executionAvailable: status.executionAvailable,
      reason: status.reason,
      registeredInEngine: owned.has(status.capability),
      });
    });
    for (const [capability, adapter] of owned) {
      if (reported.some((entry) => entry.capability === capability)) continue;
      reported.push({
        capability,
        adapter,
        status: "TRANSPORT_UNAVAILABLE",
        executionAvailable: false,
        reason: "The adapter is registered but no explicit MCP transport status was supplied.",
        registeredInEngine: true,
      });
    }
    return reported;
  }

  async execute(
    tool: TildaMcpToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<TildaMcpResult> {
    try {
      switch (tool) {
        case "tilda_status": {
          const status = await getTildaStatus(this.config);
          return baseResult({
            ok: status.ok,
            code: status.ok ? "STATUS_OK" : status.error?.code ?? "STATUS_BLOCKED",
            summary: status.ok
              ? "Tilda browser and safety status were read successfully."
              : status.error?.message ?? "Tilda status is blocked.",
            verification: status as unknown as Record<string, unknown>,
            ...(status.ok
              ? {}
              : { blockedReasons: [status.error?.code ?? "STATUS_BLOCKED"] }),
          });
        }
        case "tilda_capabilities":
          return baseResult({
            ok: true,
            code: "CAPABILITIES_PARTIAL",
            summary: "Returned transport-composition status; unavailable transports are not executable.",
            verification: {
              capabilities: this.capabilityReport(),
              reads: {
                projectInventory: "AVAILABLE_WITH_FRESH_AUTHORITY",
                exactLabPageAndRecord: "AVAILABLE_WITH_FRESH_AUTHORITY",
                recordPayload: `OMITTED_BY_DEFAULT; explicit payload is capped at ${MAX_MCP_QUERY_PAYLOAD_BYTES} bytes`,
              },
              scope: "No generic lifecycle operation is exposed. The one fixed page-lifecycle transaction, publication, unpublish, and public verification remain unavailable until their exact transports are connected; every other capability still requires its exact fresh-authority and target gates.",
            },
          });
        case "tilda_query":
          return await this.query(input as unknown as QueryInput);
        case "tilda_plan_changeset": {
          const request = object(input.request, "request") as unknown as ChangeRequest;
          if (!this.canExecute(request.operation)) {
            return this.blockedCapability(request.operation, exactTarget(request.target));
          }
          return changeSetResult("plan", await this.engine.plan(request), this.engine);
        }
        case "tilda_apply_changeset": {
          const changeSetId = String(input.changeSetId ?? "");
          const changeSet = this.engine.store.loadChangeSet(changeSetId);
          if (!this.canExecute(changeSet.capability)) {
            return this.blockedCapability(changeSet.capability, changeSet.target);
          }
          const key = String(input.idempotencyKey ?? "");
          return changeSetResult(
            "apply",
            await this.engine.apply(changeSetId, input.dryRun !== false, key),
            this.engine,
          );
        }
        case "tilda_verify_changeset": {
          const changeSet = this.engine.store.loadChangeSet(String(input.changeSetId ?? ""));
          if (!this.canExecute(changeSet.capability)) {
            return this.blockedCapability(changeSet.capability, changeSet.target);
          }
          return changeSetResult(
            "verify",
            await this.engine.verify(changeSet.changeSetId),
            this.engine,
          );
        }
        case "tilda_rollback_changeset":
          {
            const changeSet = this.engine.store.loadChangeSet(String(input.changeSetId ?? ""));
            if (!this.canExecute(changeSet.capability)) {
              return this.blockedCapability(changeSet.capability, changeSet.target);
            }
          return changeSetResult(
            "rollback",
            await this.engine.rollback(
              changeSet.changeSetId,
              input.dryRun !== false,
              String(input.idempotencyKey ?? ""),
            ),
            this.engine,
          );
          }
        case "tilda_publish":
          return this.publicationAction("publish", input);
        case "tilda_unpublish":
          return this.publicationAction("unpublish", input);
        case "tilda_verify_live":
          return this.verifyLive(input);
        case "tilda_page_lifecycle":
          return this.pageLifecycleAction(input);
      }
    } catch (error) {
      const code = errorCode(error);
      const summary = safeErrorSummary(error);
      return baseResult({
        ok: false,
        code,
        summary,
        target: targetOf(input),
        blockedReasons: [code],
      });
    }
  }

  private async query(input: QueryInput): Promise<TildaMcpResult> {
    const query = input.query;
    if (query.kind === "changeset") {
      const record = this.engine.store.loadChangeSet(query.changeSetId);
      return baseResult({
        ok: true,
        code: "CHANGESET_READ",
        summary: record.summary,
        target: record.target,
        capability: record.capability,
        adapter: record.adapter,
        snapshotId: record.snapshotId,
        changeSetId: record.changeSetId,
        verification: {
          state: record.state,
          expectedBeforeHash: record.expectedBeforeHash,
          expectedAfterHash: record.expectedAfterHash,
          changedPaths: record.changedPaths,
        },
        operationState: record.state,
        rollbackAvailable: this.engine.vault.has(record.changeSetId),
      });
    }
    if (query.kind === "snapshot") {
      const snapshot = this.engine.store.loadSnapshot(query.snapshotId);
      return baseResult({
        ok: true,
        code: "SNAPSHOT_READ",
        summary: snapshot.summary,
        target: snapshot.target,
        adapter: snapshot.adapter,
        snapshotId: snapshot.snapshotId,
        verification: {
          stateHash: snapshot.stateHash,
          capturedAt: snapshot.createdAt,
          ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
        },
      });
    }
    if (query.kind === "project") {
      if (query.target.kind !== "project") {
        throw new TildaEngineError("TARGET_KIND_MISMATCH", "Project query requires a project target.");
      }
      const binding = await captureTrustedLiveBinding(this.config);
      if (binding.status !== "BOUND") {
        throw new TildaEngineError(binding.code, binding.message);
      }
      const pageIds = binding.inventory.pageOwnership[query.target.projectId];
      if (pageIds === undefined) {
        throw new TildaEngineError("PROJECT_NOT_FOUND", "Project is absent from live inventory.");
      }
      return baseResult({
        ok: true,
        code: "PROJECT_READ",
        summary: "Read project/page identity from fresh trusted inventory.",
        target: query.target,
        capability: "project.inventory.read",
        adapter: "trusted-inventory-v1",
        verification: { pageIds, pageCount: pageIds.length },
      });
    }
    const target = query.target;
    if (query.kind === "page" && target.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page query requires a page target.");
    }
    if (query.kind === "page_head_code" && target.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page HEAD query requires a page target.");
    }
    if (query.kind === "record" && target.kind !== "record") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Record query requires a record target.");
    }
    if (query.kind === "element" && target.kind !== "element") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Element query requires an element target.");
    }
    if (target.kind === "project") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page, record, or element target required.");
    }
    return withLoopbackBrowserReadAuthority(this.config, async (authority) => {
      const pageTarget = { projectId: target.projectId, pageId: target.pageId };
      if (query.kind === "page_head_code") {
        const read = await authority.reader.readPageHeadCode(pageTarget);
        return baseResult({
          ok: true,
          code: "PAGE_HEAD_CODE_READ",
          summary: "Read exact classified page-specific HEAD code through the fixed adapter.",
          target,
          capability: "page.head.code.read",
          adapter: "page-head-code-v1",
          verification: {
            payload: boundedQueryPayload(read.code, query.includePayload === true),
            saveFunctionHash: read.saveFunctionHash,
          },
        });
      }
      const page = await authority.reader.readEditorPage(pageTarget);
      if (query.kind === "page") {
        return baseResult({
          ok: true,
          code: "PAGE_READ",
          summary: "Read exact classified live-owned page identity and record order.",
          target,
          capability: "page.read",
          adapter: "browser-authority-v1",
          verification: {
            changed: page.changed,
            published: page.published,
            records: page.records,
          },
        });
      }
      if (target.kind !== "record" && target.kind !== "element") {
        throw new TildaEngineError("TARGET_KIND_MISMATCH", "Record or element target required.");
      }
      const identity = page.records.find((record) => record.recordId === target.recordId);
      if (identity === undefined) {
        throw new TildaEngineError("RECORD_NOT_FOUND", "Exact record was not found on the page.");
      }
      const labRecord = {
        projectId: target.projectId,
        pageId: target.pageId,
        recordId: target.recordId,
      };
      const read =
        identity.recordCode === "T123"
          ? await authority.reader.readT123Content(labRecord)
          : identity.recordCode === "T396"
            ? await authority.reader.readZeroServerRepresentation(labRecord)
            : await authority.reader.readStandardSettings(labRecord);
      const includePayload = "includePayload" in query && query.includePayload === true;
      let decodedT123Code: string | undefined;
      if (includePayload && identity.recordCode === "T123") {
        const payload = object(read.payload, "T123 payload");
        const record = object(payload.record, "T123 record");
        if (Object.hasOwn(record, "code") && typeof record.code !== "string") {
          throw new TildaEngineError("ADAPTER_RESPONSE_REJECTED", "T123 response code is not text.");
        }
        decodedT123Code = decodeT123Once(typeof record.code === "string" ? record.code : "");
      }
      return baseResult({
        ok: true,
        code: query.kind === "element" ? "ELEMENT_CONTAINER_READ" : "RECORD_READ",
        summary: `Read exact ${identity.recordCode} classified live-owned record through its fixed read adapter.`,
        target,
        capability: "record.read",
        adapter: `browser-${identity.recordCode.toLowerCase()}-read-v1`,
        verification: {
          identity: read.identity,
          payload: boundedQueryPayload(
            read.payload,
            includePayload,
          ),
          ...(includePayload && read.writableField !== undefined
            ? { writableField: read.writableField }
            : {}),
          ...(decodedT123Code === undefined ? {} : { decodedCode: decodedT123Code }),
          elementFilter: target.kind === "element" ? target.elementId : null,
        },
      });
    });
  }

  private async publicationAction(
    action: "publish" | "unpublish",
    input: Readonly<Record<string, unknown>>,
  ): Promise<TildaMcpResult> {
    const target = exactTarget(object(input.target, "target"));
    if (target?.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Publication requires an exact page target.");
    }
    const capability = `page.${action}`;
    if (!this.canExecute(capability)) {
      return this.blockedCapability(capability, target);
    }
    const result = await this.publication.execute(action, target, {
      dryRun: input.dryRun !== false,
      ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return baseResult({
      ok: true,
      code: result.dryRun ? "DRY_RUN" : action === "publish" ? "PAGE_PUBLISHED" : "PAGE_UNPUBLISHED",
      summary: `${action} ${result.dryRun ? "plan" : "editor reread"} completed for the exact lab page.`,
      stateChanged: result.stateChanged,
      target,
      capability,
      adapter: "publication-v1",
      verification: { before: result.before, after: result.after, dryRun: result.dryRun },
    });
  }

  private async pageLifecycleAction(
    input: Readonly<Record<string, unknown>>,
  ): Promise<TildaMcpResult> {
    const target = exactTarget(object(input.target, "target"));
    if (target?.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page lifecycle requires an exact page target.");
    }
    if (!this.canExecute(PAGE_LIFECYCLE_CAPABILITY)) {
      return this.blockedCapability(PAGE_LIFECYCLE_CAPABILITY, target);
    }
    if (this.pageLifecycle === null) {
      return baseResult({
        ok: false,
        code: "CAPABILITY_TRANSPORT_UNAVAILABLE",
        summary: "The fixed page-lifecycle transport is not connected to the browser authority.",
        target,
        capability: PAGE_LIFECYCLE_CAPABILITY,
        adapter: "page-lifecycle-v1",
        blockedReasons: ["TRANSPORT_UNAVAILABLE"],
      });
    }
    const result = await this.pageLifecycle.execute({
      target,
      idempotencyKey: String(input.idempotencyKey ?? ""),
      dryRun: input.dryRun !== false,
    });
    return baseResult({
      ok: true,
      code: result.dryRun ? "DRY_RUN" : "PAGE_LIFECYCLE_RESTORED",
      summary: result.dryRun
        ? "The fixed page lifecycle transaction was dry-run only; no remote action was attempted."
        : "The fixed page lifecycle transaction proved duplicate cleanup and exact source-page restoration.",
      stateChanged: result.stateChanged,
      target,
      capability: PAGE_LIFECYCLE_CAPABILITY,
      adapter: "page-lifecycle-v1",
      snapshotId: result.snapshotId,
      changeSetId: result.changeSetId,
      verification: {
        transaction: "duplicate_verify_reorder_restore_cleanup",
        dryRun: result.dryRun,
        baseline: result.baseline,
        restored: result.restored,
      },
      rollbackAvailable: false,
    });
  }

  private async verifyLive(input: Readonly<Record<string, unknown>>): Promise<TildaMcpResult> {
    const target = exactTarget(object(input.target, "target"));
    if (target?.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Live verification requires an exact page target.");
    }
    if (!this.canExecute("page.verify_live")) {
      return this.blockedCapability("page.verify_live", target);
    }
    const configuredTargets = this.config.labPageTargets;
    const domain = this.config.publicTestDomains?.[0];
    if (
      configuredTargets === null ||
      configuredTargets.length !== 1 ||
      configuredTargets[0]?.projectId !== target.projectId ||
      configuredTargets[0]?.pageId !== target.pageId ||
      this.config.publicTestDomains === null ||
      this.config.publicTestDomains.length !== 1 ||
      domain === undefined
    ) {
      return baseResult({
        ok: false,
        code: "PUBLIC_TARGET_BINDING_UNAVAILABLE",
        summary: "Live verification requires one explicit configured lab-page and public-domain binding.",
        target,
        capability: "page.verify_live",
        adapter: "public-http-v1",
        blockedReasons: ["TARGET_BINDING_UNAVAILABLE"],
      });
    }
    const result = await this.publicVerifier.verify(`https://${domain}/`);
    return baseResult({
      ok: result.ok,
      code: result.ok ? "LIVE_VERIFIED" : "LIVE_VERIFICATION_FAILED",
      summary: result.ok ? "Public lab page passed bounded cache-busted verification." : "Public lab page was not healthy.",
      target,
      capability: "page.verify_live",
      adapter: "public-http-v1",
      verification: result as unknown as Record<string, unknown>,
    });
  }
}

export function createDefaultTildaMcpService(): EngineTildaMcpService {
  const config = loadConfig();
  const sessions = new LoopbackAdapterSessionFactory(config);
  const registry = new StaticAdapterRegistry([
    new StandardFieldAdapter(sessions),
    new T123CodeAdapter(sessions),
    new ZeroModelAdapter(sessions),
    new PageSettingsAdapter(sessions),
    new PageHeadCodeAdapter(sessions),
  ]);
  const engine = new TildaChangeSetEngine(registry, new ChangeSetStore());
  const domains = config.publicTestDomains ?? [];
  return new EngineTildaMcpService(
    config,
    engine,
    new PublicationController(sessions),
    new PublicPageVerifier(domains),
    undefined,
    new PageLifecycleController(new LoopbackPageLifecycleTransport(config)),
  );
}
