import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import type { ChangeOperation, ExactTarget, PageTarget } from "../../src/core/contracts.js";
import {
  TaskAuthorityGuard,
  type TaskAuthorityGrant,
  type TaskPublicationGrant,
} from "../../src/core/task-authority.js";
import {
  TaskAuthorityManager,
  type MintTaskAuthorityInput,
} from "../../src/core/task-authority-manager.js";

import {
  acquireLoopbackBrowserReadAuthority,
  acquireLoopbackBrowserAuthority,
  BrowserAuthorityError,
  withLoopbackBrowserAuthority,
  type LoopbackBrowserAuthorityDependencies,
} from "../../src/control/browser-authority.js";
import type {
  AuthorityOwnedLoopbackBrowserSession,
  ExactEditorPageSnapshot,
  ExactEditorRecordRead,
  ExactPageHeadCodeRead,
} from "../../src/research/browser-session.js";
import {
  hasExactRecordWriteApplicationAck,
  isReadyExactEditorPageSnapshot,
} from "../../src/research/browser-session.js";
import {
  hashLiveInventory,
  type LiveInventory,
  type ResearchConfig,
} from "../../src/research/config.js";
import type {
  TrustedBindingCapture,
  TrustedBindingEstablished,
} from "../../src/research/inventory.js";
import { captureTrustedLiveBindingWithSession } from "../../src/research/inventory.js";
const ROOT_TARGET = Object.freeze({
  id: "root-1",
  type: "page",
  title: "Projects",
  url: "https://tilda.ru/projects/",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/root-1",
});

const SOURCE_PAGE = Object.freeze({ projectId: "10001", pageId: "10011" });
const LAB_PAGE = Object.freeze({ projectId: "9101", pageId: "9201" });
const LAB_RECORD = Object.freeze({ ...LAB_PAGE, recordId: "9301" });

function taskGuard(
  binding: Pick<TrustedBindingEstablished, "accountFingerprint" | "inventoryHash">,
  fields: {
    readonly mode?: "observe" | "production";
    readonly observeTargets?: readonly ExactTarget[];
    readonly writeTargets?: readonly ExactTarget[];
    readonly allowedOperations?: readonly ChangeOperation[];
    readonly publication?: TaskPublicationGrant;
    readonly isRevoked?: () => boolean;
  },
): TaskAuthorityGuard {
  const grant: TaskAuthorityGrant = {
    format: "tilda-mcp-task-authority-v1",
    taskId: "00000000-0000-4000-8000-000000000001",
    mode: fields.mode ?? "production",
    instructionHash: `sha256:${"1".repeat(64)}`,
    issuedAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "1970-01-01T00:10:00.000Z",
    accountBinding: {
      accountFingerprint: binding.accountFingerprint,
      inventoryHash: binding.inventoryHash,
    },
    observeTargets: fields.observeTargets ?? [],
    writeTargets: fields.writeTargets ?? [],
    allowedOperations: fields.allowedOperations ?? [],
    ...(fields.publication === undefined ? {} : { publication: fields.publication }),
  };
  return new TaskAuthorityGuard(grant, grant.accountBinding, {
    now: "1970-01-01T00:00:01.000Z",
    ...(fields.isRevoked === undefined ? {} : { isRevoked: fields.isRevoked }),
  });
}

function pageTarget(target: { readonly projectId: string; readonly pageId: string } = LAB_PAGE): PageTarget {
  return { kind: "page", ...target };
}

function fixture(): {
  config: ResearchConfig;
  inventory: LiveInventory;
  binding: TrustedBindingEstablished;
} {
  const accountFingerprint = "a".repeat(64);
  const projectIds = [SOURCE_PAGE.projectId, LAB_PAGE.projectId];
  const pageOwnership = {
    [SOURCE_PAGE.projectId]: [SOURCE_PAGE.pageId],
    [LAB_PAGE.projectId]: [LAB_PAGE.pageId],
  };
  const inventory: LiveInventory = Object.freeze({
    accountFingerprint,
    projectIds: Object.freeze(projectIds),
    pageOwnership: Object.freeze(pageOwnership),
  });
  const inventoryHash = hashLiveInventory(inventory);
  const config: ResearchConfig = {
    cdpUrl: "http://127.0.0.1:9222",
    bindingKeyPath: "C:\\workspace\\.tilda-runtime\\account-binding.key",
    bindingStatePath: "C:\\workspace\\.tilda-runtime\\account-binding.json",
    observatoryHost: "127.0.0.1",
    observatoryPort: 4765,
    accountFingerprint,
    inventoryHash,
    labProjectIds: [LAB_PAGE.projectId],
    readOnlyProjectIds: [SOURCE_PAGE.projectId],
    labPageTargets: [LAB_PAGE],
    labRecordTargets: [LAB_RECORD],
    publicTestDomains: ["example.tilda.ws"],
    officialApiConfigured: false,
  };
  const binding: TrustedBindingEstablished = Object.freeze({
    status: "BOUND",
    capturedAt: new Date(1_000).toISOString(),
    source: "trusted_same_session_cdp",
    route: "/projects/",
    accountFingerprint,
    inventoryHash,
    inventory,
    projectCount: projectIds.length,
    pageCount: projectIds.length,
    captureContext: Object.freeze({
      cdpTargetId: ROOT_TARGET.id,
      expiresAt: new Date(20_000).toISOString(),
    }),
    privacy: Object.freeze({
      rawAccountIdPersisted: false,
      titlesOrContentPersisted: false,
      cookiesOrSessionDataPersisted: false,
    }),
  });
  return { config, inventory, binding };
}

function pageSnapshot(): ExactEditorPageSnapshot {
  return {
    uiReady: true,
    host: "tilda.ru",
    route: "/page/",
    href: `https://tilda.ru/page/?pageid=${LAB_PAGE.pageId}&projectid=${LAB_PAGE.projectId}`,
    authenticated: true,
    target: LAB_PAGE,
    records: [
      {
        recordId: LAB_RECORD.recordId,
        recordType: "128",
        recordCode: "TL04",
        recordCategory: "8",
      },
    ],
    changed: "1",
    published: null,
    editorLoadedAnchor: true,
    scriptPaths: ["/js/tilda-page.js"],
  };
}

function recordRead(): ExactEditorRecordRead {
  return {
    target: LAB_RECORD,
    identity: {
      recordId: LAB_RECORD.recordId,
      recordType: "128",
      recordCode: "TL04",
      recordCategory: "8",
    },
    status: 200,
    contentType: "text/html; charset=utf-8",
    payload: { record: {}, tpl: {} },
    writableField: {
      name: "title",
      value: "baseline",
      representation: "rendered_inner_html",
    },
  };
}

function zeroRuntimeRead(): ExactEditorRecordRead {
  return {
    target: LAB_RECORD,
    identity: {
      recordId: LAB_RECORD.recordId,
      recordType: "396",
      recordCode: "T396",
      recordCategory: "12",
    },
    status: 200,
    contentType: "application/x-tilda-zero-runtime+json",
    payload: {
      cleanElementsData: {
        "0": { elem_id: "1001", type: "text", link: "" },
        "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: true },
      },
      zbGrid: null,
    },
  };
}

function pageSettingsRead() {
  return {
    target: LAB_PAGE,
    fields: [
      ["comm", "savepagesettings"],
      ["pageid", LAB_PAGE.pageId],
      ["meta_descr", "before"],
      ["unknown", "preserve"],
    ] as const,
  };
}

function pageHeadCodeRead(): ExactPageHeadCodeRead {
  return {
    uiReady: true,
    host: "tilda.ru",
    route: "/projects/editheadcode/",
    href: `https://tilda.ru/projects/editheadcode/?pageid=${LAB_PAGE.pageId}&projectid=${LAB_PAGE.projectId}`,
    target: LAB_PAGE,
    code: "<meta name=\"baseline\">",
    saveFunctionHash: "f".repeat(64),
  };
}

