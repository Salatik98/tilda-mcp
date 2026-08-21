import { describe, expect, it } from "vitest";
import {
  isTildaMcpToolName,
  notImplementedResult,
  TILDA_MCP_TOOL_NAMES,
} from "../../src/mcp/protocol.js";
import {
  applyChangeSetInputSchema,
  auditInputSchema,
  authorizeTaskInputSchema,
  changeRequestSchema,
  learnCapabilityInputSchema,
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
      "tilda_authorize_task",
      "tilda_audit",
      "tilda_learn_capability",
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
    expect(isTildaMcpToolName("tilda_authorize_task")).toBe(true);
    expect(isTildaMcpToolName("tilda_learn_capability")).toBe(true);
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
    expect(SERVER_INSTRUCTIONS).toContain("observe, copy-test, or production");
    expect(SERVER_INSTRUCTIONS).toContain("publish and unpublish are separate");
  });

  it("accepts only bounded exact task-authority grants", () => {
    const page = { kind: "page" as const, projectId: "9101", pageId: "9201" };
    const production = authorizeTaskInputSchema.parse({
      taskDescription: "Измени точную страницу, опубликуй и проверь",
      mode: "production",
      observeTargets: [],
      writeTargets: [page],
      allowedOperations: ["page.seo.patch"],
      publication: { actions: ["publish"], targets: [page] },
    });
    expect(production.ttlMs).toBe(15 * 60_000);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      allowedOperations: ["zero.property.patch", "zero.element.clone"],
    }).success).toBe(true);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      mode: "observe",
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      allowedOperations: ["page.seo.patch", "page.seo.patch"],
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      allowedOperations: ["unknown.operation"],
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      ttlMs: 30 * 60_000 + 1,
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      taskDescription: "я".repeat(16 * 1_024),
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      rawTask: "must not be accepted",
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      observeTargets: [{ kind: "project", projectId: page.projectId }],
    }).success).toBe(false);
    expect(authorizeTaskInputSchema.safeParse({
      ...production,
      publication: {
        actions: ["publish"],
        targets: [{ ...page, pageId: "999999999" }],
      },
    }).success).toBe(false);
  });

  it("accepts the proven strict ChangeRequest forms, including full page HEAD replacement", () => {
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
      field: "custom_field:desktop",
    }).success).toBe(true);
    expect(changeRequestSchema.safeParse({
      ...request,
      expectedIdentity: { recordType: "0", recordCode: "TL04" },
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      ...request,
      expectedIdentity: { recordType: "128", recordCode: "tl04" },
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({ ...request, field: "nested.field" }).success).toBe(false);
    expect(changeRequestSchema.safeParse({ ...request, field: "id" }).success).toBe(false);
    expect(changeRequestSchema.safeParse({ ...request, field: "pageid" }).success).toBe(false);

    const head = changeRequestSchema.parse({
      operation: "page.head.code.replace",
      target: {
        kind: "page",
        projectId: "9101",
        pageId: "9201",
      },
      code: "<meta name=\"verified\"><script>void 0;</script>",
    });
    expect(head).toEqual({
      operation: "page.head.code.replace",
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      code: "<meta name=\"verified\"><script>void 0;</script>",
    });
    expect(changeRequestSchema.safeParse({
      operation: "page.head.code.replace",
      target: {
        kind: "record",
        projectId: "9101",
        pageId: "9201",
        recordId: "9301",
      },
      code: "replacement",
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "page.head.code.replace",
      target: { kind: "page", projectId: "9101", pageId: "9201" },
      code: "replacement",
      publish: true,
    }).success).toBe(false);
  });

  it("keeps generic Zero property patches and clones type-safe and bounded", () => {
    const target = {
      kind: "element" as const,
      projectId: "9101",
      pageId: "9201",
      recordId: "9301",
      elementId: "1700000000001",
    };
    expect(changeRequestSchema.parse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "image",
      property: "src",
      expectedPrimitiveKind: "string",
      value: "https://example.invalid/image.webp",
    })).toMatchObject({ operation: "zero.property.patch", property: "src" });
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "shape",
      property: "opacity",
      expectedPrimitiveKind: "number",
      value: 0.5,
    }).success).toBe(true);
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "text",
      property: "hidden",
      expectedPrimitiveKind: "boolean",
      value: false,
    }).success).toBe(true);
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "html",
      property: "placeholder",
      expectedPrimitiveKind: "null",
      value: null,
    }).success).toBe(true);
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "image",
      property: "src",
      expectedPrimitiveKind: "string",
      value: 1,
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "video",
      property: "src",
      expectedPrimitiveKind: "string",
      value: "value",
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "shape",
      property: "elem_id",
      expectedPrimitiveKind: "string",
      value: "1700000000002",
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "zero.property.patch",
      target,
      expectedElementType: "shape",
      property: "nested.field",
      expectedPrimitiveKind: "number",
      value: Number.POSITIVE_INFINITY,
    }).success).toBe(false);

    expect(changeRequestSchema.safeParse({
      operation: "zero.element.clone",
      target,
      expectedElementType: "button",
      offset: { left: 24, top: -12 },
    }).success).toBe(true);
    expect(changeRequestSchema.safeParse({
      operation: "zero.element.clone",
      target,
      expectedElementType: "video",
      offset: { left: 24, top: -12 },
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "zero.element.clone",
      target,
      expectedElementType: "button",
      offset: { left: Number.NaN, top: -12 },
    }).success).toBe(false);
    expect(changeRequestSchema.safeParse({
      operation: "zero.element.clone",
      target,
      expectedElementType: "button",
      offset: { left: 24, top: -12 },
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
    expect(queryInputSchema.safeParse({
      query: {
        kind: "record_control",
        target: {
          kind: "record",
          projectId: "9101",
          pageId: "9201",
          recordId: "9301",
        },
        controlKey: "contentButton",
      },
    }).success).toBe(true);
    expect(queryInputSchema.safeParse({
      query: {
        kind: "record_control",
        target: {
          kind: "record",
          projectId: "9101",
          pageId: "9201",
          recordId: "9301",
        },
        controlKey: "arbitraryButton",
      },
    }).success).toBe(false);

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

  it("keeps audit and capability learning typed and copy-test only", () => {
    const target = { kind: "record" as const, projectId: "9101", pageId: "9201", recordId: "9301" };
    const audit = auditInputSchema.parse({ target });
    expect(audit.checks).toContain("identity");
    expect(auditInputSchema.safeParse({ target, checks: ["identity", "identity"] }).success).toBe(false);

    const plan = learnCapabilityInputSchema.parse({
      mode: "copy-test",
      target,
      targetRole: "test-object",
      capability: "standard.block.clone",
      family: "standard",
      action: "clone",
    });
    expect(plan.dryRun).toBe(true);
    expect(learnCapabilityInputSchema.safeParse({
      ...plan,
      mode: "production",
    }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({
      ...plan,
      capability: "https://example.test/learn",
    }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({
      ...plan,
      target: {
        kind: "element",
        projectId: "9101",
        pageId: "9201",
        recordId: "9305",
        elementId: "javascript:alert(1)",
      },
    }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({
      ...plan,
      script: "globalThis.evil()",
    }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({ ...plan, action: "publish" }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({ ...plan, action: "unpublish" }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({
      ...plan,
      dryRun: false,
    }).success).toBe(false);
    expect(learnCapabilityInputSchema.safeParse({
      ...plan,
      dryRun: false,
      idempotencyKey: "learning-copy-test-1",
    }).success).toBe(true);
  });

  it("accepts only the fixed idempotent page-lifecycle request shape", () => {
    const lifecycle = pageLifecycleInputSchema.parse({
      action: "fixed_roundtrip",
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
