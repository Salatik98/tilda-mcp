import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PageLifecycleController } from "../adapters/page-lifecycle.js";
import { PageHeadCodeAdapter } from "../adapters/page-head-code.js";
import { PageSettingsAdapter } from "../adapters/page-settings.js";
import { StaticAdapterRegistry } from "../adapters/registry.js";
import { StandardFieldAdapter } from "../adapters/standard.js";
import { T123CodeAdapter } from "../adapters/t123.js";
import { extractT123ExternalDependencies } from "../adapters/t123-code-helper.js";
import { ZeroModelAdapter } from "../adapters/zero.js";
import {
  KnownTemplateAddController,
  ReferencePageLifecycleController,
  type KnownTemplateId,
  type ReferencePageReceipt,
} from "../adapters/reference-page-lifecycle.js";
import {
  decodeT123Once,
  LoopbackAdapterSessionFactory,
  LoopbackKnownTemplateAddTransport,
  LoopbackPageLifecycleTransport,
  LoopbackReferencePageTransport,
} from "../control/adapter-session-factory.js";
import { withLoopbackBrowserReadAuthority } from "../control/browser-authority.js";
import type { ChangeOperation, ChangeRequest, ExactTarget, PageTarget } from "../core/contracts.js";
import { CHANGE_OPERATIONS, TildaEngineError } from "../core/contracts.js";
import { TildaChangeSetEngine } from "../core/engine.js";
import { PublicationController, PublicPageVerifier } from "../core/publication.js";
import { ChangeSetStore } from "../core/store.js";
import { TaskScopedReferencePageLifecycleController } from "../core/task-authority-reference.js";
import {
  TaskAuthorityManager,
  type MintTaskAuthorityInput,
} from "../core/task-authority-manager.js";
import {
  TaskScopedChangeSetEngine,
  TaskScopedPublicationController,
  type TaskAuthorityGuard,
  type TaskPublicationGrant,
} from "../core/task-authority.js";
import { canonicalHash } from "../research/hash.js";
import {
  captureTrustedLiveBinding,
  type TrustedBindingCapture,
  type TrustedBindingEstablished,
} from "../research/inventory.js";
import { loadConfig, type ResearchConfig } from "../research/config.js";
import { getTildaStatus } from "../research/status.js";
import { TypedAuditRunner } from "../learning/audit.js";
import {
  AdapterSessionCapabilityLearningProvider,
  CapabilityLearningWorkflow,
  FileCapabilityLearningExecutionJournal,
  FileCapabilityRecipeRegistry,
  LoopbackTildaAuditProvider,
  type TildaAuditAuthorityRunner,
} from "../learning/index.js";
import type {
  AuditRequest,
  LearnCapabilityRequest,
  TildaAuditProvider,
} from "../learning/contracts.js";
import type { CapabilityLearningWorkflow as LearningWorkflow } from "../learning/workflow.js";
import type { TildaMcpResult, TildaMcpTarget, TildaMcpToolName } from "./protocol.js";
import type { TildaMcpService } from "./service.js";
import {
  executeTargetDiscoveryQuery,
  isTargetDiscoveryQuery,
  type TargetDiscoveryQuery,
} from "./target-discovery-query.js";

interface QueryInput {
  query:
    | TargetDiscoveryQuery
    | { kind: "project" | "page"; target: ExactTarget }
    | { kind: "page_head_code"; target: ExactTarget; includePayload?: boolean }
    | { kind: "record_control"; target: ExactTarget; controlKey: "contentButton" }
    | { kind: "record" | "element"; target: ExactTarget; includePayload?: boolean }
    | { kind: "changeset"; changeSetId: string }
    | { kind: "snapshot"; snapshotId: string };
}

type TrustedBindingCaptureProvider = (
  config: ResearchConfig,
) => Promise<TrustedBindingCapture>;

interface CurrentTaskAuthority {
  readonly guard: TaskAuthorityGuard;
  readonly binding: TrustedBindingEstablished;
}

interface StructuralJournalEntry {
  readonly intentHash: string;
  state: "PENDING" | "SUCCEEDED" | "FAILED";
  result?: TildaMcpResult;
}

function structuralKeyHash(key: string): string {
  return createHash("sha256")
    .update("tilda-mcp-structural-idempotency-v1\0")
    .update(key, "utf8")
    .digest("hex");
}

function exactPageOf(target: ExactTarget): { readonly projectId: string; readonly pageId: string } | null {
  return target.kind === "project"
    ? null
    : { projectId: target.projectId, pageId: target.pageId };
}

