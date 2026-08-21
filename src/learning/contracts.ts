import type { ExactTarget } from "../core/contracts.js";

/**
 * The learner is deliberately a small, typed seam. It describes the intent of
 * one operation, but never accepts a URL, JavaScript, a selector, or a raw
 * request body from an MCP caller.
 */
export const LEARNING_FAMILIES = [
  "project",
  "page",
  "standard",
  "zero",
  "t123",
  "asset",
  "form",
  "catalog",
  "unknown",
] as const;

export type LearningFamily = (typeof LEARNING_FAMILIES)[number];

export const LEARNING_ACTIONS = [
  "inspect",
  "edit",
  "create",
  "clone",
  "move",
  "reorder",
  "delete",
  "configure",
  "publish",
  "unpublish",
] as const;

export type LearningAction = (typeof LEARNING_ACTIONS)[number];

export const LEARNING_TARGET_ROLES = ["copy", "test-object"] as const;
export type LearningTargetRole = (typeof LEARNING_TARGET_ROLES)[number];

export const AUDIT_CHECKS = [
  "identity",
  "ownership",
  "revision",
  "structure",
  "capability",
  "publication",
] as const;

export type AuditCheck = (typeof AUDIT_CHECKS)[number];
export type AuditStatus = "PASS" | "WARN" | "BLOCKED";
export type AuditSeverity = "info" | "warning" | "blocked";

export interface LearnCapabilityRequest {
  readonly mode: "copy-test";
  readonly target: ExactTarget;
  readonly targetRole: LearningTargetRole;
  /** A dotted capability ID, not a URL or executable expression. */
  readonly capability: string;
  readonly family: LearningFamily;
  readonly action: LearningAction;
  readonly dryRun: boolean;
  readonly idempotencyKey?: string;
}

export interface AuditRequest {
  readonly target: ExactTarget;
  readonly checks: readonly AuditCheck[];
}

/** Content-free finding returned by an injected typed audit provider. */
export interface AuditFinding {
  readonly code: string;
  readonly severity: AuditSeverity;
  readonly summary: string;
  readonly evidenceHash?: string;
}

export interface AuditReport {
  readonly format: "tilda-audit-v1";
  readonly target: ExactTarget;
  readonly status: AuditStatus;
  readonly checks: readonly AuditCheck[];
  readonly findings: readonly AuditFinding[];
  readonly adapter: string | null;
  readonly observedAt: string;
}

export type LearningPhase = "before" | "after" | "replay" | "restore";
export type TraceChannel = "dom" | "runtime" | "network";
export type LearningTransport =
  | "authenticated_request"
  | "editor_runtime"
  | "deterministic_dom"
  | "semantic_ui";

/**
 * A sanitized trace receipt. Raw DOM, runtime source, URLs, headers, cookies,
 * payloads, and content are intentionally not representable here.
 */
export interface LearningTrace {
  readonly phase: LearningPhase;
  readonly traceId: string;
  readonly channels: readonly TraceChannel[];
  readonly eventCount: number;
  readonly digest: string;
}

/** One observed state plus the content-free trace for that phase. */
export interface LearningStepEvidence {
  readonly phase: LearningPhase;
  readonly target: ExactTarget;
  readonly targetRole: LearningTargetRole;
  readonly stateHash: string;
  readonly revision?: string;
  readonly changedPaths: readonly string[];
  readonly trace: LearningTrace;
}

export interface CapabilityRecipeTrace {
  readonly phase: LearningPhase;
  readonly traceId: string;
  readonly channels: readonly TraceChannel[];
  readonly eventCount: number;
  readonly digest: string;
}

/**
 * Durable, raw-free recipe registered only after replay and exact restoration
 * have both passed. It is suitable for a local registry or capability report.
 */
export interface CapabilityRecipe {
  readonly format: "tilda-capability-recipe-v1";
  readonly recipeId: string;
  readonly capability: string;
  readonly family: LearningFamily;
  readonly action: LearningAction;
  readonly mode: "copy-test";
  readonly target: ExactTarget;
  readonly targetRole: LearningTargetRole;
  readonly adapterId: string;
  readonly transport: LearningTransport;
  readonly registeredAt: string;
  readonly changedPaths: readonly string[];
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly replayHash: string;
  readonly restoredHash: string;
  readonly traces: readonly CapabilityRecipeTrace[];
}

export interface CapabilityLearningResult {
  readonly ok: boolean;
  readonly code: string;
  readonly summary: string;
  readonly stateChanged: boolean;
  readonly target: ExactTarget;
  readonly capability: string;
  readonly recipe?: CapabilityRecipe;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly blockedReasons?: readonly string[];
}

/** Content-free lineage pinned across one non-dry multi-phase learning run. */
export interface LearningTaskLineage {
  readonly taskId: string;
  readonly grantHash: string;
}

export interface CapabilityLearningExecutionLease {
  readonly kind: "task-execution-lease";
  release(): void;
}

/**
 * Structural subset of TaskAuthorityGuard used by the generic learning
 * workflow. The MCP supplies the current managed guard; tests can inject a
 * bounded fake without coupling the learning package to the authority manager.
 */
export interface CapabilityLearningExecutionAuthority {
  receipt(): LearningTaskLineage;
  assertCopyTestWrite(target: ExactTarget): void;
  beginTaskExecution(): CapabilityLearningExecutionLease;
}

/** The concrete browser/CDP implementation can be added without changing MCP. */
export interface CapabilityLearningSession {
  readonly adapterId: string;
  readonly transport: LearningTransport;
  captureBefore(): Promise<LearningStepEvidence>;
  performTestAction(): Promise<LearningStepEvidence>;
  replayRecipe(): Promise<LearningStepEvidence>;
  restoreBaseline(): Promise<LearningStepEvidence>;
}

export interface CapabilityLearningProvider {
  open(request: LearnCapabilityRequest): Promise<CapabilityLearningSession>;
}

/** Read-only audit transport. It must return content-free typed findings. */
export interface TildaAuditProvider {
  audit(request: AuditRequest): Promise<AuditReport>;
}
