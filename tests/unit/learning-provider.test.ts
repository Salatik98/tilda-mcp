import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResearchConfig } from "../../src/research/config.js";
import type { LoopbackBrowserReadAuthority } from "../../src/control/browser-authority.js";
import { LoopbackTildaAuditProvider } from "../../src/learning/tilda-audit-provider.js";
import { capabilityRecipeKey, FileCapabilityRecipeRegistry } from "../../src/learning/registry.js";
import type { CapabilityRecipe } from "../../src/learning/contracts.js";
import type { ExactTarget } from "../../src/core/contracts.js";

const pageTarget: ExactTarget = {
  kind: "page",
  projectId: "9101",
  pageId: "9201",
};
const pageRef = { projectId: "9101", pageId: "9201" };

const recordTarget: ExactTarget = {
  kind: "record",
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};
const recordRef = { projectId: "9101", pageId: "9201", recordId: "9301" };

const elementTarget: ExactTarget = {
  kind: "element",
  projectId: "9101",
  pageId: "9201",
  recordId: "9305",
  elementId: "1780001",
};
const elementRef = { projectId: "9101", pageId: "9201", recordId: "9305" };

const identity = {
  recordId: "9301",
  recordType: "128",
  recordCode: "TL04",
  recordCategory: "1",
};

const zeroIdentity = {
  recordId: "9305",
  recordType: "396",
  recordCode: "T396",
  recordCategory: "12",
};

const page = {
  uiReady: true,
  host: "tilda.ru",
  route: "/page/",
  href: "https://tilda.ru/page/",
  authenticated: true,
  target: pageRef,
  records: [identity, zeroIdentity],
  changed: "",
  published: "1",
  editorLoadedAnchor: true,
  scriptPaths: [],
};

const config = {
  readOnlyProjectIds: ["9101"],
  labProjectIds: [],
} as unknown as ResearchConfig;

function fakeAuthority(): LoopbackBrowserReadAuthority {
  return {
    metadata: {
      leaseId: "lease",
      sessionId: "session",
      cdpTargetId: "session",
      acquiredAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-20T00:05:00.000Z",
      transport: "loopback_cdp",
      accountFingerprint: "a".repeat(64),
      inventoryHash: "b".repeat(64),
    },
    binding: {} as LoopbackBrowserReadAuthority["binding"],
    inventory: {
      accountFingerprint: "a".repeat(64),
      projectIds: ["9101"],
      pageOwnership: { "9101": ["9201"] },
    },
    reader: {
      readEditorPage: vi.fn(async () => page),
      readRenderedBlockLibrary: vi.fn(async () => ({
        target: pageRef,
        categories: ["Heading"],
        templates: [{ templateId: "128", code: "TL04", category: "Heading" }],
        mutationIssued: false as const,
      })),
      readStandardSettings: vi.fn(async () => ({
        target: recordRef,
        identity,
        status: 200,
        contentType: "text/html",
        payload: { record: { title: "secret-title" }, unknown: { keep: true } },
        writableField: { name: "title", value: "secret-title", representation: "rendered_inner_html" as const },
      })),
      readT123Content: vi.fn(async () => ({
        target: recordRef,
        identity,
        status: 200,
        contentType: "text/html",
        payload: { record: { code: "secret-code" } },
      })),
      readZeroServerRepresentation: vi.fn(async () => ({
        target: elementRef,
        identity: zeroIdentity,
        status: 200,
        contentType: "text/html",
        payload: { elements: { "1780001": { type: "text", text: "secret-zero-text" } } },
      })),
      revealExactRecordControl: vi.fn(async () => ({
        target: recordRef,
        identity,
        controlKey: "contentButton",
        ownerRecordId: recordRef.recordId,
        tagName: "BUTTON",
        connected: true as const,
      })),
      readPageHeadCode: vi.fn(),
    },
    assertFresh: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function recipe(): CapabilityRecipe {
  const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
  return {
    format: "tilda-capability-recipe-v1",
    recipeId: "recipe-file-0001",
    capability: "standard.block.clone",
    family: "standard",
    action: "clone",
    mode: "copy-test",
    target: recordTarget,
    targetRole: "test-object",
    adapterId: "typed-test-adapter",
    transport: "authenticated_request",
    registeredAt: "2026-08-20T00:00:00.000Z",
    changedPaths: ["content.title"],
    beforeHash: hash("a"),
    afterHash: hash("b"),
    replayHash: hash("b"),
    restoredHash: hash("a"),
    traces: ["before", "after", "replay", "restore"].map((phase, index) => ({
      phase: phase as "before" | "after" | "replay" | "restore",
      traceId: `trace-file-${index}`,
      channels: ["dom", "runtime", "network"],
      eventCount: 3,
      digest: hash(String.fromCharCode(97 + index)),
    })),
  };
}

describe("loopback read-only Tilda audit provider", () => {
  it("audits page structure and library capabilities without returning payload content", async () => {
    const authority = fakeAuthority();
    const provider = new LoopbackTildaAuditProvider(config, async (_config, action) => action(authority));
    const report = await provider.audit({
      target: pageTarget,
      checks: ["identity", "ownership", "structure", "capability", "revision", "publication"],
    });

    expect(report).toMatchObject({ format: "tilda-audit-v1", target: pageTarget, adapter: "browser-audit-v1" });
    expect(report.findings.some((item) => item.code === "audit.identity.ok")).toBe(true);
    expect(report.findings.some((item) => item.code === "audit.capability.ok")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret-title");
    expect(JSON.stringify(report)).not.toContain("secret-zero-text");
    expect(authority.reader.readEditorPage).toHaveBeenCalledTimes(1);
    expect(authority.reader.readRenderedBlockLibrary).toHaveBeenCalledTimes(1);
  });

  it("proves an exact Zero element through its parent record without returning raw text", async () => {
    const authority = fakeAuthority();
    const provider = new LoopbackTildaAuditProvider(config, async (_config, action) => action(authority));
    const report = await provider.audit({ target: elementTarget, checks: ["identity", "structure", "capability"] });

    expect(report.status).toBe("PASS");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "audit.identity.ok" }),
      expect.objectContaining({ code: "audit.structure.ok" }),
      expect.objectContaining({ code: "audit.capability.ok" }),
    ]));
    expect(JSON.stringify(report)).not.toContain("secret-zero-text");
  });
});

