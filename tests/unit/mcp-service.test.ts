import { describe, expect, it, vi } from "vitest";
import type { PublicationController, PublicPageVerifier } from "../../src/core/publication.js";
import type { TildaChangeSetEngine } from "../../src/core/engine.js";
import type { ResearchConfig } from "../../src/research/config.js";
import type { PageLifecycleController } from "../../src/adapters/page-lifecycle.js";
import {
  boundedQueryPayload,
  EngineTildaMcpService,
  MAX_MCP_QUERY_PAYLOAD_BYTES,
} from "../../src/mcp/engine-service.js";

const pageTarget = {
  kind: "page" as const,
  projectId: "9101",
  pageId: "9201",
};

function service(options: {
  publication?: Partial<PublicationController>;
  publicVerifier?: Partial<PublicPageVerifier>;
  pageLifecycle?: Partial<PageLifecycleController>;
} = {}): EngineTildaMcpService {
  const engine = {
    capabilities: () => [
      { adapter: "standard-field-v1", capabilities: ["standard.field.patch"] },
      { adapter: "zero-model-v1", capabilities: ["zero.leaf.patch"] },
    ],
  } as unknown as TildaChangeSetEngine;
  const config = {
    labPageTargets: [{ projectId: pageTarget.projectId, pageId: pageTarget.pageId }],
    publicTestDomains: ["example.test"],
  } as unknown as ResearchConfig;
  return new EngineTildaMcpService(
    config,
    engine,
    options.publication as PublicationController,
    options.publicVerifier as PublicPageVerifier,
    undefined,
    options.pageLifecycle as PageLifecycleController,
  );
}

describe("MCP engine service safety", () => {
  it("reports the current executable adapters and keeps lifecycle unavailable without its transport", async () => {
    const result = await service().execute("tilda_capabilities", {});
    const capabilities = (result.verification?.capabilities ?? []) as Array<Record<string, unknown>>;
    const zero = capabilities.find((entry) => entry.capability === "zero.leaf.patch");
    const publication = capabilities.find((entry) => entry.capability === "page.publish");
    const lifecycle = capabilities.find(
      (entry) => entry.capability === "page.lifecycle.duplicate_verify_reorder_restore_cleanup",
    );

    expect(result).toMatchObject({ ok: true, code: "CAPABILITIES_PARTIAL" });
    expect(zero).toMatchObject({
      status: "AVAILABLE_WITH_FRESH_AUTHORITY",
      executionAvailable: true,
      registeredInEngine: true,
    });
    expect(publication).toMatchObject({
      status: "AVAILABLE_WITH_FRESH_AUTHORITY",
      executionAvailable: true,
    });
    expect(lifecycle).toMatchObject({
      adapter: "page-lifecycle-v1",
      status: "TRANSPORT_UNAVAILABLE",
      executionAvailable: false,
    });
    expect(capabilities.some((entry) => entry.capability === "page.duplicate")).toBe(false);
  });

  it("routes available publication/live verification and still blocks unavailable lifecycle", async () => {
    const publicationExecute = vi.fn(async () => ({
      action: "unpublish" as const,
      target: pageTarget,
      before: { changed: "hash", published: "", pageUrl: "editor", publicUrl: "public" },
      after: { changed: "hash", published: "", pageUrl: "editor", publicUrl: "public" },
      stateChanged: false,
      dryRun: true,
    }));
    const verify = vi.fn(async () => ({
      ok: true,
      url: "https://example.test/",
      status: 200,
      contentType: "text/html",
      responseBytes: 10,
      responseHash: `sha256:${"a".repeat(64)}`,
      title: "Lab",
      canonicalUrl: null,
      recordIds: [],
      cacheBusted: true as const,
    }));
    const lifecycleExecute = vi.fn();
    const mcp = service({
      publication: { execute: publicationExecute },
      publicVerifier: { verify },
    });

    const unpublish = await mcp.execute("tilda_unpublish", {
      target: pageTarget,
      dryRun: true,
      idempotencyKey: "mcp-unpublish-idempotency-1",
    });
    const verifyLive = await mcp.execute("tilda_verify_live", { target: pageTarget });
    const lifecycle = await mcp.execute("tilda_page_lifecycle", {
      target: pageTarget,
      dryRun: true,
      idempotencyKey: "mcp-page-lifecycle-idempotency-1",
    });

    expect(unpublish).toMatchObject({
      ok: true,
      code: "DRY_RUN",
      capability: "page.unpublish",
    });
    expect(verifyLive).toMatchObject({
      ok: true,
      code: "LIVE_VERIFIED",
      capability: "page.verify_live",
    });
    expect(lifecycle).toMatchObject({
      ok: false,
      code: "CAPABILITY_TRANSPORT_UNAVAILABLE",
      capability: "page.lifecycle.duplicate_verify_reorder_restore_cleanup",
    });
    expect(publicationExecute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("https://example.test/");
    expect(lifecycleExecute).not.toHaveBeenCalled();
  });

  it("omits raw query payloads by default and caps explicit payload responses", () => {
    const small = { code: "<section>bounded</section>" };
    expect(boundedQueryPayload(small, false)).toMatchObject({
      included: false,
      reason: "PAYLOAD_OMITTED_BY_DEFAULT",
    });
    expect(boundedQueryPayload(small, true)).toMatchObject({
      included: true,
      payload: small,
    });

    const oversized = { code: "x".repeat(MAX_MCP_QUERY_PAYLOAD_BYTES + 1) };
    expect(boundedQueryPayload(oversized, true)).toMatchObject({
      included: false,
      reason: "PAYLOAD_TOO_LARGE",
    });

    const headCode = "<script>untrusted-head-code</script>";
    expect(boundedQueryPayload(headCode, false)).toMatchObject({
      included: false,
      reason: "PAYLOAD_OMITTED_BY_DEFAULT",
    });
    expect(JSON.stringify(boundedQueryPayload(headCode, false))).not.toContain(headCode);
  });
});
