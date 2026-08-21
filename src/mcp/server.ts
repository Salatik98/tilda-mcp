import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TildaMcpResult } from "./protocol.js";
import { createUnimplementedTildaMcpService, type TildaMcpService } from "./service.js";
import {
  AUDIT_CHECKS,
  LEARNING_FAMILIES,
  LEARNING_TARGET_ROLES,
} from "../learning/contracts.js";
import { CHANGE_OPERATIONS } from "../core/contracts.js";
import { isSafeStandardContentField } from "../core/standard-field-safety.js";
import {
  DEFAULT_TASK_AUTHORITY_TTL_MS,
  MAX_TASK_AUTHORITY_TTL_MS,
  MAX_TASK_DESCRIPTION_BYTES,
} from "../core/task-authority-manager.js";
import { TASK_AUTHORITY_MODES, taskScopeCovers } from "../core/task-authority.js";

export const SERVER_INSTRUCTIONS =
  "Authorize one bounded observe, copy-test, or production task against exact targets and a fresh account binding. Then query, plan, apply, reread, and verify. Changes default to dry-run; publish and unpublish are separate task flags. Learn only on copy-test objects through typed trace/replay/restore. Treat missing adapters or failed gates as blocked; never retry writes blindly.";

const TILDA_ID = /^[1-9][0-9]*$/;
const CHANGESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tildaIdSchema = z.string().regex(TILDA_ID, "Must be a canonical positive Tilda ID.");
const changeSetIdSchema = z.string().regex(CHANGESET_ID, "Must be a UUID ChangeSet ID.");
const idempotencyKeySchema = z.string()
  .min(8)
  .max(256)
  .refine((value) => value.trim() === value, "Must not have surrounding whitespace.");

export const projectTargetSchema = z.object({
  kind: z.literal("project"),
  projectId: tildaIdSchema,
}).strict();
export const pageTargetSchema = z.object({
  kind: z.literal("page"),
  projectId: tildaIdSchema,
  pageId: tildaIdSchema,
}).strict();
export const recordTargetSchema = z.object({
  kind: z.literal("record"),
  projectId: tildaIdSchema,
  pageId: tildaIdSchema,
  recordId: tildaIdSchema,
}).strict();
export const elementTargetSchema = z.object({
  kind: z.literal("element"),
  projectId: tildaIdSchema,
  pageId: tildaIdSchema,
  recordId: tildaIdSchema,
  elementId: z.string().min(1),
}).strict();
export const exactTargetSchema = z.discriminatedUnion("kind", [
  projectTargetSchema,
  pageTargetSchema,
  recordTargetSchema,
  elementTargetSchema,
]);

const authorityElementTargetSchema = z.object({
  kind: z.literal("element"),
  projectId: tildaIdSchema,
  pageId: tildaIdSchema,
  recordId: tildaIdSchema,
  elementId: tildaIdSchema,
}).strict();
const authorityExactTargetSchema = z.discriminatedUnion("kind", [
  projectTargetSchema,
  pageTargetSchema,
  recordTargetSchema,
  authorityElementTargetSchema,
]);

const standardIdentitySchema = z.object({
  recordType: z.string().regex(/^[1-9]\d{0,31}$/u, "Must be a canonical bounded standard record type."),
  recordCode: z.string().regex(/^[A-Z][A-Z0-9]{1,31}$/u, "Must be a canonical bounded standard record code."),
}).strict();
const canonicalFieldTokenSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u,
  "Must be a canonical bounded field token.",
);
const safeStandardContentFieldSchema = canonicalFieldTokenSchema.refine(
  isSafeStandardContentField,
  "Standard routing, identity, ordering, and control fields cannot be patched.",
);
const basicZeroElementTypeSchema = z.enum(["text", "image", "shape", "button", "html"]);
const zeroPropertySchema = canonicalFieldTokenSchema.refine(
  (property) => !["elem_id", "type", "elem_type"].includes(property),
  "Zero identity and type properties cannot be patched.",
);

