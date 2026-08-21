import { describe, expect, it, vi } from "vitest";

import {
  AuthorityBoundAdapterSession,
  LoopbackAdapterSessionFactory,
} from "../../src/control/adapter-session-factory.js";
import { TaskAuthorityManager } from "../../src/core/task-authority-manager.js";
import type {
  FixedDispatchReceipt,
  LoopbackBrowserAuthority,
} from "../../src/control/browser-authority.js";

const PAGE = Object.freeze({ kind: "page" as const, projectId: "9101", pageId: "9201" });
const RECORD = Object.freeze({
  kind: "record" as const,
  projectId: PAGE.projectId,
  pageId: PAGE.pageId,
  recordId: "9305",
});
const LAB_PAGE = Object.freeze({ projectId: PAGE.projectId, pageId: PAGE.pageId });
const LAB_RECORD = Object.freeze({ ...LAB_PAGE, recordId: RECORD.recordId });
const STANDARD_RECORD = Object.freeze({
  kind: "record" as const,
  projectId: PAGE.projectId,
  pageId: PAGE.pageId,
  recordId: "9301",
});

function receipt(): FixedDispatchReceipt {
  return {
    operationId: "operation-1",
    dispatched: true,
    ack: "http_ok",
    requestBodyPersisted: false,
  };
}