function assertDedicatedCopyTestTargets(
  config: ResearchConfig,
  binding: TrustedBindingEstablished,
  targets: readonly ExactTarget[],
): void {
  const labProjects = config.labProjectIds ?? [];
  const labPages = config.labPageTargets ?? [];
  const protectedProjects = config.readOnlyProjectIds ?? [];
  const invalid = targets.some((target) => {
    if (target.kind === "project") {
      return !labProjects.includes(target.projectId) ||
        protectedProjects.includes(target.projectId) ||
        !binding.inventory.projectIds.includes(target.projectId) ||
        binding.inventory.pageOwnership[target.projectId] === undefined;
    }
    const page = exactPageOf(target);
    return page === null ||
      !labProjects.includes(page.projectId) ||
      protectedProjects.includes(page.projectId) ||
      !labPages.some(
        (candidate) => candidate.projectId === page.projectId && candidate.pageId === page.pageId,
      ) ||
      !binding.inventory.projectIds.includes(page.projectId) ||
      !binding.inventory.pageOwnership[page.projectId]?.includes(page.pageId);
  });
  if (targets.length === 0 || invalid) {
    throw new TildaEngineError(
      "TASK_COPY_PROVENANCE_REQUIRED",
      "Copy-test writes require exact configured lab projects/pages present in the fresh bound inventory.",
    );
  }
}

function assertTargetsInFreshInventory(
  binding: TrustedBindingEstablished,
  targets: readonly ExactTarget[],
): void {
  const missing = targets.some((target) => {
    if (!binding.inventory.projectIds.includes(target.projectId)) return true;
    if (target.kind === "project") return false;
    return !binding.inventory.pageOwnership[target.projectId]?.includes(target.pageId);
  });
  if (missing) {
    throw new TildaEngineError(
      "TASK_TARGET_NOT_IN_INVENTORY",
      "Task scopes must belong to the fresh bound project/page inventory.",
    );
  }
}