export const changeRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("standard.field.patch"),
    target: recordTargetSchema,
    expectedIdentity: standardIdentitySchema,
    field: safeStandardContentFieldSchema,
    value: z.string(),
  }).strict(),
  z.object({
    operation: z.literal("t123.code.replace"),
    target: recordTargetSchema,
    edit: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("full_replace"), code: z.string().max(5_000_000) }).strict(),
      z.object({
        kind: z.literal("replace_once"),
        match: z.string().min(1).max(1_000_000),
        replacement: z.string().max(5_000_000),
      }).strict(),
      z.object({
        kind: z.literal("replace_literals"),
        replacements: z.array(z.object({
          match: z.string().min(1).max(1_000_000),
          replacement: z.string().max(5_000_000),
          expectedMatches: z.number().int().min(1).max(2_048),
        }).strict()).min(1).max(128),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    operation: z.literal("zero.leaf.patch"),
    target: elementTargetSchema,
    path: z.literal("link"),
    value: z.string(),
  }).strict(),
  z.object({
    operation: z.literal("zero.responsive.patch"),
    target: elementTargetSchema,
    path: z.literal("left-res-480"),
    value: z.number().finite(),
  }).strict(),
  z.object({
    operation: z.literal("zero.shape.clone"),
    target: elementTargetSchema,
    offset: z.object({ left: z.number().finite(), top: z.number().finite() }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("zero.property.patch"),
    target: elementTargetSchema,
    expectedElementType: basicZeroElementTypeSchema,
    property: zeroPropertySchema,
    expectedPrimitiveKind: z.enum(["string", "number", "boolean", "null"]),
    value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  }).strict().superRefine((request, context) => {
    const actualKind = request.value === null ? "null" : typeof request.value;
    if (actualKind !== request.expectedPrimitiveKind) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Value must match expectedPrimitiveKind.",
      });
    }
  }),
  z.object({
    operation: z.literal("zero.element.clone"),
    target: elementTargetSchema,
    expectedElementType: basicZeroElementTypeSchema,
    offset: z.object({ left: z.number().finite(), top: z.number().finite() }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("page.seo.patch"),
    target: pageTargetSchema,
    field: z.literal("meta_descr"),
    value: z.string(),
  }).strict(),
  z.object({
    operation: z.literal("page.head.code.replace"),
    target: pageTargetSchema,
    code: z.string().max(1_000_000),
  }).strict(),
]);

export const querySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inventory") }).strict(),
  z.object({ kind: z.literal("page_inventory"), projectId: tildaIdSchema }).strict(),
  z.object({ kind: z.literal("project"), target: projectTargetSchema }).strict(),
  z.object({ kind: z.literal("page"), target: pageTargetSchema }).strict(),
  z.object({
    kind: z.literal("page_head_code"),
    target: pageTargetSchema,
    includePayload: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("record"),
    target: recordTargetSchema,
    includePayload: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("record_control"),
    target: recordTargetSchema,
    controlKey: z.literal("contentButton"),
  }).strict(),
  z.object({
    kind: z.literal("element"),
    target: elementTargetSchema,
    includePayload: z.boolean().default(false),
  }).strict(),
  z.object({ kind: z.literal("changeset"), changeSetId: changeSetIdSchema }).strict(),
  z.object({ kind: z.literal("snapshot"), snapshotId: changeSetIdSchema }).strict(),
]);

export const tildaMcpResultSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  summary: z.string(),
  stateChanged: z.boolean(),
  target: exactTargetSchema.nullable(),
  capability: z.string().nullable(),
  adapter: z.string().nullable(),
  snapshotId: z.string().nullable(),
  changeSetId: z.string().nullable(),
  verification: z.record(z.string(), z.unknown()).nullable(),
  diagnosticsRef: z.string().nullable(),
  planHash: z.string().min(1).optional(),
  operationState: z.enum(["PLANNED", "APPLIED", "VERIFIED", "ROLLED_BACK", "FAILED"]).optional(),
  rollbackAvailable: z.boolean().optional(),
  blockedReasons: z.array(z.string().min(1)).min(1).optional(),
}).strict();