function authority(): LoopbackBrowserAuthority {
  const adapter = {
    readEditorPage: vi.fn(async () => ({
      uiReady: true,
      host: "tilda.ru",
      route: "/page/",
      href: `https://tilda.ru/page/?pageid=${PAGE.pageId}&projectid=${PAGE.projectId}`,
      authenticated: true,
      target: LAB_PAGE,
      records: [{
        recordId: RECORD.recordId,
        recordType: "396",
        recordCode: "T396",
        recordCategory: "12",
      }],
      changed: "1",
      published: "synthetic-published",
      editorLoadedAnchor: true,
      scriptPaths: [],
    })),
    readStandardSettings: vi.fn(),
    readT123Content: vi.fn(),
    readZeroModel: vi.fn(async () => ({
      target: LAB_RECORD,
      identity: {
        recordId: RECORD.recordId,
        recordType: "396",
        recordCode: "T396",
        recordCategory: "12",
      },
      status: 200,
      contentType: "application/x-tilda-zero-runtime+json",
      payload: {
        cleanElementsData: {
          "0": { elem_id: "1001", type: "text", link: "" },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 1,
          unknownMetadata: { preserve: true },
        },
        zbGrid: {},
      },
    })),
    writeStandard: vi.fn(),
    writeT123: vi.fn(),
    writeZeroModel: vi.fn(async () => receipt()),
    preflightZeroModel: vi.fn(async () => ({ preflight: true as const, code: "READY" as const })),
    readPageSettings: vi.fn(async () => ({
      target: LAB_PAGE,
      fields: [
        ["comm", "savepagesettings"],
        ["pageid", PAGE.pageId],
        ["meta_descr", "before"],
        ["unknown", "preserve"],
      ] as const,
    })),
    writePageSettings: vi.fn(async () => receipt()),
    readPageHeadCode: vi.fn(async () => ({
      uiReady: true,
      host: "tilda.ru",
      route: "/projects/editheadcode/",
      href: `https://tilda.ru/projects/editheadcode/?pageid=${PAGE.pageId}&projectid=${PAGE.projectId}`,
      target: LAB_PAGE,
      code: "<meta name=\"baseline\">",
      saveFunctionHash: "f".repeat(64),
    })),
    writePageHeadCode: vi.fn(async (_target, _code, _expectedCurrentCode) => receipt()),
    revealExactRecordControl: vi.fn(),
    readRenderedBlockLibrary: vi.fn(),
    preflightKnownTemplateAdd: vi.fn(),
    publishPage: vi.fn(async () => receipt()),
    unpublishPage: vi.fn(async () => receipt()),
    runFixedPageLifecycle: vi.fn(),
    createPageFromReference: vi.fn(),
    cleanupReferencePage: vi.fn(),
    addKnownTemplate: vi.fn(),
  };
  return {
    metadata: {
      leaseId: "lease-1",
      sessionId: "session-1",
      cdpTargetId: "session-1",
      acquiredAt: new Date(0).toISOString(),
      expiresAt: new Date(10_000).toISOString(),
      transport: "loopback_cdp",
      accountFingerprint: "a".repeat(64),
      inventoryHash: "b".repeat(64),
    },
    binding: {} as never,
    inventory: {} as never,
    adapter,
    assertFresh: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

describe("authority-bound adapter session", () => {
  it("fails closed before browser acquisition when its configured task manager has no guard", async () => {
    const factory = new LoopbackAdapterSessionFactory(
      {} as never,
      new TaskAuthorityManager(),
    );
    await expect(factory.withSession(async () => undefined)).rejects.toMatchObject({
      code: "TASK_AUTHORITY_REQUIRED",
    });
  });

  it("exposes read-only library discovery and non-dispatching known-template preflight", async () => {
    const browserAuthority = authority();
    vi.mocked(browserAuthority.adapter.readRenderedBlockLibrary).mockResolvedValue({
      target: LAB_PAGE,
      categories: ["Форма", "Попап"],
      templates: [
        { templateId: "702", code: "BF502N", category: "Форма" },
        { templateId: "999", code: "PO999", category: "Попап" },
      ],
      mutationIssued: false,
    });
    vi.mocked(browserAuthority.adapter.preflightKnownTemplateAdd).mockResolvedValue({
      target: LAB_PAGE,
      templateId: "128",
      runtimeFunction: "tp__addRecord",
      runtimeFunctionHash: "19510095bc198f51ed297e2ba02291d9e6d3ebc72da7b0724886af7ff60ae5cc",
      ready: true,
      mutationIssued: false,
      evidence: "LIVE_OBSERVED_PREFLIGHT_ONLY",
    });
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    const library = await session.inspectBlockLibrary(PAGE);
    expect(library.mutationIssued).toBe(false);
    expect(library.templates).toContainEqual(
      expect.objectContaining({ templateId: "702", code: "BF502N" }),
    );
    await expect(session.preflightKnownTemplateAdd(PAGE, "128")).resolves.toMatchObject({
      ready: true,
      mutationIssued: false,
    });
    expect(browserAuthority.adapter.writeStandard).not.toHaveBeenCalled();
  });

  it("inspects a generic standard family and discovers exact string fields", async () => {
    const browserAuthority = authority();
    vi.mocked(browserAuthority.adapter.readStandardSettings).mockResolvedValue({
      target: LAB_RECORD,
      identity: {
        recordId: LAB_RECORD.recordId,
        recordType: "702",
        recordCode: "BF502N",
        recordCategory: "10",
      },
      status: 200,
      contentType: "text/html; charset=utf-8",
      payload: {
        record: {
          id: LAB_RECORD.recordId,
          pageid: LAB_RECORD.pageId,
          formactiontype: "0",
          unknown: { preserve: true },
        },
        tpl: {},
      },
      renderedFields: [
        { name: "title", value: "Rendered title", representation: "rendered_inner_html" },
      ],
    });
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    await expect(session.inspectStandard(STANDARD_RECORD)).resolves.toMatchObject({
      recordType: "702",
      recordCode: "BF502N",
      record: { title: "Rendered title", unknown: { preserve: true } },
      inspection: { patchMechanism: "saverecord_onlythisfield" },
    });
    expect((await session.inspectStandard(STANDARD_RECORD)).inspection.fields)
      .toContainEqual(expect.objectContaining({ name: "title", writable: true }));
    expect(browserAuthority.adapter.writeStandard).not.toHaveBeenCalled();
  });

  it("merges the exact rendered Standard field into the settings snapshot", async () => {
    const browserAuthority = authority();
    vi.mocked(browserAuthority.adapter.readStandardSettings).mockResolvedValue({
      target: {
        projectId: STANDARD_RECORD.projectId,
        pageId: STANDARD_RECORD.pageId,
        recordId: STANDARD_RECORD.recordId,
      },
      identity: {
        recordId: STANDARD_RECORD.recordId,
        recordType: "128",
        recordCode: "TL04",
        recordCategory: "8",
      },
      status: 200,
      contentType: "text/html; charset=utf-8",
      payload: {
        record: {
          id: STANDARD_RECORD.recordId,
          pageid: STANDARD_RECORD.pageId,
          unknown: { preserve: true },
        },
        tpl: {},
      },
      writableField: {
        name: "title",
        value: "exact rendered value",
        representation: "rendered_inner_html",
      },
    });
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    await expect(session.readStandard(STANDARD_RECORD)).resolves.toMatchObject({
      record: {
        title: "exact rendered value",
        unknown: { preserve: true },
      },
      recordType: "128",
      recordCode: "TL04",
    });
  });

  it("treats the reproduced omitted T123 code field as an empty baseline", async () => {
    const browserAuthority = authority();
    const target = { ...STANDARD_RECORD, recordId: "9303" };
    vi.mocked(browserAuthority.adapter.readT123Content).mockResolvedValue({
      target: { projectId: target.projectId, pageId: target.pageId, recordId: target.recordId },
      identity: {
        recordId: target.recordId,
        recordType: "131",
        recordCode: "T123",
        recordCategory: "12",
      },
      status: 200,
      contentType: "text/html; charset=utf-8",
      payload: {
        record: { id: target.recordId, pageid: target.pageId },
        tpl: {},
      },
    });
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    await expect(session.readT123(target)).resolves.toMatchObject({ code: "" });
  });

  it("uses only the clean child-frame Zero model and fixed Zero writer", async () => {
    const browserAuthority = authority();
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    await expect(session.readZero(RECORD)).resolves.toEqual({
      model: {
        "0": { elem_id: "1001", type: "text", link: "" },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: true },
      },
    });
    const intended = {
      "0": { elem_id: "1001", type: "text", link: "changed" },
      groups: { preserve: true },
      meta: { preserve: true },
      timestamp: 1,
      unknownMetadata: { preserve: true },
    };
    await expect(session.writeZero(RECORD, intended)).resolves.toEqual({
      operationId: "operation-1",
      requestDispatched: true,
      acknowledgement: "acknowledged",
      publishObserved: false,
    });
    expect(browserAuthority.adapter.readZeroModel).toHaveBeenCalledWith(LAB_RECORD);
    expect(browserAuthority.adapter.writeZeroModel).toHaveBeenCalledWith(LAB_RECORD, intended);
  });

  it("rejects the premature metadata-only Zero model and legacy array shape", async () => {
    const browserAuthority = authority();
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    vi.mocked(browserAuthority.adapter.readZeroModel).mockResolvedValue({
      ...await browserAuthority.adapter.readZeroModel(LAB_RECORD),
      payload: {
        cleanElementsData: {
          groups: {},
          meta: {},
          timestamp: 1,
        },
        zbGrid: {},
      },
    });
    await expect(session.readZero(RECORD)).rejects.toMatchObject({
      code: "ADAPTER_RESPONSE_REJECTED",
    });

    vi.mocked(browserAuthority.adapter.readZeroModel).mockResolvedValue({
      ...await browserAuthority.adapter.readZeroModel(LAB_RECORD),
      payload: {
        cleanElementsData: [{ elem_id: "1001", type: "text", link: "" }],
        zbGrid: {},
      },
    });
    await expect(session.readZero(RECORD)).rejects.toMatchObject({
      code: "ADAPTER_RESPONSE_REJECTED",
    });
  });

  it("preserves the ordered full page form and binds revision to exact editor globals", async () => {
    const browserAuthority = authority();
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    const data = await session.readPageSettings(PAGE);
    expect(data).toEqual({
      fields: [
        ["comm", "savepagesettings"],
        ["pageid", PAGE.pageId],
        ["meta_descr", "before"],
        ["unknown", "preserve"],
      ],
      changed: "1",
      published: "synthetic-published",
    });
    const readSettings = vi.mocked(browserAuthority.adapter.readPageSettings);
    const readEditor = vi.mocked(browserAuthority.adapter.readEditorPage);
    expect(readSettings.mock.invocationCallOrder[0]).toBeLessThan(
      readEditor.mock.invocationCallOrder[0]!,
    );
    const intended = data.fields.map(([name, value]) =>
      [name, name === "meta_descr" ? "after" : value] as const,
    );
    await expect(session.writePageSettings(PAGE, intended)).resolves.toMatchObject({
      requestDispatched: true,
      acknowledgement: "acknowledged",
    });
    expect(browserAuthority.adapter.writePageSettings).toHaveBeenCalledWith(LAB_PAGE, intended);
  });

  it("maps the exact page HEAD read/write seam and keeps the full code adapter-private", async () => {
    const browserAuthority = authority();
    const session = new AuthorityBoundAdapterSession(browserAuthority);
    await expect(session.readPageHeadCode(PAGE)).resolves.toEqual({
      code: "<meta name=\"baseline\">",
      changed: "1",
      published: "synthetic-published",
    });
    const replacement = "<meta name=\"replacement\"><script>void 0;</script>";
    await expect(session.writePageHeadCode(PAGE, replacement, "<meta name=\"baseline\">")).resolves.toEqual({
      operationId: "operation-1",
      requestDispatched: true,
      acknowledgement: "acknowledged",
      publishObserved: false,
    });
    expect(browserAuthority.adapter.readPageHeadCode).toHaveBeenCalledWith(LAB_PAGE);
    expect(browserAuthority.adapter.writePageHeadCode).toHaveBeenCalledWith(
      LAB_PAGE,
      replacement,
      "<meta name=\"baseline\">",
    );
    expect(browserAuthority.adapter.publishPage).not.toHaveBeenCalled();
  });

  it("binds publication state to pagepublished and the exact editor revision", async () => {
    const browserAuthority = authority();
    const session = new AuthorityBoundAdapterSession(browserAuthority, "example.tilda.ws");
    await expect(session.readPublication(PAGE)).resolves.toMatchObject({
      published: "synthetic-published",
      pageUrl: `https://tilda.ru/page/?pageid=${PAGE.pageId}&projectid=${PAGE.projectId}`,
      publicUrl: "https://example.tilda.ws/",
    });
    const state = await session.readPublication(PAGE);
    expect(state.changed).toBe("1");
    await expect(session.publish(PAGE)).resolves.toMatchObject({
      acknowledgement: "acknowledged",
    });
    await expect(session.unpublish(PAGE)).resolves.toMatchObject({
      acknowledgement: "acknowledged",
    });
    expect(browserAuthority.adapter.publishPage).toHaveBeenCalledWith(LAB_PAGE);
    expect(browserAuthority.adapter.unpublishPage).toHaveBeenCalledWith(LAB_PAGE);
  });
});