function assertWriteTargetsOutsidePermanentSourceCorpus(
  config: ResearchConfig,
  targets: readonly ExactTarget[],
): void {
  if (targets.length === 0) return;
  if (config.readOnlyProjectIds === null) {
    throw new TildaEngineError(
      "TASK_SOURCE_CLASSIFICATION_REQUIRED",
      "Write authority is unavailable until the permanent read-only source corpus is configured.",
    );
  }
  if (targets.some((target) => config.readOnlyProjectIds?.includes(target.projectId))) {
    throw new TildaEngineError(
      "TASK_SOURCE_READ_ONLY",
      "A permanent source-corpus project cannot be included in task write or publication scope.",
    );
  }
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
    capability: "mcp.capability.learning",
    adapter: "adapter-session-learning-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a durable idempotency claim, exact copy-test target, and one pinned task lineage across trace, replay, and restore.",
  },
  {
    capability: "standard.field.patch",
    adapter: "standard-field-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact task authority, bound record identity, snapshot, and reread verification.",
  },
  {
    capability: "t123.code.replace",
    adapter: "t123-code-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires a fresh exact task authority, bound T123 record, snapshot, and reread verification.",
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
    capability: "zero.property.patch",
    adapter: "zero-model-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires fresh exact task authority, expected basic element type, and one existing own primitive field.",
  },
  {
    capability: "zero.element.clone",
    adapter: "zero-model-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires fresh exact task authority, expected basic element type, finite offsets, and clone reread verification.",
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
    reason: "Requires explicit task publication authority for the exact page, an idempotency key, and editor reread reconciliation.",
  },
  {
    capability: "page.unpublish",
    adapter: "publication-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Requires explicit task unpublication authority for the exact page, an idempotency key, and editor reread reconciliation.",
  },
  {
    capability: "page.lifecycle.duplicate_verify_reorder_restore_cleanup",
    adapter: "page-lifecycle-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Runs only the typed duplicate-parity-reorder-restore-temp-cleanup transaction on the exact task-authorized source.",
  },
  {
    capability: "page.reference.clone",
    adapter: "reference-page-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Creates one same-project unpublished reference clone and returns a process-owned cleanup receipt.",
  },
  {
    capability: "page.reference.cleanup",
    adapter: "reference-page-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Removes only the exact unconsumed reference-page receipt created by the active task.",
  },
  {
    capability: "standard.template.add",
    adapter: "known-template-add-v1",
    status: "AVAILABLE_WITH_FRESH_AUTHORITY",
    executionAvailable: true,
    reason: "Adds one reproduced 128, 778, 131, or 396 template and verifies the exact record-set delta.",
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
  readonly #referenceReceipts = new Map<string, ReferencePageReceipt>();
  readonly #structuralJournal = new Map<string, StructuralJournalEntry>();

  constructor(
    readonly config: ResearchConfig,
    readonly engine: TildaChangeSetEngine,
    readonly publication: PublicationController,
    readonly publicVerifier: PublicPageVerifier,
    readonly runtimeCapabilities: readonly McpRuntimeCapability[] = DEFAULT_MCP_RUNTIME_CAPABILITIES,
    readonly pageLifecycle: PageLifecycleController | null = null,
    readonly auditProvider: TildaAuditProvider | null = null,
    readonly learningWorkflow: LearningWorkflow | null = null,
    readonly taskAuthority = new TaskAuthorityManager(),
    readonly captureBinding: TrustedBindingCaptureProvider = captureTrustedLiveBinding,
    readonly referencePages: TaskScopedReferencePageLifecycleController | null = null,
    readonly knownTemplates: KnownTemplateAddController | null = null,
  ) {}

  private capabilityStatus(capability: string): McpRuntimeCapability {
    const configured = this.runtimeCapabilities.find((entry) => entry.capability === capability) ?? {
      capability,
      adapter: null,
      status: "TRANSPORT_UNAVAILABLE",
      executionAvailable: false,
      reason: "No executable MCP transport is registered for this capability.",
    };
    if (
      capability === PAGE_LIFECYCLE_CAPABILITY &&
      !(CHANGE_OPERATIONS as readonly string[]).includes("page.lifecycle")
    ) {
      return {
        ...configured,
        status: "TRANSPORT_UNAVAILABLE",
        executionAvailable: false,
        reason: "The fixed page lifecycle has no typed ChangeOperation authority contract.",
      };
    }
    if (
      capability === "mcp.capability.learning" &&
      (this.learningWorkflow === null || !this.learningWorkflow.executionAvailable())
    ) {
      return {
        ...configured,
        status: "TRANSPORT_UNAVAILABLE",
        executionAvailable: false,
        reason: "Non-dry learning requires both a typed provider and a durable execution journal.",
      };
    }
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
              ...(this.learningWorkflow === null
                ? {}
                : { learnedRecipes: this.learningWorkflow.listRecipes() }),
              reads: {
                projectInventory: "AVAILABLE_WITH_FRESH_AUTHORITY",
                exactLabPageAndRecord: "AVAILABLE_WITH_FRESH_AUTHORITY",
                recordPayload: `OMITTED_BY_DEFAULT; explicit payload is capped at ${MAX_MCP_QUERY_PAYLOAD_BYTES} bytes`,
              },
              scope: "Typed lifecycle, publication, unpublication, and public verification are exposed only when their exact transports report available. Every read or mutation still requires the matching fresh task authority and exact target gate.",
            },
          });
        case "tilda_authorize_task":
          return await this.authorizeTaskAction(input);
        case "tilda_audit":
          return await this.auditAction(input);
        case "tilda_learn_capability":
          return await this.learnCapabilityAction(input);
        case "tilda_query":
          return await this.query(input as unknown as QueryInput);
        case "tilda_plan_changeset": {
          const request = object(input.request, "request") as unknown as ChangeRequest;
          const guard = this.currentTaskGuard();
          guard.assertRequest(request);
          if (!this.canExecute(request.operation)) {
            return this.blockedCapability(request.operation, exactTarget(request.target));
          }
          const scoped = new TaskScopedChangeSetEngine(this.engine, guard);
          return changeSetResult("plan", await scoped.plan(request), this.engine);
        }
        case "tilda_apply_changeset": {
          const changeSetId = String(input.changeSetId ?? "");
          const changeSet = this.engine.store.loadChangeSet(changeSetId);
          const guard = this.currentTaskGuard();
          if (input.dryRun !== false) guard.assertRead(changeSet.target);
          else guard.assertChange(changeSet.operation, changeSet.target);
          if (!this.canExecute(changeSet.capability)) {
            return this.blockedCapability(changeSet.capability, changeSet.target);
          }
          const key = String(input.idempotencyKey ?? "");
          const scoped = new TaskScopedChangeSetEngine(this.engine, guard);
          return changeSetResult(
            "apply",
            await scoped.apply(changeSetId, input.dryRun !== false, key),
            this.engine,
          );
        }
        case "tilda_verify_changeset": {
          const changeSet = this.engine.store.loadChangeSet(String(input.changeSetId ?? ""));
          const guard = this.currentTaskGuard();
          guard.assertRead(changeSet.target);
          if (!this.canExecute(changeSet.capability)) {
            return this.blockedCapability(changeSet.capability, changeSet.target);
          }
          const scoped = new TaskScopedChangeSetEngine(this.engine, guard);
          return changeSetResult(
            "verify",
            await scoped.verify(changeSet.changeSetId),
            this.engine,
          );
        }
        case "tilda_rollback_changeset": {
          const changeSet = this.engine.store.loadChangeSet(String(input.changeSetId ?? ""));
          const guard = this.currentTaskGuard();
          if (input.dryRun !== false) guard.assertRead(changeSet.target);
          else guard.assertRollback(changeSet.operation, changeSet.target);
          if (!this.canExecute(changeSet.capability)) {
            return this.blockedCapability(changeSet.capability, changeSet.target);
          }
          const scoped = new TaskScopedChangeSetEngine(this.engine, guard);
          return changeSetResult(
            "rollback",
            await scoped.rollback(
              changeSet.changeSetId,
              input.dryRun !== false,
              String(input.idempotencyKey ?? ""),
            ),
            this.engine,
          );
        }
        case "tilda_publish":
          return await this.publicationAction("publish", input);
        case "tilda_unpublish":
          return await this.publicationAction("unpublish", input);
        case "tilda_verify_live":
          return await this.verifyLive(input);
        case "tilda_page_lifecycle":
          return await this.pageLifecycleAction(input);
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

  private async authorizeTaskAction(
    input: Readonly<Record<string, unknown>>,
  ): Promise<TildaMcpResult> {
    if (typeof input.taskDescription !== "string") {
      throw new TildaEngineError("INVALID_INPUT", "taskDescription must be bounded text.");
    }
    if (!Array.isArray(input.observeTargets) || !Array.isArray(input.writeTargets)) {
      throw new TildaEngineError("INVALID_INPUT", "Task authority requires exact target arrays.");
    }
    if (!Array.isArray(input.allowedOperations)) {
      throw new TildaEngineError("INVALID_INPUT", "allowedOperations must be an array.");
    }
    const observeTargets = input.observeTargets.map((target) => {
      const parsed = exactTarget(target);
      if (parsed === null) throw new TildaEngineError("TARGET_INVALID", "Invalid observe target.");
      return parsed;
    });
    const writeTargets = input.writeTargets.map((target) => {
      const parsed = exactTarget(target);
      if (parsed === null) throw new TildaEngineError("TARGET_INVALID", "Invalid write target.");
      return parsed;
    });
    let publication: TaskPublicationGrant | undefined;
    if (input.publication !== undefined) {
      const rawPublication = object(input.publication, "publication");
      if (!Array.isArray(rawPublication.actions) || !Array.isArray(rawPublication.targets)) {
        throw new TildaEngineError("INVALID_INPUT", "Publication actions and targets are required.");
      }
      const targets = rawPublication.targets.map((target) => {
        const parsed = exactTarget(target);
        if (parsed?.kind !== "page") {
          throw new TildaEngineError("TARGET_INVALID", "Publication requires exact page targets.");
        }
        return parsed;
      });
      publication = {
        actions: rawPublication.actions as ("publish" | "unpublish")[],
        targets,
      };
    }
    let binding: TrustedBindingCapture;
    try {
      binding = await this.captureBinding(this.config);
    } catch (error) {
      this.taskAuthority.clear();
      throw error;
    }
    if (binding.status !== "BOUND") {
      this.taskAuthority.clear();
      throw new TildaEngineError(binding.code, binding.message);
    }
    assertTargetsInFreshInventory(binding, [
      ...observeTargets,
      ...writeTargets,
      ...(publication?.targets ?? []),
    ]);
    assertWriteTargetsOutsidePermanentSourceCorpus(this.config, [
      ...writeTargets,
      ...(publication?.targets ?? []),
    ]);
    if (input.mode === "copy-test") {
      assertDedicatedCopyTestTargets(this.config, binding, writeTargets);
    }
    const current = this.taskAuthority.currentReceipt();
    if (
      current !== null &&
      (current.accountFingerprint !== binding.accountFingerprint ||
        current.inventoryHash !== binding.inventoryHash)
    ) {
      this.taskAuthority.clear();
    }
    const grantInput: MintTaskAuthorityInput = {
      taskDescription: input.taskDescription,
      mode: input.mode as MintTaskAuthorityInput["mode"],
      observeTargets,
      writeTargets,
      allowedOperations: input.allowedOperations as ChangeOperation[],
      binding: {
        accountFingerprint: binding.accountFingerprint,
        inventoryHash: binding.inventoryHash,
      },
      inventory: binding.inventory,
      ...(publication === undefined ? {} : { publication }),
      ...(typeof input.ttlMs === "number" ? { ttlMs: input.ttlMs } : {}),
    };
    const receipt = this.taskAuthority.currentGuard() === null
      ? this.taskAuthority.mint(grantInput)
      : this.taskAuthority.replace(grantInput);
    return baseResult({
      ok: true,
      code: "TASK_AUTHORIZED",
      summary: `Activated one ${receipt.mode} task authority until ${receipt.expiresAt}.`,
      stateChanged: true,
      capability: "task.authority",
      adapter: "task-authority-v1",
      verification: { authority: receipt },
    });
  }

  private currentTaskGuard(): TaskAuthorityGuard {
    return this.taskAuthority.requireGuard();
  }

  /** Reserved for operations that do not open their own fresh browser authority. */
  private async freshTaskAuthority(): Promise<CurrentTaskAuthority> {
    const guard = this.taskAuthority.requireGuard();
    const expected = guard.receipt();
    let binding: TrustedBindingCapture;
    try {
      binding = await this.captureBinding(this.config);
    } catch (error) {
      if (this.taskAuthority.currentGuard() === guard) this.taskAuthority.clear();
      throw error;
    }
    if (binding.status !== "BOUND") {
      if (this.taskAuthority.currentGuard() === guard) this.taskAuthority.clear();
      throw new TildaEngineError(binding.code, binding.message);
    }
    if (this.taskAuthority.currentGuard() !== guard) {
      throw new TildaEngineError(
        "TASK_AUTHORITY_CHANGED",
        "Task authority changed while the fresh binding was captured; retry from the new task.",
      );
    }
    if (
      expected.accountFingerprint !== binding.accountFingerprint ||
      expected.inventoryHash !== binding.inventoryHash
    ) {
      this.taskAuthority.clear();
      throw new TildaEngineError(
        "TASK_AUTHORITY_BINDING_MISMATCH",
        "Fresh account or inventory no longer matches the active task authority.",
      );
    }
    return { guard, binding };
  }

  private async auditAction(input: Readonly<Record<string, unknown>>): Promise<TildaMcpResult> {
    const target = exactTarget(object(input.target, "target"));
    if (target === null) {
      throw new TildaEngineError("TARGET_INVALID", "Audit requires one exact typed target.");
    }
    const guard = this.currentTaskGuard();
    guard.assertRead(target);
    const rawChecks = input.checks;
    const checks = Array.isArray(rawChecks) ? rawChecks : [];
    const request = {
      target,
      checks,
    } as unknown as AuditRequest;
    const outcome = await new TypedAuditRunner(this.auditProvider).run(request);
    return baseResult({
      ok: outcome.ok,
      code: outcome.code,
      summary: outcome.summary,
      target,
      capability: "tilda.audit",
      adapter: outcome.report?.adapter ?? null,
      verification: outcome.report === undefined ? null : (outcome.report as unknown as Record<string, unknown>),
      ...(outcome.blockedReasons === undefined ? {} : { blockedReasons: outcome.blockedReasons }),
    });
  }

  private async learnCapabilityAction(input: Readonly<Record<string, unknown>>): Promise<TildaMcpResult> {
    const target = exactTarget(object(input.target, "target"));
    if (target === null) {
      throw new TildaEngineError("TARGET_INVALID", "Capability learning requires one exact typed target.");
    }
    if (input.action === "publish" || input.action === "unpublish") {
      throw new TildaEngineError(
        "LEARNING_PUBLICATION_ACTION_BLOCKED",
        "Publication cannot be learned as a generic capability action; use the separately authorized publication tools.",
      );
    }
    if (this.learningWorkflow === null) {
      return baseResult({
        ok: false,
        code: "LEARNING_PROVIDER_UNAVAILABLE",
        summary: "No copy-test learning workflow is connected; no Tilda operation was attempted.",
        target,
        capability: typeof input.capability === "string" ? input.capability : null,
        blockedReasons: ["LEARNING_PROVIDER_UNAVAILABLE"],
      });
    }
    const request = {
      ...input,
      target,
    } as unknown as LearnCapabilityRequest;
    const guard = this.currentTaskGuard();
    guard.assertCopyTestWrite(target);
    const outcome = await this.learningWorkflow.learn(request, guard);
    return baseResult({
      ok: outcome.ok,
      code: outcome.code,
      summary: outcome.summary,
      stateChanged: outcome.stateChanged,
      target: outcome.target,
      capability: outcome.capability,
      adapter: outcome.recipe?.adapterId ?? null,
      verification: {
        ...(outcome.evidence ?? {}),
        ...(outcome.recipe === undefined ? {} : { recipe: outcome.recipe }),
      },
      ...(outcome.blockedReasons === undefined ? {} : { blockedReasons: outcome.blockedReasons }),
    });
  }

  private async query(input: QueryInput): Promise<TildaMcpResult> {
    const query = input.query;
    if (isTargetDiscoveryQuery(query)) {
      return executeTargetDiscoveryQuery(this.config, query);
    }
    const guard = this.currentTaskGuard();
    if (query.kind === "changeset") {
      const record = this.engine.store.loadChangeSet(query.changeSetId);
      guard.assertRead(record.target);
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
      guard.assertRead(snapshot.target);
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
      guard.assertRead(query.target);
      const authority = await this.freshTaskAuthority();
      const pageIds = authority.binding.inventory.pageOwnership[query.target.projectId];
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
    if (query.kind === "record_control" && target.kind !== "record") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Record-control query requires a record target.");
    }
    if (query.kind === "element" && target.kind !== "element") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Element query requires an element target.");
    }
    if (target.kind === "project") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Page, record, or element target required.");
    }
    guard.assertRead(target);
    return withLoopbackBrowserReadAuthority(this.config, async (browserAuthority) => {
      const pageTarget = { projectId: target.projectId, pageId: target.pageId };
      if (query.kind === "page_head_code") {
        const read = await browserAuthority.reader.readPageHeadCode(pageTarget);
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
      const page = await browserAuthority.reader.readEditorPage(pageTarget);
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
      if (query.kind === "record_control") {
        if (target.kind !== "record") {
          throw new TildaEngineError("TARGET_KIND_MISMATCH", "Record-control query requires a record target.");
        }
        const reveal = await browserAuthority.reader.revealExactRecordControl(
          {
            projectId: target.projectId,
            pageId: target.pageId,
            recordId: target.recordId,
          },
          query.controlKey,
        );
        return baseResult({
          ok: true,
          code: "RECORD_CONTROL_REVEALED",
          summary: "Revealed the hover-only editor control owned by the exact record without clicking or coordinates.",
          target,
          capability: "record.control.reveal",
          adapter: "browser-authority-v1",
          verification: {
            identity: reveal.identity,
            controlKey: reveal.controlKey,
            ownerRecordId: reveal.ownerRecordId,
            tagName: reveal.tagName,
            connected: reveal.connected,
            clicked: false,
            coordinatesUsed: false,
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
          ? await browserAuthority.reader.readT123Content(labRecord)
          : identity.recordCode === "T396"
            ? await browserAuthority.reader.readZeroServerRepresentation(labRecord)
            : await browserAuthority.reader.readStandardSettings(labRecord);
      const includePayload = "includePayload" in query && query.includePayload === true;
      let decodedT123Code: Record<string, unknown> | undefined;
      let t123ExternalDependencies: readonly Record<string, unknown>[] | undefined;
      if (query.kind === "record" && includePayload && identity.recordCode === "T123") {
        const payload = object(read.payload, "T123 payload");
        const record = object(payload.record, "T123 record");
        if (Object.hasOwn(record, "code") && typeof record.code !== "string") {
          throw new TildaEngineError("ADAPTER_RESPONSE_REJECTED", "T123 response code is not text.");
        }
        const decoded = decodeT123Once(typeof record.code === "string" ? record.code : "");
        decodedT123Code = boundedQueryPayload(decoded, true);
        t123ExternalDependencies = extractT123ExternalDependencies(decoded).map(
          ({ url, kind, offset }) => ({ url, kind, offset }),
        );
      }
      const payload = query.kind === "element"
        ? {
            included: false,
            reason: "ELEMENT_CONTAINER_PAYLOAD_OMITTED",
            bytes: null,
            hash: null,
          }
        : boundedQueryPayload(read.payload, includePayload);
      return baseResult({
        ok: true,
        code: query.kind === "element" ? "ELEMENT_CONTAINER_READ" : "RECORD_READ",
        summary: `Read exact ${identity.recordCode} classified live-owned record through its fixed read adapter.`,
        target,
        capability: "record.read",
        adapter: `browser-${identity.recordCode.toLowerCase()}-read-v1`,
        verification: {
          identity: read.identity,
          payload,
          ...(query.kind === "record" && includePayload && read.writableField !== undefined
            ? { writableField: read.writableField }
            : {}),
          ...(decodedT123Code === undefined ? {} : { decodedCode: decodedT123Code }),
          ...(t123ExternalDependencies === undefined
            ? {}
            : {
                externalDependencies: t123ExternalDependencies,
                externalDependencyCount: t123ExternalDependencies.length,
              }),
          elementFilter: target.kind === "element" ? target.elementId : null,
        },
      });
    }, { taskGuard: guard });
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
    const guard = this.currentTaskGuard();
    if (input.dryRun === false) guard.assertPublication(action, target);
    else guard.assertRead(target);
    if (!this.canExecute(capability)) {
      return this.blockedCapability(capability, target);
    }
    const scoped = new TaskScopedPublicationController(this.publication, guard);
    const result = await scoped.execute(action, target, {
      dryRun: input.dryRun !== false,
      ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return baseResult({
      ok: true,
      code: result.dryRun ? "DRY_RUN" : action === "publish" ? "PAGE_PUBLISHED" : "PAGE_UNPUBLISHED",
      summary: `${action} ${result.dryRun ? "plan" : "editor reread"} completed for the exact task-authorized page.`,
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
    const action = String(input.action ?? "");
    const typedOperation = ({
      fixed_roundtrip: "page.lifecycle",
      create_from_reference: "page.reference.clone",
      cleanup_reference: "page.reference.cleanup",
      add_known_template: "standard.template.add",
    } as const)[action as "fixed_roundtrip" | "create_from_reference" | "cleanup_reference" | "add_known_template"];
    if (typedOperation === undefined) {
      throw new TildaEngineError("INVALID_INPUT", "Unsupported page lifecycle action.");
    }
    const guard = this.currentTaskGuard();
    if (input.dryRun !== false) guard.assertRead(target);
    else guard.assertChange(typedOperation, target);
    const dryRun = input.dryRun !== false;

    if (action === "fixed_roundtrip") {
      if (!this.canExecute(PAGE_LIFECYCLE_CAPABILITY) || this.pageLifecycle === null) {
        return this.blockedCapability(PAGE_LIFECYCLE_CAPABILITY, target);
      }
      const result = await this.pageLifecycle.execute({
        target,
        idempotencyKey: String(input.idempotencyKey ?? ""),
        dryRun,
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

    if (action === "create_from_reference") {
      if (this.referencePages === null) return this.blockedCapability(typedOperation, target);
      if (dryRun) {
        this.taskAuthority.assertReferenceLineageReady(target);
        return baseResult({
          ok: true,
          code: "DRY_RUN",
          summary: "Reference-page clone is authorized and ready; no page was created.",
          target,
          capability: typedOperation,
          adapter: "reference-page-v1",
          verification: { action, unpublishedRequired: true, cleanupReceiptRequired: true },
        });
      }
      return this.#runStructuralOnce(input, { action, target }, async () => {
        const created = await this.referencePages!.createPageFromReference(target);
        this.#referenceReceipts.set(created.receipt.receiptId, created.receipt);
        return baseResult({
          ok: true,
          code: "REFERENCE_PAGE_CREATED",
          summary: "Created one same-project unpublished page from the exact reference and verified record-family parity.",
          stateChanged: true,
          target: created.receipt.created,
          capability: typedOperation,
          adapter: "reference-page-v1",
          verification: {
            action,
            receiptId: created.receipt.receiptId,
            source: created.receipt.source,
            created: created.receipt.created,
            sourceRecordCount: created.evidence.sourceRecordIds.length,
            createdRecordCount: created.evidence.createdRecordIds.length,
            recordFamilyParity: true,
            createdUnpublished: true,
          },
          rollbackAvailable: true,
        });
      });
    }

    if (action === "cleanup_reference") {
      if (this.referencePages === null) return this.blockedCapability(typedOperation, target);
      const receiptId = String(input.receiptId ?? "");
      const receipt = this.#referenceReceipts.get(receiptId);
      if (
        receipt === undefined ||
        receipt.source.projectId !== target.projectId ||
        receipt.source.pageId !== target.pageId
      ) {
        throw new TildaEngineError(
          "REFERENCE_RECEIPT_REJECTED",
          "Cleanup requires the unconsumed process-owned receipt for this exact source page.",
        );
      }
      if (dryRun) {
        return baseResult({
          ok: true,
          code: "DRY_RUN",
          summary: "Exact reference-page cleanup receipt is available; no page was removed.",
          target: receipt.created,
          capability: typedOperation,
          adapter: "reference-page-v1",
          verification: { action, receiptId, source: receipt.source, created: receipt.created },
          rollbackAvailable: true,
        });
      }
      return this.#runStructuralOnce(input, { action, target, receiptId }, async () => {
        this.#referenceReceipts.delete(receiptId);
        const cleaned = await this.referencePages!.cleanupCreatedReference(receipt);
        return baseResult({
          ok: true,
          code: "REFERENCE_PAGE_CLEANED",
          summary: "Removed only the receipt-created page and proved the reference source remained present.",
          stateChanged: true,
          target: receipt.created,
          capability: typedOperation,
          adapter: "reference-page-v1",
          verification: {
            action,
            receiptId,
            source: cleaned.source,
            removedPageId: cleaned.removedPageId,
            removedPageAbsent: cleaned.removedPageAbsent,
            activePageCount: cleaned.activePageIds.length,
          },
          rollbackAvailable: false,
        });
      });
    }

    if (this.knownTemplates === null) return this.blockedCapability(typedOperation, target);
    const templateId = String(input.templateId ?? "") as KnownTemplateId;
    if (dryRun) {
      return baseResult({
        ok: true,
        code: "DRY_RUN",
        summary: "Known-template add is authorized and ready; no block was created.",
        target,
        capability: typedOperation,
        adapter: "known-template-add-v1",
        verification: { action, templateId },
      });
    }
    return this.#runStructuralOnce(input, { action, target, templateId }, async () => {
      const receipt = await this.knownTemplates!.add(target, templateId);
      return baseResult({
        ok: true,
        code: "KNOWN_TEMPLATE_ADDED",
        summary: "Added one reproduced standard/T123/Zero template and verified the exact record-set delta.",
        stateChanged: true,
        target: receipt.target,
        capability: typedOperation,
        adapter: "known-template-add-v1",
        verification: {
          action,
          templateId: receipt.templateId,
          recordType: receipt.recordType,
          recordCode: receipt.recordCode,
        },
        rollbackAvailable: false,
      });
    });
  }

  async #runStructuralOnce(
    input: Readonly<Record<string, unknown>>,
    intent: Readonly<Record<string, unknown>>,
    action: () => Promise<TildaMcpResult>,
  ): Promise<TildaMcpResult> {
    const key = structuralKeyHash(String(input.idempotencyKey ?? ""));
    const intentHash = canonicalHash(intent);
    const existing = this.#structuralJournal.get(key);
    if (existing !== undefined) {
      if (existing.intentHash !== intentHash) {
        throw new TildaEngineError("IDEMPOTENCY_CONFLICT", "Structural idempotency key was used for another intent.");
      }
      if (existing.state === "SUCCEEDED" && existing.result !== undefined) {
        return structuredClone(existing.result);
      }
      throw new TildaEngineError(
        "AMBIGUOUS_RETRY_BLOCKED",
        "The structural action is pending or failed ambiguously; reread inventory instead of retrying.",
      );
    }
    const journal: StructuralJournalEntry = { intentHash, state: "PENDING" };
    this.#structuralJournal.set(key, journal);
    try {
      const result = await action();
      journal.state = "SUCCEEDED";
      journal.result = structuredClone(result);
      return result;
    } catch (error) {
      journal.state = "FAILED";
      throw error;
    }
  }

  private async verifyLive(input: Readonly<Record<string, unknown>>): Promise<TildaMcpResult> {
    const target = exactTarget(object(input.target, "target"));
    if (target?.kind !== "page") {
      throw new TildaEngineError("TARGET_KIND_MISMATCH", "Live verification requires an exact page target.");
    }
    const authority = await this.freshTaskAuthority();
    authority.guard.assertRead(target);
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
  const taskAuthority = new TaskAuthorityManager();
  const sessions = new LoopbackAdapterSessionFactory(config, taskAuthority);
  const registry = new StaticAdapterRegistry([
    new StandardFieldAdapter(sessions),
    new T123CodeAdapter(sessions),
    new ZeroModelAdapter(sessions),
    new PageSettingsAdapter(sessions),
    new PageHeadCodeAdapter(sessions),
  ]);
  const engine = new TildaChangeSetEngine(registry, new ChangeSetStore());
  const domains = config.publicTestDomains ?? [];
  const auditRunner: TildaAuditAuthorityRunner = async (auditConfig, action) =>
    withLoopbackBrowserReadAuthority(auditConfig, action, {
      taskGuard: taskAuthority.requireGuard(),
    });
  const auditProvider = new LoopbackTildaAuditProvider(config, auditRunner);
  const learningWorkflow = new CapabilityLearningWorkflow({
    provider: new AdapterSessionCapabilityLearningProvider({ sessions }),
    registry: new FileCapabilityRecipeRegistry(
      resolve(process.cwd(), ".tilda-runtime", "mcp-v1", "learning", "recipes"),
    ),
    journal: new FileCapabilityLearningExecutionJournal(
      resolve(process.cwd(), ".tilda-runtime", "mcp-v1", "learning", "executions"),
    ),
  });
  const referencePages = new TaskScopedReferencePageLifecycleController(
    new ReferencePageLifecycleController(
      new LoopbackReferencePageTransport(config, taskAuthority),
    ),
    taskAuthority,
  );
  const knownTemplates = new KnownTemplateAddController(
    new LoopbackKnownTemplateAddTransport(config, taskAuthority),
  );
  return new EngineTildaMcpService(
    config,
    engine,
    new PublicationController(sessions),
    new PublicPageVerifier(domains),
    undefined,
    new PageLifecycleController(new LoopbackPageLifecycleTransport(config, taskAuthority)),
    auditProvider,
    learningWorkflow,
    taskAuthority,
    captureTrustedLiveBinding,
    referencePages,
    knownTemplates,
  );
}