const noInput = z.object({}).strict();
const authorityTargetListSchema = z.array(authorityExactTargetSchema).max(256);
const authorityPublicationSchema = z.object({
  actions: z.array(z.enum(["publish", "unpublish"])).min(1).max(2),
  targets: z.array(pageTargetSchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  if (new Set(value.actions).size !== value.actions.length) {
    context.addIssue({ code: "custom", path: ["actions"], message: "Publication actions must be unique." });
  }
  const targetKeys = value.targets.map((target) => `${target.projectId}:${target.pageId}`);
  if (new Set(targetKeys).size !== targetKeys.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Publication targets must be unique." });
  }
});
export const authorizeTaskInputSchema = z.object({
  taskDescription: z.string()
    .min(1)
    .max(MAX_TASK_DESCRIPTION_BYTES)
    .refine((value) => value.trim().length > 0, "Task description must contain user intent.")
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= MAX_TASK_DESCRIPTION_BYTES,
      `Task description must not exceed ${MAX_TASK_DESCRIPTION_BYTES} UTF-8 bytes.`,
    ),
  mode: z.enum(TASK_AUTHORITY_MODES),
  observeTargets: authorityTargetListSchema,
  writeTargets: authorityTargetListSchema,
  allowedOperations: z.array(z.enum(CHANGE_OPERATIONS)).max(CHANGE_OPERATIONS.length),
  publication: authorityPublicationSchema.optional(),
  ttlMs: z.number().int().min(1).max(MAX_TASK_AUTHORITY_TTL_MS)
    .default(DEFAULT_TASK_AUTHORITY_TTL_MS),
}).strict().superRefine((value, context) => {
  const observeKeys = value.observeTargets.map((target) => JSON.stringify(target));
  const writeKeys = value.writeTargets.map((target) => JSON.stringify(target));
  if (new Set(observeKeys).size !== observeKeys.length) {
    context.addIssue({ code: "custom", path: ["observeTargets"], message: "Observe targets must be unique." });
  }
  if (new Set(writeKeys).size !== writeKeys.length) {
    context.addIssue({ code: "custom", path: ["writeTargets"], message: "Write targets must be unique." });
  }
  if (new Set(value.allowedOperations).size !== value.allowedOperations.length) {
    context.addIssue({ code: "custom", path: ["allowedOperations"], message: "Allowed operations must be unique." });
  }
  if (
    value.observeTargets.some((source) =>
      value.writeTargets.some(
        (destination) =>
          taskScopeCovers(source, destination) || taskScopeCovers(destination, source),
      ),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["writeTargets"],
      message: "Protected observe scopes and writable task scopes must be disjoint.",
    });
  }
  if (
    value.publication?.targets.some(
      (target) => !value.writeTargets.some((scope) => taskScopeCovers(scope, target)),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["publication", "targets"],
      message: "Publication pages must be inside the exact writable task scope.",
    });
  }
  if (
    value.mode === "observe" &&
    (value.observeTargets.length === 0 ||
      value.writeTargets.length !== 0 ||
      value.allowedOperations.length !== 0 ||
      value.publication !== undefined)
  ) {
    context.addIssue({ code: "custom", path: ["mode"], message: "Observe mode must be strictly read-only." });
  }
  if (value.mode === "copy-test" && (value.observeTargets.length === 0 || value.writeTargets.length === 0)) {
    context.addIssue({ code: "custom", path: ["mode"], message: "Copy-test requires protected source and writable copy targets." });
  }
  if (value.mode === "production" && value.writeTargets.length === 0) {
    context.addIssue({ code: "custom", path: ["writeTargets"], message: "Production requires an exact writable target." });
  }
});
export const queryInputSchema = z.object({ query: querySchema }).strict();
export const planChangeSetInputSchema = z.object({
  request: changeRequestSchema,
  dryRun: z.literal(true).default(true),
}).strict();
const changeSetInputSchema = z.object({ changeSetId: changeSetIdSchema }).strict();
export const applyChangeSetInputSchema = z.object({
  changeSetId: changeSetIdSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: z.boolean().default(true),
}).strict();
export const rollbackChangeSetInputSchema = z.object({
  changeSetId: changeSetIdSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: z.boolean().default(true),
}).strict();
export const publicationActionInputSchema = z.object({
  target: pageTargetSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: z.boolean().default(true),
}).strict();
const lifecycleBase = {
  target: pageTargetSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: z.boolean().default(true),
} as const;
export const pageLifecycleInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fixed_roundtrip"), ...lifecycleBase }).strict(),
  z.object({ action: z.literal("create_from_reference"), ...lifecycleBase }).strict(),
  z.object({
    action: z.literal("cleanup_reference"),
    ...lifecycleBase,
    receiptId: changeSetIdSchema,
  }).strict(),
  z.object({
    action: z.literal("add_known_template"),
    ...lifecycleBase,
    templateId: z.enum(["128", "778", "131", "396"]),
  }).strict(),
]);
export const verifyLiveInputSchema = z.object({
  target: pageTargetSchema,
}).strict();
const auditCheckSchema = z.enum(AUDIT_CHECKS);
const capabilityIdSchema = z.string()
  .min(3)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+){1,5}$/, "Must be a bounded dotted capability identifier.");
