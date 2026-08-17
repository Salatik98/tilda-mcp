import { describe, expect, it } from "vitest";
import {
  isTildaMcpToolName,
  notImplementedResult,
  TILDA_MCP_TOOL_NAMES,
} from "../../src/mcp/protocol.js";
import {
  applyChangeSetInputSchema,
  changeRequestSchema,
  normalizeTildaMcpResult,
  pageLifecycleInputSchema,
  planChangeSetInputSchema,
  publicationActionInputSchema,
  queryInputSchema,
  rollbackChangeSetInputSchema,
  SERVER_INSTRUCTIONS,
  tildaMcpResultSchema,
  verifyLiveInputSchema,
} from "../../src/mcp/server.js";

describe("MCP protocol", () => {
  it("keeps the compact semantic tool surface stable", () => {
    expect(TILDA_MCP_TOOL_NAMES).toEqual([
      "tilda_status",
      "tilda_capabilities",
      "tilda_query",
      "tilda_plan_changeset",
      "tilda_apply_changeset",
      "tilda_verify_changeset",
      "tilda_rollback_changeset",
      "tilda_publish",
      "tilda_unpublish",
      "tilda_verify_live",
      "tilda_page_lifecycle",
    ]);
    expect(isTildaMcpToolName("tilda_apply_changeset")).toBe(true);
    expect(isTildaMcpToolName("save_record")).toBe(false);
  });

  it("returns complete, fail-closed structured results before an engine is injected", () => {
    expect(notImplementedResult("tilda_query", {
      kind: "page",
      projectId: "9101",
      pageId: "9201",
    })).toEqual({
      ok: false,
      code: "NOT_IMPLEMENTED",
      summary: "tilda_query is wired to the MCP surface, but no Tilda control-engine adapter is installed yet.",
      stateChanged: false,
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      capability: null,
      adapter: null,
      snapshotId: null,
      changeSetId: null,
      verification: null,
      diagnosticsRef: "docs/MCP_USAGE.md#current-scope",
      blockedReasons: ["ENGINE_NOT_CONNECTED"],
    });
  });

  it("keeps the initialization guidance self-contained for Codex", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(SERVER_INSTRUCTIONS).toContain("source projects are never writable");
    expect(SERVER_INSTRUCTIONS).toContain("Publish and unpublish are separate");
  });

  it("accepts proven strict ChangeRequest forms, including full page HEAD replacement", () => {
    const request = changeRequestSchema.parse({
      operation: "standard.field.patch",
      target: {
        kind: "record",
        projectId: "9101",
        pageId: "9201",
        recordId: "9301",
      },
      expectedIdentity: { recordType: "128", recordCode: "TL04" },
      field: "title",
      value: "A verified title",
    });
    expect(request.operation).toBe("standard.field.patch");
    expect(planChangeSetInputSchema.parse({ request }).dryRun).toBe(true);
    expect(changeRequestSchema.safeParse({ operation: "unknown.patch", patch: {} }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      ...request,
      expectedIdentity: { recordType: "778", recordCode: "ST310N" },
    }).success).toBe(false);

    const head = changeRequestSchema.parse({
      operation: "page.head.code.replace",
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      code: "<meta name=\"verified\"><script>void 0;</script>",
    });
    expect(head).toEqual({
      operation: "page.head.code.replace",
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      code: "<meta name=\"verified\"><script>void 0;</script>",
    });
    expect(changeRequestSchema.safeParse({
      operation: "page.head.code.replace",
      target: { kind: "record", projectId: "9101", pageId: "9201", recordId: "9301" },
      code: "replacement",
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "page.head.code.replace",
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      code: "replacement",
      publish: true,
    }).success).toBe(false);
  });

  it("requires an exact discriminated query and idempotency keys for mutations", () => {
    expect(queryInputSchema.safeParse({
      query: {
        kind: "record",
        target: {
          kind: "record",
          projectId: "9101",
          pageId: "9201",
          recordId: "9301",
        },
      },
    }).success).toBe(true);
    expect(queryInputSchema.safeParse({
      query: {
        kind: "page",
        target: {
          kind: "record",
          projectId: "9101",
          pageId: "9201",
          recordId: "9301",
        },
      },
    }).success).toBe(false);
    const headQuery = queryInputSchema.parse({
      query: {
        kind: "page_head_code",
        target: { kind: "page", projectId: "9101", pageId: "9201" },
      },
    }).query;
    expect(headQuery).toEqual({
      kind: "page_head_code",
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      includePayload: false,
    });
    expect(queryInputSchema.safeParse({
      query: {
        kind: "page_head_code",
        target: { kind: "record", projectId: "9101", pageId: "9201", recordId: "9301" },
      },
    }).success).toBe(false);
    const recordQuery = queryInputSchema.parse({
      query: {
        kind: "record",
        target: {
          kind: "record",
          projectId: "9101",
          pageId: "9201",
          recordId: "9301",
        },
      },
    }).query;
    expect("includePayload" in recordQuery && recordQuery.includePayload).toBe(false);

    const base = {
      changeSetId: "f72ca258-7a3a-45d0-b4b7-59ae804eb6b8",
      idempotencyKey: "mcp-apply-idempotency-1",
    };
    expect(applyChangeSetInputSchema.parse(base).dryRun).toBe(true);
    expect(rollbackChangeSetInputSchema.parse(base).dryRun).toBe(true);
    expect(applyChangeSetInputSchema.safeParse({ changeSetId: base.changeSetId }).success).toBe(false);
  });

  it("keeps publication/live schemas narrow and rejects invalid service output", () => {
    const publication = publicationActionInputSchema.parse({
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      idempotencyKey: "mcp-publication-idempotency-1",
    });
    expect(publication.dryRun).toBe(true);
    expect(publicationActionInputSchema.safeParse({
      ...publication,
      expectedRevision: "ignored-by-service",
    }).success).toBe(false);
    expect(verifyLiveInputSchema.safeParse({
      target: publication.target,
      expectation: { arbitrary: "input" },
    }).success).toBe(false);

    const malformed = { ...notImplementedResult("tilda_status"), untrustedExtra: true };
    expect(tildaMcpResultSchema.safeParse(malformed).success).toBe(false);
    expect(normalizeTildaMcpResult(malformed)).toMatchObject({
      ok: false,
      code: "MCP_RESULT_CONTRACT_VIOLATION",
      blockedReasons: ["MCP_RESULT_CONTRACT_VIOLATION"],
    });
  });

  it("accepts only the fixed idempotent page-lifecycle request shape", () => {
    const lifecycle = pageLifecycleInputSchema.parse({
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      idempotencyKey: "mcp-page-lifecycle-idempotency-1",
    });
    expect(lifecycle.dryRun).toBe(true);
    expect(pageLifecycleInputSchema.safeParse({
      ...lifecycle,
      target: { kind: "record", projectId: "9101", pageId: "9201", recordId: "9301" },
    }).success).toBe(false);
    expect(pageLifecycleInputSchema.safeParse({
      target: lifecycle.target,
      dryRun: false,
    }).success).toBe(false);
    expect(pageLifecycleInputSchema.safeParse({
      ...lifecycle,
      operation: "delete_page",
    }).success).toBe(false);
  });
});
