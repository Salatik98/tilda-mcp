import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TildaMcpResult } from "./protocol.js";
import { createUnimplementedTildaMcpService, type TildaMcpService } from "./service.js";

export const SERVER_INSTRUCTIONS =
  "Tilda source projects are never writable. Use an exact project/page/record target; plan before apply, then reread and verify. Changes default to dry-run. Publish and unpublish are separate operations and never side effects of editing. Treat missing adapters or failed allowlist/binding checks as blocked; do not retry writes blindly.";

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

const standardIdentitySchema = z.discriminatedUnion("recordType", [
  z.object({ recordType: z.literal("128"), recordCode: z.literal("TL04") }).strict(),
  z.object({ recordType: z.literal("778"), recordCode: z.literal("ST310N") }).strict(),
]);

export const changeRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("standard.field.patch"),
    target: recordTargetSchema,
    expectedIdentity: standardIdentitySchema,
    field: z.enum(["title", "buttontitle"]),
    value: z.string(),
  }).strict().superRefine((value, context) => {
    const isTl04Title = value.expectedIdentity.recordType === "128" && value.field === "title";
    const isSt310nButton = value.expectedIdentity.recordType === "778" && value.field === "buttontitle";
    if (!isTl04Title && !isSt310nButton) {
      context.addIssue({
        code: "custom",
        path: ["field"],
        message: "Only TL04/title and ST310N/buttontitle are proven standard-field patches.",
      });
    }
  }),
  z.object({
    operation: z.literal("t123.code.replace"),
    target: recordTargetSchema,
    code: z.string(),
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
export const pageLifecycleInputSchema = z.object({
  target: pageTargetSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: z.boolean().default(true),
}).strict();
export const verifyLiveInputSchema = z.object({
  target: pageTargetSchema,
}).strict();

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
    { name: "tilda-agent-os", version: "0.2.0-prealpha" },
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
  server.registerTool("tilda_query", {
    description: "Read an exact typed target, ChangeSet, or snapshot.",
    inputSchema: queryInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler(service, "tilda_query"));
  server.registerTool("tilda_plan_changeset", {
    description: "Build a dry-run ChangeSet from one of the six proven typed semantic operations.",
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
    description: "Request separate publication of an exact allowlisted lab page; defaults to dry-run and fails closed without a publication transport.",
    inputSchema: publicationActionInputSchema,
    outputSchema: tildaMcpResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handler(service, "tilda_publish"));
  server.registerTool("tilda_unpublish", {
    description: "Request separate unpublication of an exact allowlisted lab page; defaults to dry-run and fails closed without an unpublish transport.",
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
    description: "Run only the fixed duplicate-verify-reorder-restore-cleanup transaction for one exact lab source page; defaults to dry-run and fails closed without its adapter-owned transport.",
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