describe("durable recipe registry", () => {
  it("rejects missing runtime and registry roots below a symlink, junction, or redirected ancestor", () => {
    const base = mkdtempSync(join(tmpdir(), "tilda-recipe-path-"));
    try {
      const redirectedRuntimeTarget = join(base, "redirected-runtime-target");
      mkdirSync(redirectedRuntimeTarget);
      const runtimeLink = join(base, "runtime-link");
      symlinkSync(
        redirectedRuntimeTarget,
        runtimeLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      const missingRuntime = join(runtimeLink, "missing-runtime");
      expect(() => new FileCapabilityRecipeRegistry(
        join(missingRuntime, "recipes"),
        missingRuntime,
      )).toThrowError(expect.objectContaining({ code: "REGISTRY_PATH_UNSAFE" }));
      expect(existsSync(join(redirectedRuntimeTarget, "missing-runtime"))).toBe(false);

      const safeRuntime = join(base, "safe-runtime");
      const redirectedRootTarget = join(base, "redirected-root-target");
      mkdirSync(safeRuntime);
      mkdirSync(redirectedRootTarget);
      const rootLink = join(safeRuntime, "root-link");
      symlinkSync(
        redirectedRootTarget,
        rootLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => new FileCapabilityRecipeRegistry(
        join(rootLink, "missing", "recipes"),
        safeRuntime,
      )).toThrowError(expect.objectContaining({ code: "REGISTRY_PATH_UNSAFE" }));
      expect(existsSync(join(redirectedRootTarget, "missing"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("round-trips sanitized recipes and rejects outside roots or malformed entries", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-runtime-"));
    try {
      const root = join(runtimeRoot, "recipes");
      const registry = new FileCapabilityRecipeRegistry(root, runtimeRoot);
      const value = recipe();
      expect(registry.upsert(value)).toEqual(value);
      const reloaded = new FileCapabilityRecipeRegistry(root, runtimeRoot);
      expect(reloaded.find(value.capability, value.target)).toEqual(value);
      expect(reloaded.list()).toEqual([value]);
      expect(() => new FileCapabilityRecipeRegistry(join(runtimeRoot, "..", "outside"), runtimeRoot)).toThrow(/outside/i);

      const digest = createHash("sha256").update(capabilityRecipeKey(value.capability, value.target)).digest("hex");
      writeFileSync(join(root, `${digest}.json`), "{}", { encoding: "utf8" });
      expect(() => reloaded.list()).toThrow(/invalid|unexpected/i);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