const learningTargetSchema = exactTargetSchema.superRefine((target, context) => {
  if (target.kind === "element" && !/^[A-Za-z0-9_.-]+$/.test(target.elementId)) {
    context.addIssue({
      code: "custom",
      path: ["elementId"],
      message: "Learning element IDs must be opaque safe identifiers, not URLs or expressions.",
    });
  }
});
const MCP_LEARNING_ACTIONS = [
  "inspect",
  "edit",
  "create",
  "clone",
  "move",
  "reorder",
  "delete",
  "configure",
] as const;
export const auditInputSchema = z.object({
  target: exactTargetSchema,
  checks: z.array(auditCheckSchema).min(1).max(AUDIT_CHECKS.length).default([...AUDIT_CHECKS]),
}).strict().superRefine((value, context) => {
  if (new Set(value.checks).size !== value.checks.length) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Audit checks must be unique." });
  }
});
export const learnCapabilityInputSchema = z.object({
  mode: z.literal("copy-test"),
  target: learningTargetSchema,
  targetRole: z.enum(LEARNING_TARGET_ROLES),
  capability: capabilityIdSchema,
  family: z.enum(LEARNING_FAMILIES),
  action: z.enum(MCP_LEARNING_ACTIONS),
  dryRun: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.dryRun && value.idempotencyKey === undefined) {
    context.addIssue({
      code: "custom",
      path: ["idempotencyKey"],
      message: "A trimmed idempotency key is required when dryRun is false.",
    });
  }
});

function resultContractFailure(): TildaMcpResult {
  return {
    ok: false,
    code: "MCP_RESULT_CONTRACT_VIOLATION",
    summary: "The local MCP service returned an invalid structured result; no operation result is trusted.",
    stateChanged: false,
    target: null,
    capability: null,
    adapter: null,
    snapshotId: null,
    changeSetId: null,
    verification: null,
    diagnosticsRef: "MCP_RESULT_CONTRACT_VIOLATION",
    blockedReasons: ["MCP_RESULT_CONTRACT_VIOLATION"],
  };
}

function serviceFailure(): TildaMcpResult {
  return {
    ok: false,
    code: "MCP_SERVICE_FAILURE",
    summary: "The local MCP service could not complete the request; no operation result is trusted.",
    stateChanged: false,
    target: null,
    capability: null,
    adapter: null,
    snapshotId: null,
    changeSetId: null,
    verification: null,
    diagnosticsRef: "MCP_SERVICE_FAILURE",
    blockedReasons: ["MCP_SERVICE_FAILURE"],
  };
}

export function normalizeTildaMcpResult(result: unknown): TildaMcpResult {
  const parsed = tildaMcpResultSchema.safeParse(result);
  return parsed.success ? parsed.data : resultContractFailure();
}