function fakeSession(): AuthorityOwnedLoopbackBrowserSession {
  return {
    transport: "loopback_cdp",
    sessionId: ROOT_TARGET.id,
    readRoot: vi.fn(async () => ({}) as never),
    readIdentity: vi.fn(async () => ({}) as never),
    readProject: vi.fn(async () => ({}) as never),
    restoreRoot: vi.fn(async () => ({}) as never),
    close: vi.fn(async () => undefined),
    readEditorPage: vi.fn(async () => pageSnapshot()),
    readStandardSettings: vi.fn(async () => recordRead()),
    readT123Content: vi.fn(async () => recordRead()),
    readZeroModel: vi.fn(async () => zeroRuntimeRead()),
    readZeroServerRepresentation: vi.fn(async () => recordRead()),
    revealExactRecordControl: vi.fn(async (target, expectedIdentity, controlKey) => ({
      target,
      identity: expectedIdentity,
      controlKey,
      ownerRecordId: target.recordId,
      tagName: "button",
      connected: true as const,
    })),
    readRenderedBlockLibrary: vi.fn(async (target) => ({
      target,
      categories: ["Заголовок"],
      templates: [{ templateId: "128", code: "TL04", category: "Заголовок" }],
      mutationIssued: false as const,
    })),
    preflightKnownTemplateAdd: vi.fn(async (target, templateId) => ({
      target,
      templateId,
      runtimeFunction: "tp__addRecord" as const,
      runtimeFunctionHash: "19510095bc198f51ed297e2ba02291d9e6d3ebc72da7b0724886af7ff60ae5cc",
      ready: true,
      mutationIssued: false as const,
      evidence: "LIVE_OBSERVED_PREFLIGHT_ONLY" as const,
    })),
    writeStandard: vi.fn(async () => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    writeT123: vi.fn(async () => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    writeZeroModel: vi.fn(async () => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    preflightZeroModel: vi.fn(async () => ({
      preflight: true as const,
      code: "READY" as const,
    })),
    readPageSettings: vi.fn(async () => pageSettingsRead()),
    writePageSettings: vi.fn(async () => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    readPageHeadCode: vi.fn(async () => pageHeadCodeRead()),
    writePageHeadCode: vi.fn(async (_target, _intendedCode, _expectedCurrentCode) => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    publishPage: vi.fn(async () => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    unpublishPage: vi.fn(async () => ({
      dispatched: true as const,
      httpOk: true,
      status: 200,
      responseBytes: 2,
    })),
    runFixedPageLifecycle: vi.fn(async () => ({
      baseline: {
        target: LAB_PAGE,
        activePageIds: [LAB_PAGE.pageId],
        pageOrder: [LAB_PAGE.pageId],
        sourceRecordIds: [LAB_RECORD.recordId],
        sourcePublished: false,
        sourceChanged: "1",
      },
      restored: {
        target: LAB_PAGE,
        activePageIds: [LAB_PAGE.pageId],
        pageOrder: [LAB_PAGE.pageId],
        sourceRecordIds: [LAB_RECORD.recordId],
        sourcePublished: false,
        sourceChanged: "1",
        temporaryPageId: "9203",
        temporaryPageAbsent: true,
        pageOrderRestored: true,
        sourceUnchanged: true,
        exactBaselineRestored: true,
      },
    })),
    createPageFromReference: vi.fn(async (target) => ({
      baseline: {
        target,
        activePageIds: [target.pageId],
        pageOrder: [target.pageId],
        sourceRecords: pageSnapshot().records,
      },
      created: {
        target: { projectId: target.projectId, pageId: "9203" },
        activePageIds: [target.pageId, "9203"],
        pageOrder: [target.pageId, "9203"],
        records: pageSnapshot().records.map((record) => ({ ...record, recordId: "4000000001" })),
        published: false as const,
      },
    })),
    cleanupReferencePage: vi.fn(async (
      sourceTarget,
      createdPageId,
      expectedActivePageIds,
      expectedPageOrder,
      expectedSourceRecords,
    ) => ({
      sourceTarget,
      removedPageId: createdPageId,
      activePageIds: expectedActivePageIds.filter((pageId: string) => pageId !== createdPageId),
      pageOrder: expectedPageOrder.filter((pageId: string) => pageId !== createdPageId),
      removedPageAbsent: true as const,
      sourceRecords: expectedSourceRecords,
    })),
    addKnownTemplate: vi.fn(async (target, templateId) => ({
      target,
      templateId,
      beforeRecords: pageSnapshot().records,
      afterRecords: [
        ...pageSnapshot().records,
        {
          recordId: "4000000001",
          recordType: templateId,
          recordCode: templateId === "128" ? "TL04" : templateId === "778" ? "ST310N" : templateId === "131" ? "T123" : "T396",
          recordCategory: "12",
        },
      ],
      createdRecord: {
        recordId: "4000000001",
        recordType: templateId,
        recordCode: templateId === "128" ? "TL04" : templateId === "778" ? "ST310N" : templateId === "131" ? "T123" : "T396",
        recordCategory: "12",
      },
      publishedUnchanged: true as const,
    })),
  };
}

function dependencies(
  binding: TrustedBindingCapture,
  session = fakeSession(),
  clock: { now: number } = { now: 1_000 },
): LoopbackBrowserAuthorityDependencies {
  return {
    listTargets: vi.fn(async () => [ROOT_TARGET]),
    openSession: vi.fn(async () => session),
    captureBinding: vi.fn(async (_config, capturedSession) => {
      expect(capturedSession).toBe(session);
      return binding;
    }),
    isFreshBinding: (capture): capture is TrustedBindingEstablished =>
      capture?.status === "BOUND",
    now: () => clock.now,
    randomId: vi.fn(() => "lease-id"),
  };
}

describe("loopback browser authority", () => {
  it("waits for exact editor globals, #allrecords, and pagepublished instead of DOM ready alone", () => {
    const early = {
      ...pageSnapshot(),
      records: [],
      changed: null,
      published: null,
      editorLoadedAnchor: false,
    };
    expect(isReadyExactEditorPageSnapshot(early)).toBe(false);
    expect(isReadyExactEditorPageSnapshot({
      ...early,
      published: "synthetic-published",
      editorLoadedAnchor: true,
    })).toBe(false);
    expect(isReadyExactEditorPageSnapshot({
      ...early,
      records: pageSnapshot().records,
      published: "synthetic-published",
      editorLoadedAnchor: true,
    })).toBe(true);
  });

  it("binds optional task authority to the same fresh account and inventory capture", async () => {
    const { config, binding } = fixture();
    const mismatchedBinding = {
      accountFingerprint: "b".repeat(64),
      inventoryHash: "c".repeat(64),
    };
    const guard = taskGuard(mismatchedBinding as TrustedBindingEstablished, {
      mode: "observe",
      observeTargets: [pageTarget()],
    });
    for (const acquire of [
      acquireLoopbackBrowserAuthority,
      acquireLoopbackBrowserReadAuthority,
    ] as const) {
      const session = fakeSession();
      await expect(acquire(
        config,
        { taskGuard: guard },
        dependencies(binding, session),
      )).rejects.toMatchObject({ code: "BINDING_STALE" });
      expect(session.close).toHaveBeenCalledTimes(1);
    }
  });

  it("uses task read scopes instead of legacy lab/source classification when a guard exists", async () => {
    const { config, binding } = fixture();
    const sourcePage = SOURCE_PAGE;
    const guard = taskGuard(binding, {
      mode: "observe",
      observeTargets: [pageTarget(sourcePage)],
    });
    for (const acquire of [
      acquireLoopbackBrowserAuthority,
      acquireLoopbackBrowserReadAuthority,
    ] as const) {
      const session = fakeSession();
      session.readEditorPage = vi.fn(async (target) => ({
        ...pageSnapshot(),
        target,
        href: `https://tilda.ru/page/?pageid=${target.pageId}&projectid=${target.projectId}`,
      }));
      const authority = await acquire(
        { ...config, readOnlyProjectIds: [] },
        { taskGuard: guard },
        dependencies(binding, session),
      );
      try {
        const read = "adapter" in authority ? authority.adapter : authority.reader;
        await expect(read.readEditorPage(sourcePage)).resolves.toMatchObject({ target: sourcePage });
        await expect(read.readEditorPage(LAB_PAGE)).rejects.toMatchObject({ code: "TASK_READ_DENIED" });
      } finally {
        await authority.close();
      }
    }
  });

  it("enforces exact typed task operations while preserving legacy behavior without a guard", async () => {
    const { config, binding } = fixture();
    const guard = taskGuard(binding, {
      writeTargets: [{ kind: "record", ...LAB_RECORD }],
      allowedOperations: ["standard.field.patch"],
    });
    const guardedConfig = { ...config, labPageTargets: [], labRecordTargets: [] };
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      guardedConfig,
      { taskGuard: guard },
      dependencies(binding, session),
    );
    try {
      await expect(authority.adapter.writeT123(LAB_RECORD, "blocked"))
        .rejects.toMatchObject({ code: "TASK_OPERATION_DENIED" });
      expect(session.readEditorPage).not.toHaveBeenCalled();
      await expect(authority.adapter.writeStandard(LAB_RECORD, "title", "replacement"))
        .resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
      expect(session.writeStandard).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("rechecks task revocation after the fresh adapter reread and before dispatch", async () => {
    const { config, binding } = fixture();
    let revoked = false;
    const guard = taskGuard(binding, {
      writeTargets: [{ kind: "record", ...LAB_RECORD }],
      allowedOperations: ["standard.field.patch"],
      isRevoked: () => revoked,
    });
    const session = fakeSession();
    session.readStandardSettings = vi.fn(async () => {
      revoked = true;
      return recordRead();
    });
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      { taskGuard: guard },
      dependencies(binding, session),
    );
    try {
      await expect(authority.adapter.writeStandard(LAB_RECORD, "title", "replacement"))
        .rejects.toMatchObject({ code: "TASK_AUTHORITY_REVOKED" });
      expect(session.writeStandard).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it("stops the common dispatch boundary after successful manager clear or replace", async () => {
    const { config, binding } = fixture();
    for (const transition of ["clear", "replace"] as const) {
      let id = 0;
      const ids = [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ];
      const manager = new TaskAuthorityManager({
        now: () => new Date(1_000),
        createTaskId: () => ids[id++]!,
      });
      const grantInput: MintTaskAuthorityInput = {
        taskDescription: "write one standard field",
        mode: "production",
        observeTargets: [],
        writeTargets: [{ kind: "record", ...LAB_RECORD }],
        allowedOperations: ["standard.field.patch"],
        binding: {
          accountFingerprint: binding.accountFingerprint,
          inventoryHash: binding.inventoryHash,
        },
        ttlMs: 10_000,
      };
      manager.mint(grantInput);
      const oldGuard = manager.requireGuard();
      const session = fakeSession();
      session.readStandardSettings = vi.fn(async () => {
        if (transition === "clear") {
          expect(manager.clear()).toBe(true);
        } else {
          manager.replace({ ...grantInput, taskDescription: "replacement task" });
        }
        return recordRead();
      });
      const authority = await acquireLoopbackBrowserAuthority(
        config,
        { taskGuard: oldGuard },
        dependencies(binding, session),
      );
      try {
        await expect(authority.adapter.writeStandard(LAB_RECORD, "title", "replacement"))
          .rejects.toMatchObject({ code: "TASK_AUTHORITY_REVOKED" });
        expect(session.writeStandard).not.toHaveBeenCalled();
      } finally {
        await authority.close();
      }
      manager.clear();
    }
  });

  it("holds one manager mutation lease across every browser write transaction", async () => {
    const { config, binding } = fixture();
    const recordTarget = { kind: "record" as const, ...LAB_RECORD };
    const elementTarget = { kind: "element" as const, ...LAB_RECORD, elementId: "1001" };
    const zeroPayload = zeroRuntimeRead().payload as {
      readonly cleanElementsData: Record<string, unknown>;
    };
    const zeroAfter = structuredClone(zeroPayload.cleanElementsData);
    zeroAfter["0"] = {
      ...(zeroAfter["0"] as Record<string, unknown>),
      link: "changed",
    };
    const cases: readonly {
      readonly name: string;
      readonly mutationMethod: string;
      readonly writeTargets: readonly ExactTarget[];
      readonly allowedOperations: readonly ChangeOperation[];
      readonly publication?: TaskPublicationGrant;
      readonly prepare?: (session: AuthorityOwnedLoopbackBrowserSession) => void;
      readonly invoke: (
        authority: Awaited<ReturnType<typeof acquireLoopbackBrowserAuthority>>,
      ) => Promise<unknown>;
    }[] = [
      {
        name: "standard",
        mutationMethod: "writeStandard",
        writeTargets: [recordTarget],
        allowedOperations: ["standard.field.patch"],
        invoke: (authority) => authority.adapter.writeStandard(LAB_RECORD, "title", "replacement"),
      },
      {
        name: "t123",
        mutationMethod: "writeT123",
        writeTargets: [recordTarget],
        allowedOperations: ["t123.code.replace"],
        prepare: (session) => {
          session.readEditorPage = vi.fn(async () => ({
            ...pageSnapshot(),
            records: [{
              ...pageSnapshot().records[0]!,
              recordType: "131",
              recordCode: "T123",
            }],
          }));
        },
        invoke: (authority) => authority.adapter.writeT123(LAB_RECORD, "<script>void 0;</script>"),
      },
      {
        name: "zero",
        mutationMethod: "writeZeroModel",
        writeTargets: [elementTarget],
        allowedOperations: ["zero.leaf.patch"],
        invoke: (authority) => authority.adapter.writeZeroModel(
          LAB_RECORD,
          zeroAfter,
          undefined,
          elementTarget.elementId,
        ),
      },
      {
        name: "page settings",
        mutationMethod: "writePageSettings",
        writeTargets: [pageTarget()],
        allowedOperations: ["page.seo.patch"],
        invoke: (authority) => authority.adapter.writePageSettings(LAB_PAGE, [
          ["comm", "savepagesettings"],
          ["pageid", LAB_PAGE.pageId],
          ["meta_descr", "after"],
          ["unknown", "preserve"],
        ]),
      },
      {
        name: "page head",
        mutationMethod: "writePageHeadCode",
        writeTargets: [pageTarget()],
        allowedOperations: ["page.head.code.replace"],
        invoke: (authority) => authority.adapter.writePageHeadCode(
          LAB_PAGE,
          "<meta name=\"after\">",
          "<meta name=\"baseline\">",
        ),
      },
      {
        name: "publication",
        mutationMethod: "publishPage",
        writeTargets: [pageTarget()],
        allowedOperations: [],
        publication: { actions: ["publish"], targets: [pageTarget()] },
        prepare: (session) => {
          session.readEditorPage = vi.fn(async () => ({ ...pageSnapshot(), published: "" }));
        },
        invoke: (authority) => authority.adapter.publishPage(LAB_PAGE),
      },
      {
        name: "page lifecycle",
        mutationMethod: "runFixedPageLifecycle",
        writeTargets: [pageTarget()],
        allowedOperations: ["page.lifecycle"],
        prepare: (session) => {
          session.readEditorPage = vi.fn(async () => ({ ...pageSnapshot(), published: "" }));
        },
        invoke: (authority) => authority.adapter.runFixedPageLifecycle(LAB_PAGE),
      },
      {
        name: "reference clone",
        mutationMethod: "createPageFromReference",
        writeTargets: [pageTarget()],
        allowedOperations: ["page.reference.clone"],
        invoke: (authority) => authority.adapter.createPageFromReference(LAB_PAGE),
      },
      {
        name: "known template",
        mutationMethod: "addKnownTemplate",
        writeTargets: [pageTarget()],
        allowedOperations: ["standard.template.add"],
        invoke: (authority) => authority.adapter.addKnownTemplate(LAB_PAGE, "128"),
      },
    ];

    for (const testCase of cases) {
      const manager = new TaskAuthorityManager({
        now: () => new Date(1_000),
        createTaskId: () => "00000000-0000-4000-8000-000000000001",
      });
      const grantInput: MintTaskAuthorityInput = {
        taskDescription: `exercise ${testCase.name} dispatch boundary`,
        mode: "production",
        observeTargets: [],
        writeTargets: testCase.writeTargets,
        allowedOperations: testCase.allowedOperations,
        binding: {
          accountFingerprint: binding.accountFingerprint,
          inventoryHash: binding.inventoryHash,
        },
        ttlMs: 10_000,
        ...(testCase.publication === undefined ? {} : { publication: testCase.publication }),
      };
      manager.mint(grantInput);
      const session = fakeSession();
      testCase.prepare?.(session);
      const mutationMethods = session as unknown as Record<
        string,
        (...args: readonly unknown[]) => Promise<unknown>
      >;
      const original = mutationMethods[testCase.mutationMethod]!;
      let reachedSimulatedDispatch = false;
      mutationMethods[testCase.mutationMethod] = vi.fn(async (...args: readonly unknown[]) => {
        expect(() => manager.clear(), testCase.name).toThrow(
          expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }),
        );
        expect(
          () => manager.replace({ ...grantInput, taskDescription: "replacement" }),
          testCase.name,
        ).toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }));
        await Promise.resolve();
        expect(manager.currentGuard(), testCase.name).not.toBeNull();
        reachedSimulatedDispatch = true;
        return original(...args);
      });
      const authority = await acquireLoopbackBrowserAuthority(
        config,
        { taskGuard: manager.requireGuard() },
        dependencies(binding, session),
      );
      try {
        await expect(testCase.invoke(authority), testCase.name).resolves.toBeDefined();
        expect(reachedSimulatedDispatch, testCase.name).toBe(true);
      } finally {
        await authority.close();
      }
      expect(manager.clear(), testCase.name).toBe(true);
    }
  });

  it("classifies generic Zero apply and restore transitions against the exact element grant", async () => {
    const { config, binding } = fixture();
    const elementId = "1002";
    const guard = taskGuard(binding, {
      writeTargets: [{ kind: "element", ...LAB_RECORD, elementId }],
      allowedOperations: ["zero.property.patch"],
    });
    const beforeModel = {
      "0": { elem_id: "1001", type: "text", link: "" },
      "1": { elem_id: elementId, type: "image", src: "before.jpg", left: 1, top: 2, zindex: 1 },
      groups: { preserve: true },
      meta: { preserve: true },
      timestamp: 1,
    };
    const afterModel = {
      ...structuredClone(beforeModel),
      "1": { ...beforeModel["1"], src: "after.jpg" },
    };
    for (const [current, intended] of [
      [beforeModel, afterModel],
      [afterModel, beforeModel],
    ] as const) {
      const session = fakeSession();
      session.readZeroModel = vi.fn(async () => ({
        ...zeroRuntimeRead(),
        payload: { cleanElementsData: current, zbGrid: {} },
      }));
      const authority = await acquireLoopbackBrowserAuthority(
        config,
        { taskGuard: guard },
        dependencies(binding, session),
      );
      try {
        await expect(authority.adapter.writeZeroModel(
          LAB_RECORD,
          intended,
          undefined,
          elementId,
        )).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
        expect(session.writeZeroModel).toHaveBeenCalledWith(LAB_RECORD, intended, 12_000);
      } finally {
        await authority.close();
      }
    }
  });

  it("uses the separate task publication grant instead of content-change authority", async () => {
    const { config, binding } = fixture();
    const target = pageTarget();
    const guard = taskGuard(binding, {
      writeTargets: [target],
      publication: { actions: ["publish"], targets: [target] },
    });
    const deniedSession = fakeSession();
    const deniedAuthority = await acquireLoopbackBrowserAuthority(
      config,
      { taskGuard: guard },
      dependencies(binding, deniedSession),
    );
    try {
      await expect(deniedAuthority.adapter.unpublishPage(LAB_PAGE))
        .rejects.toMatchObject({ code: "TASK_PUBLICATION_DENIED" });
      expect(deniedSession.readEditorPage).not.toHaveBeenCalled();
    } finally {
      await deniedAuthority.close();
    }

    const session = fakeSession();
    session.readEditorPage = vi.fn(async () => ({ ...pageSnapshot(), published: "" }));
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      { taskGuard: guard },
      dependencies(binding, session),
    );
    try {
      await expect(authority.adapter.publishPage(LAB_PAGE))
        .resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
      expect(session.publishPage).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("maps each adapter-owned structural mutation to its exact task operation", async () => {
    const { config, binding } = fixture();
    const target = pageTarget();
    const cases: readonly {
      operation: ChangeOperation;
      prepare(session: AuthorityOwnedLoopbackBrowserSession): void;
      invoke(authority: Awaited<ReturnType<typeof acquireLoopbackBrowserAuthority>>): Promise<unknown>;
    }[] = [
      {
        operation: "standard.template.add",
        prepare: () => undefined,
        invoke: (authority) => authority.adapter.addKnownTemplate(LAB_PAGE, "128"),
      },
      {
        operation: "page.reference.clone",
        prepare: () => undefined,
        invoke: (authority) => authority.adapter.createPageFromReference(LAB_PAGE),
      },
      {
        operation: "page.lifecycle",
        prepare: (session) => {
          session.readEditorPage = vi.fn(async () => ({ ...pageSnapshot(), published: "" }));
        },
        invoke: (authority) => authority.adapter.runFixedPageLifecycle(LAB_PAGE),
      },
    ];
    for (const testCase of cases) {
      const guard = taskGuard(binding, {
        writeTargets: [target],
        allowedOperations: [testCase.operation],
      });
      const session = fakeSession();
      testCase.prepare(session);
      const authority = await acquireLoopbackBrowserAuthority(
        config,
        { taskGuard: guard },
        dependencies(binding, session),
      );
      try {
        await expect(testCase.invoke(authority)).resolves.toBeDefined();
      } finally {
        await authority.close();
      }
    }
  });

  it("exposes a separate frozen read-only authority for live-owned source pages", async () => {
    const { config, binding } = fixture();
    const sourcePage = SOURCE_PAGE;
    const sourceRecord = Object.freeze({ ...sourcePage, recordId: "123" });
    const session = fakeSession();
    session.readEditorPage = vi.fn(async (target) => ({
      ...pageSnapshot(),
      target,
      href: `https://tilda.ru/page/?pageid=${target.pageId}&projectid=${target.projectId}`,
      records: [{
        recordId: sourceRecord.recordId,
        recordType: "128",
        recordCode: "TL04",
        recordCategory: "8",
      }],
    }));
    const authority = await acquireLoopbackBrowserReadAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(authority.reader.readEditorPage(sourcePage)).resolves.toMatchObject({
        target: sourcePage,
      });
      await expect(authority.reader.readStandardSettings(sourceRecord)).resolves.toEqual(recordRead());
      await expect(
        authority.reader.revealExactRecordControl(sourceRecord, "contentButton"),
      ).resolves.toMatchObject({
        target: sourceRecord,
        ownerRecordId: sourceRecord.recordId,
        controlKey: "contentButton",
        connected: true,
      });
      await expect(authority.reader.readRenderedBlockLibrary(sourcePage)).resolves.toMatchObject({
        target: sourcePage,
        mutationIssued: false,
        templates: [{ templateId: "128", code: "TL04" }],
      });
      expect(Object.isFrozen(authority.reader)).toBe(true);
      expect("writeStandard" in authority.reader).toBe(false);
      expect("writeZeroModel" in authority.reader).toBe(false);
      expect("writePageSettings" in authority.reader).toBe(false);
      await expect(
        authority.reader.readEditorPage({ ...sourcePage, pageId: "999999999" }),
      ).rejects.toMatchObject({ code: "TARGET_REJECTED" });
    } finally {
      await authority.close();
    }
    expect(session.restoreRoot).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("retains one exact session across binding and fixed adapter reads", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const deps = dependencies(binding, session);
    const authority = await acquireLoopbackBrowserAuthority(config, {}, deps);
    try {
      expect(authority.metadata.cdpTargetId).toBe(ROOT_TARGET.id);
      expect(authority.binding.inventory).toBe(binding.inventory);
      await expect(authority.adapter.readEditorPage(LAB_PAGE)).resolves.toEqual(pageSnapshot());
      await expect(authority.adapter.readStandardSettings(LAB_RECORD)).resolves.toEqual(recordRead());
      await expect(authority.adapter.readZeroModel(LAB_RECORD)).resolves.toEqual(zeroRuntimeRead());
      await expect(authority.adapter.readPageSettings(LAB_PAGE)).resolves.toEqual(pageSettingsRead());
      await expect(authority.adapter.readPageHeadCode(LAB_PAGE)).resolves.toEqual(pageHeadCodeRead());
      await expect(authority.adapter.readRenderedBlockLibrary(LAB_PAGE)).resolves.toMatchObject({
        target: LAB_PAGE,
        mutationIssued: false,
        templates: [{ templateId: "128", code: "TL04" }],
      });
      await expect(authority.adapter.preflightKnownTemplateAdd(LAB_PAGE, "128")).resolves.toMatchObject({
        templateId: "128",
        ready: true,
        mutationIssued: false,
      });
      expect(session.readEditorPage).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect(session.readStandardSettings).toHaveBeenCalledWith(LAB_RECORD, 12_000);
      expect(session.readZeroModel).toHaveBeenCalledWith(LAB_RECORD, 12_000);
      expect(session.readPageSettings).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect(session.readPageHeadCode).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect(session.readRenderedBlockLibrary).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect(session.preflightKnownTemplateAdd).toHaveBeenCalledWith(LAB_PAGE, "128", 12_000);
      expect("send" in authority.adapter).toBe(false);
      expect("evaluate" in authority.adapter).toBe(false);
      expect("goto" in authority.adapter).toBe(false);
    } finally {
      await authority.close();
    }
    expect(session.restoreRoot).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("reveals a hover-only control only after exact record and ownership checks", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.revealExactRecordControl(LAB_RECORD, "contentButton", 900),
      ).resolves.toMatchObject({
        target: LAB_RECORD,
        controlKey: "contentButton",
        ownerRecordId: LAB_RECORD.recordId,
        connected: true,
      });
      expect(session.readEditorPage).toHaveBeenCalledWith(LAB_RECORD, 900);
      expect(session.revealExactRecordControl).toHaveBeenCalledWith(
        LAB_RECORD,
        pageSnapshot().records[0],
        "contentButton",
        900,
      );
      await expect(
        authority.adapter.revealExactRecordControl(LAB_RECORD, "bad-key"),
      ).rejects.toMatchObject({ code: "TARGET_REJECTED" });
    } finally {
      await authority.close();
    }
  });

  it("rejects hover-control evidence owned by another record", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    session.revealExactRecordControl = vi.fn(async (target, expectedIdentity, controlKey) => ({
      target,
      identity: expectedIdentity,
      controlKey,
      ownerRecordId: "9999999999",
      tagName: "button",
      connected: true as const,
    }));
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.revealExactRecordControl(LAB_RECORD, "contentButton"),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
    } finally {
      await authority.close();
    }
  });

  it("rejects missing and ambiguous root tabs before opening a session", async () => {
    const { config, binding } = fixture();
    const missing = dependencies(binding);
    missing.listTargets = vi.fn(async () => [
      { ...ROOT_TARGET, url: "https://tilda.ru/projects/?mainsite=checked" },
      { ...ROOT_TARGET, id: "root-fragment", url: "https://tilda.ru/projects/#fragment" },
    ]);
    await expect(acquireLoopbackBrowserAuthority(config, {}, missing)).rejects.toMatchObject({
      code: "EXACT_ROOT_TARGET_NOT_FOUND",
    });
    expect(missing.openSession).not.toHaveBeenCalled();

    const ambiguous = dependencies(binding);
    ambiguous.listTargets = vi.fn(async () => [
      ROOT_TARGET,
      { ...ROOT_TARGET, id: "root-2", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/root-2" },
    ]);
    await expect(acquireLoopbackBrowserAuthority(config, {}, ambiguous)).rejects.toMatchObject({
      code: "EXACT_ROOT_TARGET_AMBIGUOUS",
    });
    expect(ambiguous.openSession).not.toHaveBeenCalled();
  });

  it("permits only one process-local lease until exact close", async () => {
    const { config, binding } = fixture();
    const first = await acquireLoopbackBrowserAuthority(config, {}, dependencies(binding));
    try {
      await expect(
        acquireLoopbackBrowserAuthority(config, {}, dependencies(binding)),
      ).rejects.toMatchObject({ code: "AUTHORITY_BUSY" });
    } finally {
      await first.close();
    }
    const second = await acquireLoopbackBrowserAuthority(config, {}, dependencies(binding));
    await second.close();
  });

  it("uses the captured inventory for denylist and exact-target guards", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      const sourceTarget = SOURCE_PAGE;
      await expect(authority.adapter.readEditorPage(sourceTarget)).rejects.toMatchObject({
        code: "TARGET_REJECTED",
      });
      await expect(
        authority.adapter.readEditorPage({ ...LAB_PAGE, extra: "forbidden" } as never),
      ).rejects.toMatchObject({ code: "TARGET_REJECTED" });
      expect(session.readEditorPage).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it("fails closed after lease expiry without issuing an adapter read", async () => {
    const { config, binding } = fixture();
    const clock = { now: 1_000 };
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      { leaseTtlMs: 5_000 },
      dependencies(binding, session, clock),
    );
    try {
      clock.now = 6_001;
      await expect(authority.adapter.readEditorPage(LAB_PAGE)).rejects.toMatchObject({
        code: "AUTHORITY_EXPIRED",
      });
      expect(session.readEditorPage).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it("dispatches one proved standard write and returns no raw request material", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      const receipt = await authority.adapter.writeStandard(
        LAB_RECORD,
        "title",
        "new value",
      );
      expect(receipt).toEqual({
        operationId: "lease-id",
        dispatched: true,
        ack: "http_ok",
        requestBodyPersisted: false,
      });
      expect(Object.keys(receipt).sort()).toEqual([
        "ack",
        "dispatched",
        "operationId",
        "requestBodyPersisted",
      ]);
      expect(session.writeStandard).toHaveBeenCalledTimes(1);
      expect(session.writeStandard).toHaveBeenCalledWith(
        LAB_RECORD,
        "title",
        "new value",
        12_000,
      );
      await expect(
        authority.adapter.writeStandard(LAB_RECORD, "title", "another value"),
      ).rejects.toMatchObject({ code: "MUTATION_SLOT_CONSUMED" });
      expect(session.writeStandard).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("accepts a Standard/T123 application acknowledgement only for exact trimmed OK", async () => {
    expect(hasExactRecordWriteApplicationAck(true, "OK")).toBe(true);
    expect(hasExactRecordWriteApplicationAck(true, " \r\nOK\t")).toBe(true);
    expect(hasExactRecordWriteApplicationAck(false, "OK")).toBe(false);
    expect(hasExactRecordWriteApplicationAck(true, "ok")).toBe(false);
    expect(hasExactRecordWriteApplicationAck(true, "OK extra")).toBe(false);
    expect(hasExactRecordWriteApplicationAck(true, "<html>OK</html>")).toBe(false);

    const { config, binding } = fixture();
    const session = fakeSession();
    session.writeStandard = vi.fn(async () => ({
      dispatched: true as const,
      httpOk: false,
      status: 200,
      responseBytes: 18,
    }));
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      const receipt = await authority.adapter.writeStandard(
        LAB_RECORD,
        "title",
        "diagnostic",
      );
      expect(receipt).toEqual({
        operationId: "lease-id",
        dispatched: true,
        ack: "http_rejected",
        requestBodyPersisted: false,
      });
      expect(Object.keys(receipt)).not.toContain("responseText");
      expect(session.writeStandard).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("denies source records and unproved standard family-field combinations", async () => {
    const { config, binding } = fixture();
    const sourceSession = fakeSession();
    const sourceAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, sourceSession),
    );
    try {
      await expect(
        sourceAuthority.adapter.writeStandard(
          {
            ...SOURCE_PAGE,
            recordId: "123",
          },
          "title",
          "blocked",
        ),
      ).rejects.toMatchObject({ code: "TARGET_REJECTED" });
      expect(sourceSession.readEditorPage).not.toHaveBeenCalled();
      expect(sourceSession.writeStandard).not.toHaveBeenCalled();
    } finally {
      await sourceAuthority.close();
    }

    const familySession = fakeSession();
    familySession.readEditorPage = vi.fn(async () => ({
      ...pageSnapshot(),
      records: [{
        recordId: LAB_RECORD.recordId,
        recordType: "778",
        recordCode: "ST310N",
        recordCategory: "12",
      }],
    }));
    familySession.readStandardSettings = vi.fn(async () => ({
      ...recordRead(),
      identity: {
        recordId: LAB_RECORD.recordId,
        recordType: "778",
        recordCode: "ST310N",
        recordCategory: "12",
      },
      writableField: {
        name: "buttontitle",
        value: "baseline",
        representation: "rendered_inner_html" as const,
      },
    }));
    const familyAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, familySession),
    );
    try {
      await expect(
        familyAuthority.adapter.writeStandard(LAB_RECORD, "title", "blocked"),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(familySession.writeStandard).not.toHaveBeenCalled();
      await expect(
        familyAuthority.adapter.writeStandard(LAB_RECORD, "buttontitle", "allowed"),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
      expect(familySession.writeStandard).toHaveBeenCalledTimes(1);
    } finally {
      await familyAuthority.close();
    }
  });

  it("dispatches a generic exact standard top-level string field after fresh reread", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    session.readEditorPage = vi.fn(async () => ({
      ...pageSnapshot(),
      records: [{
        recordId: LAB_RECORD.recordId,
        recordType: "702",
        recordCode: "BF502N",
        recordCategory: "10",
      }],
    }));
    session.readStandardSettings = vi.fn(async () => ({
      ...recordRead(),
      identity: {
        recordId: LAB_RECORD.recordId,
        recordType: "702",
        recordCode: "BF502N",
        recordCategory: "10",
      },
      payload: {
        record: {
          id: LAB_RECORD.recordId,
          pageid: LAB_RECORD.pageId,
          headline: "before",
          unknown: { preserve: true },
        },
        tpl: {},
      },
      renderedFields: [],
    }));
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.writeStandard(LAB_RECORD, "pageid", "999999999"),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writeStandard).not.toHaveBeenCalled();
      await expect(
        authority.adapter.writeStandard(LAB_RECORD, "headline", "after"),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
      expect(session.readStandardSettings).toHaveBeenCalledWith(LAB_RECORD, 12_000);
      expect(session.writeStandard).toHaveBeenCalledWith(LAB_RECORD, "headline", "after", 12_000);
    } finally {
      await authority.close();
    }
  });

  it("dispatches only the reproduced T123 identity contract", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.writeT123(LAB_RECORD, "blocked"),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writeT123).not.toHaveBeenCalled();
      session.readEditorPage = vi.fn(async () => ({
        ...pageSnapshot(),
        records: [{
          recordId: LAB_RECORD.recordId,
          recordType: "131",
          recordCode: "T123",
          recordCategory: "12",
        }],
      }));
      await expect(
        authority.adapter.writeT123(LAB_RECORD, "<!-- inert -->"),
      ).resolves.toEqual({
        operationId: "lease-id",
        dispatched: true,
        ack: "http_ok",
        requestBodyPersisted: false,
      });
      expect(session.writeT123).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("dispatches one strict clean-runtime Zero link transition and rejects encoded or destructive models", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, {
          0: { elem_id: "1001", type: "text", link: "encoded" },
        }),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, [
          { elem_id: "1001", type: "text", link: "" },
        ]),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writeZeroModel).not.toHaveBeenCalled();

      const intended = {
        "0": { elem_id: "1001", type: "text", link: "https://example.invalid/" },
        "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: true },
      };
      await expect(authority.adapter.writeZeroModel(LAB_RECORD, intended)).resolves.toEqual({
        operationId: "lease-id",
        dispatched: true,
        ack: "http_ok",
        requestBodyPersisted: false,
      });
      expect(session.writeZeroModel).toHaveBeenCalledTimes(1);
      expect(session.writeZeroModel).toHaveBeenCalledWith(LAB_RECORD, intended, 12_000);
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, intended),
      ).rejects.toMatchObject({ code: "MUTATION_SLOT_CONSUMED" });
    } finally {
      await authority.close();
    }
  });

  it("allows only the reproduced Zero responsive leaf or appended shape clone", async () => {
    const { config, binding } = fixture();
    const linkRemovalSession = fakeSession();
    const linkRemovalAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, linkRemovalSession),
    );
    try {
      await expect(
        linkRemovalAuthority.adapter.writeZeroModel(LAB_RECORD, {
          "0": { elem_id: "1001", type: "text" },
          "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 1,
          unknownMetadata: { preserve: true },
        }),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await linkRemovalAuthority.close();
    }

    const responsiveSession = fakeSession();
    const responsiveAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, responsiveSession),
    );
    try {
      await expect(
        responsiveAuthority.adapter.writeZeroModel(LAB_RECORD, {
          "0": { elem_id: "1001", type: "text", link: "" },
          "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1, "left-res-480": 42 },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 1,
          unknownMetadata: { preserve: true },
        }),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await responsiveAuthority.close();
    }

    const cloneSession = fakeSession();
    const cloneAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, cloneSession),
    );
    try {
      await expect(
        cloneAuthority.adapter.writeZeroModel(LAB_RECORD, {
          "0": { elem_id: "1001", type: "text", link: "" },
          "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
          "2": { elem_id: "1003", type: "shape", left: 30, top: 40, zindex: 2 },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 1,
          unknownMetadata: { preserve: true },
        }),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await cloneAuthority.close();
    }

    const inverseSession = fakeSession();
    inverseSession.readZeroModel = vi.fn(async () => ({
      ...zeroRuntimeRead(),
      payload: {
        cleanElementsData: {
          "0": { elem_id: "1001", type: "text", link: "" },
          "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
          "2": { elem_id: "1003", type: "shape", left: "30", top: "40", zindex: 2 },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 1,
          unknownMetadata: { preserve: true },
        },
        zbGrid: {},
      },
    }));
    const inverseAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, inverseSession),
    );
    try {
      await expect(
        inverseAuthority.adapter.writeZeroModel(LAB_RECORD, {
          "0": { elem_id: "1001", type: "text", link: "" },
          "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 1,
          unknownMetadata: { preserve: true },
        }),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await inverseAuthority.close();
    }
  });

  it("accepts one primitive property patch or clone on a supported basic Zero element", async () => {
    const { config, binding } = fixture();
    const imageModel = {
      "0": { elem_id: "1001", type: "text", link: "" },
      "1": {
        elem_id: "1002",
        type: "image",
        src: "https://example.test/a.jpg",
        left: 10,
        top: 20,
        zindex: 1,
        unknown: { preserve: true },
      },
      groups: { preserve: true },
      meta: { preserve: true },
      timestamp: 1,
      unknownMetadata: { preserve: true },
    };
    const patchSession = fakeSession();
    patchSession.readZeroModel = vi.fn(async () => ({
      ...zeroRuntimeRead(),
      payload: { cleanElementsData: imageModel, zbGrid: {} },
    }));
    const patchAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, patchSession),
    );
    try {
      await expect(patchAuthority.adapter.writeZeroModel(LAB_RECORD, {
        ...structuredClone(imageModel),
        "1": { ...imageModel["1"], src: "https://example.test/b.jpg" },
      })).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await patchAuthority.close();
    }

    const cloneSession = fakeSession();
    cloneSession.readZeroModel = vi.fn(async () => ({
      ...zeroRuntimeRead(),
      payload: { cleanElementsData: imageModel, zbGrid: {} },
    }));
    const cloneAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, cloneSession),
    );
    try {
      await expect(cloneAuthority.adapter.writeZeroModel(LAB_RECORD, {
        ...structuredClone(imageModel),
        "2": {
          ...imageModel["1"],
          elem_id: "1003",
          left: 15,
          top: 26,
          zindex: 2,
        },
      })).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await cloneAuthority.close();
    }
  });

  it("rebases only Zero timestamp drift and rejects other metadata drift", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    session.readZeroModel = vi.fn(async () => ({
      ...zeroRuntimeRead(),
      payload: {
        cleanElementsData: {
          "0": { elem_id: "1001", type: "text", link: "" },
          "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
          groups: { preserve: true },
          meta: { preserve: true },
          timestamp: 2,
          unknownMetadata: { preserve: true },
        },
        zbGrid: null,
      },
    }));
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      const metadataDrift = {
        "0": { elem_id: "1001", type: "text", link: "changed" },
        "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: false },
      };
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, metadataDrift),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writeZeroModel).not.toHaveBeenCalled();

      const intended = {
        "0": { elem_id: "1001", type: "text", link: "https://example.invalid/" },
        "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: true },
      };
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, intended),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
      expect(intended.timestamp).toBe(1);
      expect(session.writeZeroModel).toHaveBeenCalledWith(
        LAB_RECORD,
        { ...intended, timestamp: 2 },
        12_000,
      );
    } finally {
      await authority.close();
    }
  });

  it("runs the fixed Zero writer preflight without consuming the mutation slot", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    const intended = {
      "0": { elem_id: "1001", type: "text", link: "https://example.invalid/" },
      "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
      groups: { preserve: true },
      meta: { preserve: true },
      timestamp: 1,
      unknownMetadata: { preserve: true },
    };
    try {
      await expect(
        authority.adapter.preflightZeroModel(LAB_RECORD, intended),
      ).resolves.toEqual({ preflight: true, code: "READY" });
      expect(session.preflightZeroModel).toHaveBeenCalledWith(LAB_RECORD, intended, 12_000);
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, intended),
      ).resolves.toMatchObject({ dispatched: true, ack: "http_ok" });
    } finally {
      await authority.close();
    }
  });

  it("rejects duplicate IDs, metadata drift, and non-appended keyed clone entries", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      const duplicateId = {
        "0": { elem_id: "1001", type: "text", link: "changed" },
        "1": { elem_id: "1001", type: "shape", left: 10, top: 20, zindex: 1 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: true },
      };
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, duplicateId),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });

      const metadataDrift = {
        "0": { elem_id: "1001", type: "text", link: "changed" },
        "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: false },
      };
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, metadataDrift),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });

      const nonAppendedClone = {
        "0": { elem_id: "1001", type: "text", link: "" },
        "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
        "9": { elem_id: "1003", type: "shape", left: 30, top: 40, zindex: 2 },
        groups: { preserve: true },
        meta: { preserve: true },
        timestamp: 1,
        unknownMetadata: { preserve: true },
      };
      await expect(
        authority.adapter.writeZeroModel(LAB_RECORD, nonAppendedClone),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writeZeroModel).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it("patches only meta_descr from the live full form and preserves unknown ordered controls", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.writePageSettings(LAB_PAGE, [
          ["comm", "savepagesettings"],
          ["pageid", LAB_PAGE.pageId],
          ["meta_descr", "after"],
          ["unknown", "changed"],
        ]),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writePageSettings).not.toHaveBeenCalled();

      const intended = [
        ["comm", "savepagesettings"],
        ["pageid", LAB_PAGE.pageId],
        ["meta_descr", "after"],
        ["unknown", "preserve"],
      ] as const;
      await expect(authority.adapter.writePageSettings(LAB_PAGE, intended)).resolves.toEqual({
        operationId: "lease-id",
        dispatched: true,
        ack: "http_ok",
        requestBodyPersisted: false,
      });
      expect(session.writePageSettings).toHaveBeenCalledTimes(1);
      expect(session.writePageSettings).toHaveBeenCalledWith(LAB_PAGE, intended, 12_000);
    } finally {
      await authority.close();
    }
  });

  it("dispatches one exact full page HEAD replacement without publishing or exposing response text", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    const replacement = "<meta name=\"replacement\"><script>void 0;</script>";
    try {
      await expect(
        authority.adapter.writePageHeadCode(
          LAB_PAGE,
          "<meta name=\"baseline\">",
          "<meta name=\"baseline\">",
        ),
      ).rejects.toMatchObject({ code: "WRITE_IDENTITY_REJECTED" });
      expect(session.writePageHeadCode).not.toHaveBeenCalled();
      await expect(
        authority.adapter.writePageHeadCode(LAB_PAGE, replacement, "stale-current-code"),
      ).rejects.toMatchObject({ code: "STALE_TARGET" });
      expect(session.writePageHeadCode).not.toHaveBeenCalled();
      await expect(
        authority.adapter.writePageHeadCode(
          LAB_PAGE,
          replacement,
          "<meta name=\"baseline\">",
        ),
      ).resolves.toEqual({
        operationId: "lease-id",
        dispatched: true,
        ack: "http_ok",
        requestBodyPersisted: false,
      });
      expect(session.readPageHeadCode).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect(session.writePageHeadCode).toHaveBeenCalledWith(
        LAB_PAGE,
        replacement,
        "<meta name=\"baseline\">",
        12_000,
      );
      expect(session.publishPage).not.toHaveBeenCalled();
      await expect(
        authority.adapter.writePageHeadCode(
          LAB_PAGE,
          "second replacement",
          replacement,
        ),
      ).rejects.toMatchObject({ code: "MUTATION_SLOT_CONSUMED" });
      expect(session.writePageHeadCode).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }

    const rejectedSession = fakeSession();
    rejectedSession.writePageHeadCode = vi.fn(async (_target, _intendedCode, _expectedCurrentCode) => ({
      dispatched: true as const,
      httpOk: false,
      status: 200,
      responseBytes: 18,
    }));
    const rejectedAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, rejectedSession),
    );
    try {
      const receipt = await rejectedAuthority.adapter.writePageHeadCode(
        LAB_PAGE,
        replacement,
        "<meta name=\"baseline\">",
      );
      expect(receipt).toMatchObject({ dispatched: true, ack: "http_rejected" });
      expect(Object.keys(receipt).sort()).toEqual([
        "ack",
        "dispatched",
        "operationId",
        "requestBodyPersisted",
      ]);
      expect(JSON.stringify(receipt)).not.toContain("OK");
      expect(rejectedSession.publishPage).not.toHaveBeenCalled();
    } finally {
      await rejectedAuthority.close();
    }
  });

  it("rejects page HEAD writes for a permanent source project before any read or dispatch", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    const sourceTarget = SOURCE_PAGE;
    try {
      await expect(
        authority.adapter.writePageHeadCode(sourceTarget, "blocked", "baseline"),
      ).rejects.toMatchObject({ code: "TARGET_REJECTED" });
      expect(session.readPageHeadCode).not.toHaveBeenCalled();
      expect(session.writePageHeadCode).not.toHaveBeenCalled();
      expect(session.publishPage).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it("dispatches fixed publish and unpublish commands only after exact editor identity reread", async () => {
    const { config, binding } = fixture();
    for (const action of ["publishPage", "unpublishPage"] as const) {
      const session = fakeSession();
      session.readEditorPage = vi.fn(async () => ({
        ...pageSnapshot(),
        published: action === "publishPage" ? "" : "synthetic-published",
      }));
      const authority = await acquireLoopbackBrowserAuthority(
        config,
        {},
        dependencies(binding, session),
      );
      try {
        await expect(authority.adapter[action](LAB_PAGE)).resolves.toEqual({
          operationId: "lease-id",
          dispatched: true,
          ack: "http_ok",
          requestBodyPersisted: false,
        });
        expect(session[action]).toHaveBeenCalledTimes(1);
        expect(session[action]).toHaveBeenCalledWith(LAB_PAGE, 12_000);
        await expect(authority.adapter[action](LAB_PAGE)).rejects.toMatchObject({
          code: "MUTATION_SLOT_CONSUMED",
        });
      } finally {
        await authority.close();
      }
    }
  });

  it("exposes only one opaque fixed page-lifecycle transaction and consumes the lease slot", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    session.readEditorPage = vi.fn(async () => ({ ...pageSnapshot(), published: "" }));
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(authority.adapter.runFixedPageLifecycle(LAB_PAGE)).resolves.toMatchObject({
        baseline: { target: LAB_PAGE, sourcePublished: false },
        restored: {
          target: LAB_PAGE,
          temporaryPageAbsent: true,
          exactBaselineRestored: true,
        },
      });
      expect(session.runFixedPageLifecycle).toHaveBeenCalledWith(LAB_PAGE, 12_000);
      expect("duplicatePage" in authority.adapter).toBe(false);
      expect("sortPages" in authority.adapter).toBe(false);
      expect("deletePage" in authority.adapter).toBe(false);
      await expect(authority.adapter.runFixedPageLifecycle(LAB_PAGE)).rejects.toMatchObject({
        code: "MUTATION_SLOT_CONSUMED",
      });
    } finally {
      await authority.close();
    }
  });

  it("creates one opaque reference-page receipt and cleans up only that clone on a fresh lease", async () => {
    const { config, binding, inventory } = fixture();
    const createSession = fakeSession();
    const createAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, createSession),
    );
    let receipt: Awaited<ReturnType<typeof createAuthority.adapter.createPageFromReference>>;
    try {
      receipt = await createAuthority.adapter.createPageFromReference(LAB_PAGE);
      expect(receipt).toMatchObject({
        kind: "created_reference_page",
        sourceTarget: LAB_PAGE,
        createdTarget: { projectId: LAB_PAGE.projectId, pageId: "9203" },
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      await expect(
        createAuthority.adapter.addKnownTemplate(LAB_PAGE, "128"),
      ).rejects.toMatchObject({ code: "MUTATION_SLOT_CONSUMED" });
    } finally {
      await createAuthority.close();
    }

    const updatedInventory: LiveInventory = Object.freeze({
      ...inventory,
      pageOwnership: Object.freeze({
        ...inventory.pageOwnership,
        [LAB_PAGE.projectId]: Object.freeze([LAB_PAGE.pageId, receipt.createdTarget.pageId]),
      }),
    });
    const updatedHash = hashLiveInventory(updatedInventory);
    const updatedConfig: ResearchConfig = { ...config, inventoryHash: updatedHash };
    const updatedBinding: TrustedBindingEstablished = Object.freeze({
      ...binding,
      inventoryHash: updatedHash,
      inventory: updatedInventory,
      pageCount: binding.pageCount + 1,
    });
    const wrongCleanupSession = fakeSession();
    const wrongCleanupAuthority = await acquireLoopbackBrowserAuthority(
      updatedConfig,
      {
        taskGuard: taskGuard(updatedBinding, {
          writeTargets: [pageTarget()],
          allowedOperations: ["page.reference.clone"],
        }),
      },
      dependencies(updatedBinding, wrongCleanupSession),
    );
    try {
      await expect(wrongCleanupAuthority.adapter.cleanupReferencePage(receipt))
        .rejects.toMatchObject({ code: "TASK_OPERATION_DENIED" });
      expect(wrongCleanupSession.cleanupReferencePage).not.toHaveBeenCalled();
    } finally {
      await wrongCleanupAuthority.close();
    }
    const cleanupManager = new TaskAuthorityManager({
      now: () => new Date(1_000),
      createTaskId: () => "00000000-0000-4000-8000-000000000001",
    });
    const cleanupGrant: MintTaskAuthorityInput = {
      taskDescription: "cleanup one exact reference clone",
      mode: "production",
      observeTargets: [],
      writeTargets: [pageTarget()],
      allowedOperations: ["page.reference.cleanup"],
      binding: {
        accountFingerprint: updatedBinding.accountFingerprint,
        inventoryHash: updatedBinding.inventoryHash,
      },
      ttlMs: 10_000,
    };
    cleanupManager.mint(cleanupGrant);
    const cleanupSession = fakeSession();
    const cleanupDispatch = cleanupSession.cleanupReferencePage;
    cleanupSession.cleanupReferencePage = vi.fn(async (
      ...args: Parameters<typeof cleanupDispatch>
    ) => {
      expect(() => cleanupManager.clear()).toThrow(
        expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }),
      );
      expect(() => cleanupManager.replace({
        ...cleanupGrant,
        taskDescription: "replacement cleanup task",
      })).toThrow(expect.objectContaining({ code: "TASK_AUTHORITY_MUTATION_IN_PROGRESS" }));
      await Promise.resolve();
      return cleanupDispatch(...args);
    });
    const cleanupAuthority = await acquireLoopbackBrowserAuthority(
      updatedConfig,
      { taskGuard: cleanupManager.requireGuard() },
      dependencies(updatedBinding, cleanupSession),
    );
    try {
      await expect(cleanupAuthority.adapter.cleanupReferencePage(receipt)).resolves.toMatchObject({
        removedPageId: receipt.createdTarget.pageId,
        removedPageAbsent: true,
      });
      expect(cleanupSession.cleanupReferencePage).toHaveBeenCalledTimes(1);
      await expect(cleanupAuthority.adapter.cleanupReferencePage(receipt)).rejects.toMatchObject({
        code: "TARGET_REJECTED",
      });
      expect(cleanupSession.cleanupReferencePage).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupAuthority.close();
    }
    expect(cleanupManager.clear()).toBe(true);
  });

  it("adds one known template and returns a process-owned created-record receipt", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(authority.adapter.addKnownTemplate(LAB_PAGE, "128")).resolves.toMatchObject({
        kind: "created_known_template_record",
        templateId: "128",
        target: { ...LAB_RECORD, recordId: "4000000001" },
        identity: { recordType: "128", recordCode: "TL04" },
      });
      expect(session.addKnownTemplate).toHaveBeenCalledWith(LAB_PAGE, "128", 12_000);
      await expect(authority.adapter.addKnownTemplate(LAB_PAGE, "128")).rejects.toMatchObject({
        code: "MUTATION_SLOT_CONSUMED",
      });
      expect(session.addKnownTemplate).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("denies source page settings and consumes a Zero slot before an ambiguous dispatch", async () => {
    const { config, binding } = fixture();
    const sourceSession = fakeSession();
    const sourceAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, sourceSession),
    );
    try {
      await expect(
        sourceAuthority.adapter.writePageSettings(
          SOURCE_PAGE,
          [],
        ),
      ).rejects.toMatchObject({ code: "TARGET_REJECTED" });
      expect(sourceSession.readPageSettings).not.toHaveBeenCalled();
    } finally {
      await sourceAuthority.close();
    }

    const ambiguousSession = fakeSession();
    const ambiguous = new Error("connection closed after Zero dispatch");
    ambiguousSession.writeZeroModel = vi.fn(async () => {
      throw ambiguous;
    });
    const ambiguousAuthority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, ambiguousSession),
    );
    const intended = {
      "0": { elem_id: "1001", type: "text", link: "changed" },
      "1": { elem_id: "1002", type: "shape", left: 10, top: 20, zindex: 1 },
      groups: { preserve: true },
      meta: { preserve: true },
      timestamp: 1,
      unknownMetadata: { preserve: true },
    };
    try {
      await expect(
        ambiguousAuthority.adapter.writeZeroModel(LAB_RECORD, intended),
      ).rejects.toBe(ambiguous);
      await expect(
        ambiguousAuthority.adapter.writeZeroModel(LAB_RECORD, intended),
      ).rejects.toMatchObject({ code: "MUTATION_SLOT_CONSUMED" });
      expect(ambiguousSession.writeZeroModel).toHaveBeenCalledTimes(1);
    } finally {
      await ambiguousAuthority.close();
    }
  });

  it("consumes the mutation slot before an ambiguous thrown dispatch and never retries", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const ambiguous = new Error("connection closed after dispatch");
    session.writeStandard = vi.fn(async () => {
      throw ambiguous;
    });
    const authority = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding, session),
    );
    try {
      await expect(
        authority.adapter.writeStandard(LAB_RECORD, "title", "value"),
      ).rejects.toBe(ambiguous);
      await expect(
        authority.adapter.writeStandard(LAB_RECORD, "title", "value"),
      ).rejects.toMatchObject({ code: "MUTATION_SLOT_CONSUMED" });
      expect(session.writeStandard).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  it("restores and closes on blocked binding and releases the lease", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const blocked: TrustedBindingCapture = {
      status: "BLOCKED",
      code: "AUTHENTICATION_REQUIRED",
      message: "Sign in.",
    };
    await expect(
      acquireLoopbackBrowserAuthority(config, {}, dependencies(blocked, session)),
    ).rejects.toMatchObject({ code: "BINDING_BLOCKED" });
    expect(session.restoreRoot).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);

    const recovered = await acquireLoopbackBrowserAuthority(
      config,
      {},
      dependencies(binding),
    );
    await recovered.close();
  });

  it("the lifecycle wrapper restores and closes in finally", async () => {
    const { config, binding } = fixture();
    const session = fakeSession();
    const error = new Error("adapter failed");
    await expect(
      withLoopbackBrowserAuthority(
        config,
        async () => {
          throw error;
        },
        {},
        dependencies(binding, session),
      ),
    ).rejects.toBe(error);
    expect(session.restoreRoot).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("preserves capture-owned close by default and leaves caller-owned sessions open", async () => {
    const { config } = fixture();
    const rootProbe = {
      host: "tilda.ru",
      route: "/projects/",
      href: "https://tilda.ru/projects/",
      authenticated: true,
      uiReady: true,
      projectIds: [LAB_PAGE.projectId],
      projectCardCount: 1,
      projectPaginationDetected: false,
      failures: [],
    };
    const identityProbe = {
      host: "tilda.ru",
      route: "/identity/",
      href: "https://tilda.ru/identity/",
      authenticated: true,
      uiReady: true,
      stableAccountIdentity: "12345",
      accountIdentitySource: "identity_hidden_useruid" as const,
    };
    const projectProbe = {
      host: "tilda.ru",
      route: "/projects/",
      href: `https://tilda.ru/projects/?projectid=${LAB_PAGE.projectId}`,
      authenticated: true,
      uiReady: true,
      id: LAB_PAGE.projectId,
      pageIds: [LAB_PAGE.pageId],
      pageCardCount: 1,
      expectedPageCount: 1,
      expectedProjectCount: 1,
      paginationDetected: false,
      failures: [],
    };
    const bindingConfig: ResearchConfig = {
      ...config,
      bindingKeyPath: resolve(
        process.cwd(),
        ".tilda-runtime",
        `missing-authority-test-${Date.now()}.key`,
      ),
    };
    const bindingSession = (): AuthorityOwnedLoopbackBrowserSession => ({
      ...fakeSession(),
      readRoot: vi.fn(async () => rootProbe),
      readIdentity: vi.fn(async () => identityProbe),
      readProject: vi.fn(async () => projectProbe),
      restoreRoot: vi.fn(async () => rootProbe),
    });

    const owned = bindingSession();
    await expect(
      captureTrustedLiveBindingWithSession(bindingConfig, owned),
    ).resolves.toMatchObject({ status: "BLOCKED", code: "BINDING_KEY_UNAVAILABLE" });
    expect(owned.restoreRoot).toHaveBeenCalledTimes(1);
    expect(owned.close).toHaveBeenCalledTimes(1);

    const borrowed = bindingSession();
    await expect(
      captureTrustedLiveBindingWithSession(bindingConfig, borrowed, {}, "caller_owned"),
    ).resolves.toMatchObject({ status: "BLOCKED", code: "BINDING_KEY_UNAVAILABLE" });
    expect(borrowed.restoreRoot).toHaveBeenCalledTimes(1);
    expect(borrowed.close).not.toHaveBeenCalled();
    await borrowed.close();
  });

  it("reports typed authority errors", () => {
    const error = new BrowserAuthorityError("AUTHORITY_BUSY", "busy");
    expect(error.name).toBe("BrowserAuthorityError");
    expect(error.code).toBe("AUTHORITY_BUSY");
  });
});