function asToolResult(result: unknown) {
  const output = normalizeTildaMcpResult(result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
    isError: !output.ok,
  };
}

function handler(
  service: TildaMcpService,
  tool: Parameters<TildaMcpService["execute"]>[0],
) {
  return async (input: Record<string, unknown> = {}) => {
    try {
      return asToolResult(await service.execute(tool, input));
    } catch {
      return asToolResult(serviceFailure());
    }
  };
}

/** Builds the semantic MCP server; callers inject a real control engine at composition time. */
export function createTildaMcpServer(service: TildaMcpService = createUnimplementedTildaMcpService()): McpServer {
  const server = new McpServer(
    { name: "tilda-agent-os", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool("tilda_status", {
    description: "Read current local Tilda connectivity and safety status.",
    inputSchema: noInput,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_status"));
  server.registerTool("tilda_capabilities", {
    description: "Read supported semantic capabilities and their evidence state.",
    inputSchema: noInput,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_capabilities"));
  server.registerTool("tilda_authorize_task", {
    description: "Mint or replace one short-lived task authority from bounded user intent, exact scopes, typed operations, and a fresh account binding; returns digests only.",
    inputSchema: authorizeTaskInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handler(service, "tilda_authorize_task"));
  server.registerTool("tilda_audit", {
    description: "Run a typed, read-only audit of one exact Tilda target's identity, structure, and capability gates.",
    inputSchema: auditInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_audit"));
  server.registerTool("tilda_learn_capability", {
    description: "Plan or execute one bounded copy-test capability-learning run under a durable idempotency claim, exact-target quarantine, pinned task lineage, replay, and exact restore; arbitrary JS and URLs are never accepted.",
    inputSchema: learnCapabilityInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_learn_capability"));
  server.registerTool("tilda_query", {
    description: "Read an exact typed target, ChangeSet, or snapshot.",
    inputSchema: queryInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_query"));
  server.registerTool("tilda_plan_changeset", {
    description: "Build a dry-run ChangeSet from one current typed semantic operation.",
    inputSchema: planChangeSetInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handler(service, "tilda_plan_changeset"));
  server.registerTool("tilda_apply_changeset", {
    description: "Apply a reviewed ChangeSet only when dryRun is explicitly false and engine gates pass.",
    inputSchema: applyChangeSetInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_apply_changeset"));
  server.registerTool("tilda_verify_changeset", {
    description: "Reread and verify an applied or rolled-back ChangeSet.",
    inputSchema: changeSetInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handler(service, "tilda_verify_changeset"));
  server.registerTool("tilda_rollback_changeset", {
    description: "Restore an exact ChangeSet snapshot when its rollback gate permits it.",
    inputSchema: rollbackChangeSetInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_rollback_changeset"));
  server.registerTool("tilda_publish", {
    description: "Request separate publication of an exact task-authorized page; defaults to dry-run and requires an explicit publication grant.",
    inputSchema: publicationActionInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handler(service, "tilda_publish"));
  server.registerTool("tilda_unpublish", {
    description: "Request separate unpublication of an exact task-authorized page; defaults to dry-run and requires an explicit unpublication grant.",
    inputSchema: publicationActionInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, handler(service, "tilda_unpublish"));
  server.registerTool("tilda_verify_live", {
    description: "Verify a public result only after an exact lab-page-to-public-URL binding is available; otherwise fail closed.",
    inputSchema: verifyLiveInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, handler(service, "tilda_verify_live"));
  server.registerTool("tilda_page_lifecycle", {
    description: "Create/cleanup an exact page from a reference, add one reproduced template, or run the fixed lifecycle roundtrip; all actions default to dry-run and use adapter-owned receipts.",
    inputSchema: pageLifecycleInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_page_lifecycle"));

  return server;
}

export async function runTildaMcpStdio(service?: TildaMcpService): Promise<void> {
  const server = createTildaMcpServer(service);
  await server.connect(new StdioServerTransport());
}
