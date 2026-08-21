import { CdpConnection, type CdpTarget } from "./cdp-client.js";
import type { LabPageTarget, LabRecordTarget } from "./config.js";
import {
  IDENTITY_DOM_PROBE,
  PROJECTS_ROOT_DOM_PROBE,
  PROJECT_PAGES_DOM_PROBE,
  type IdentityProbe,
  type ProjectPagesProbe,
  type ProjectsRootProbe,
} from "./probes.js";

const CANONICAL_ID = /^[1-9][0-9]*$/;
const MAX_PROBE_TIMEOUT_MS = 12_000;

export type TrustedBrowserTransport = "loopback_cdp" | "extension_stdio";

/**
 * Narrow read-only session used by trusted binding. It deliberately exposes no
 * generic CDP send/evaluate method and accepts no arbitrary URL.
 */
export interface TrustedBrowserSession {
  readonly sessionId: string;
  readonly transport: TrustedBrowserTransport;
  readRoot(timeoutMs: number): Promise<ProjectsRootProbe>;
  readIdentity(timeoutMs: number): Promise<IdentityProbe>;
  readProject(projectId: string, timeoutMs: number): Promise<ProjectPagesProbe>;
  restoreRoot(timeoutMs: number): Promise<ProjectsRootProbe>;
  close(): Promise<void>;
}

export interface EditorRecordIdentity {
  readonly recordId: string;
  readonly recordType: string;
  readonly recordCode: string;
  readonly recordCategory: string;
}

export interface ExactEditorPageSnapshot {
  readonly uiReady: boolean;
  readonly host: string;
  readonly route: string;
  readonly href: string;
  readonly authenticated: boolean;
  readonly target: LabPageTarget;
  readonly records: readonly EditorRecordIdentity[];
  readonly changed: string | null;
  readonly published: string | null;
  readonly editorLoadedAnchor: boolean;
  readonly scriptPaths: readonly string[];
}

export interface ExactEditorRecordRead {
  readonly target: LabRecordTarget;
  readonly identity: EditorRecordIdentity;
  readonly status: number;
  readonly contentType: string;
  /** Adapter-private live data. Callers must not persist it without sanitization. */
  readonly payload: unknown;
  /** Exact reproduced standard field from rendered record DOM; absent on non-standard reads. */
  readonly writableField?: {
    readonly name: StandardWritableField;
    readonly value: string;
    readonly representation: "rendered_inner_html" | "absent_empty";
  };
  /** All unambiguous rendered `[field]` values; read-only unless a recipe promotes one. */
  readonly renderedFields?: readonly {
    readonly name: string;
    readonly value: string;
    readonly representation: "rendered_inner_html";
  }[];
  /** Duplicate rendered field names are never patchable. */
  readonly ambiguousRenderedFields?: readonly string[];
}

/**
 * DOM-only evidence that one hover-revealed control belongs to the exact
 * editor record. The primitive never clicks the control and never uses screen
 * coordinates.
 */
export interface ExactRecordHoverControlReveal {
  readonly target: LabRecordTarget;
  readonly identity: EditorRecordIdentity;
  readonly controlKey: string;
  readonly ownerRecordId: string;
  readonly tagName: string;
  readonly connected: true;
}

export interface RenderedBlockLibraryTemplate {
  readonly templateId: string;
  readonly code: string;
  readonly category: string | null;
}

export interface RenderedBlockLibraryIndex {
  readonly target: LabPageTarget;
  readonly categories: readonly string[];
  readonly templates: readonly RenderedBlockLibraryTemplate[];
  readonly mutationIssued: false;
}

export type KnownObservedTemplateId = "128" | "778" | "131" | "396";

export interface KnownTemplateAddPreflight {
  readonly target: LabPageTarget;
  readonly templateId: KnownObservedTemplateId;
  readonly runtimeFunction: "tp__addRecord";
  readonly runtimeFunctionHash: string;
  readonly ready: boolean;
  readonly mutationIssued: false;
  readonly evidence: "LIVE_OBSERVED_PREFLIGHT_ONLY";
}

export interface ExactPageSettingsRead {
  readonly target: LabPageTarget;
  /** Native FormData order, including duplicate and unknown successful controls. */
  readonly fields: readonly (readonly [string, string])[];
}

export interface ExactPageHeadCodeRead {
  readonly uiReady: boolean;
  readonly host: string;
  readonly route: string;
  readonly href: string;
  readonly target: LabPageTarget;
  /** Full page-specific HEAD code. Adapter-private untrusted content. */
  readonly code: string;
  readonly saveFunctionHash: string;
}

export interface FixedPageLifecycleResult {
  readonly baseline: {
    readonly target: LabPageTarget;
    readonly activePageIds: readonly string[];
    readonly pageOrder: readonly string[];
    readonly sourceRecordIds: readonly string[];
    readonly sourcePublished: boolean;
    readonly sourceChanged: string | null;
  };
  readonly restored: {
    readonly target: LabPageTarget;
    readonly activePageIds: readonly string[];
    readonly pageOrder: readonly string[];
    readonly sourceRecordIds: readonly string[];
    readonly sourcePublished: boolean;
    readonly sourceChanged: string | null;
    readonly temporaryPageId: string;
    readonly temporaryPageAbsent: boolean;
    readonly pageOrderRestored: boolean;
    readonly sourceUnchanged: boolean;
    readonly exactBaselineRestored: boolean;
  };
}

export interface FixedReferencePageCreateResult {
  readonly baseline: {
    readonly target: LabPageTarget;
    readonly activePageIds: readonly string[];
    readonly pageOrder: readonly string[];
    readonly sourceRecords: readonly EditorRecordIdentity[];
  };
  readonly created: {
    readonly target: LabPageTarget;
    readonly activePageIds: readonly string[];
    readonly pageOrder: readonly string[];
    readonly records: readonly EditorRecordIdentity[];
    readonly published: false;
  };
}

export interface FixedReferencePageCleanupResult {
  readonly sourceTarget: LabPageTarget;
  readonly removedPageId: string;
  readonly activePageIds: readonly string[];
  readonly pageOrder: readonly string[];
  readonly removedPageAbsent: true;
  readonly sourceRecords: readonly EditorRecordIdentity[];
}

export interface FixedKnownTemplateAddResult {
  readonly target: LabPageTarget;
  readonly templateId: KnownObservedTemplateId;
  readonly beforeRecords: readonly EditorRecordIdentity[];
  readonly afterRecords: readonly EditorRecordIdentity[];
  readonly createdRecord: EditorRecordIdentity;
  readonly publishedUnchanged: true;
}

export function isReadyExactEditorPageSnapshot(probe: ExactEditorPageSnapshot): boolean {
  return (
    probe.uiReady &&
    probe.authenticated &&
    probe.published !== null &&
    probe.editorLoadedAnchor &&
    probe.records.length > 0
  );
}

export type StandardWritableField = string;

/** Private transport result reduced to an opaque receipt by browser authority. */
export interface FixedBrowserDispatchResult {
  readonly dispatched: true;
  readonly httpOk: boolean;
  readonly status: number;
  readonly responseBytes: number;
}

/** Read-only result from the fixed Zero writer's body-construction preflight. */
export interface FixedZeroWritePreflightResult {
  readonly preflight: true;
  readonly code: "READY" | "REJECTED";
  readonly subreason?:
    | "CLEAN_MODEL_NOT_HYDRATED"
    | "CLEAN_MODEL_REJECTED"
    | "ELEMENT_ORDER_REJECTED"
    | "MODEL_METADATA_CHANGED"
    | "DIFF_REJECTED"
    | "FRAME_UNAVAILABLE"
    | "MODEL_CHANGED_BEFORE_DISPATCH"
    | "GRID_REJECTED"
    | "BODY_REJECTED"
    | "RUNTIME_READ_REJECTED"
    | "UNKNOWN_REJECTION";
  readonly drift?: {
    readonly topLevelKeys: readonly string[];
    readonly elementFieldNames: readonly string[];
    readonly changedElementCount: number;
    readonly elementKeySetChanged: boolean;
  };
}

/** Exact application acknowledgement used by Tilda's record-only save helper. */
export function hasExactRecordWriteApplicationAck(
  responseOk: boolean,
  responseText: string,
): boolean {
  return responseOk && responseText.trim() === "OK";
}

/**
 * Same-connection browser surface for a future adapter-owned authority. It is
 * intentionally limited to checked-in semantic reads and exposes neither CDP
 * send/evaluate nor arbitrary JavaScript/URLs.
 */
export interface AuthorityOwnedLoopbackBrowserSession extends TrustedBrowserSession {
  readEditorPage(target: LabPageTarget, timeoutMs: number): Promise<ExactEditorPageSnapshot>;
  readStandardSettings(target: LabRecordTarget, timeoutMs: number): Promise<ExactEditorRecordRead>;
  readT123Content(target: LabRecordTarget, timeoutMs: number): Promise<ExactEditorRecordRead>;
  readZeroModel(target: LabRecordTarget, timeoutMs: number): Promise<ExactEditorRecordRead>;
  readZeroServerRepresentation(
    target: LabRecordTarget,
    timeoutMs: number,
  ): Promise<ExactEditorRecordRead>;
  revealExactRecordControl(
    target: LabRecordTarget,
    expectedIdentity: EditorRecordIdentity,
    controlKey: string,
    timeoutMs: number,
  ): Promise<ExactRecordHoverControlReveal>;
  readRenderedBlockLibrary(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<RenderedBlockLibraryIndex>;
  preflightKnownTemplateAdd(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs: number,
  ): Promise<KnownTemplateAddPreflight>;
  writeStandard(
    target: LabRecordTarget,
    field: StandardWritableField,
    value: string,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  writeT123(
    target: LabRecordTarget,
    code: string,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  writeZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  preflightZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number,
  ): Promise<FixedZeroWritePreflightResult>;
  readPageSettings(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<ExactPageSettingsRead>;
  writePageSettings(
    target: LabPageTarget,
    intendedFields: readonly (readonly [string, string])[],
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  readPageHeadCode(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<ExactPageHeadCodeRead>;
  writePageHeadCode(
    target: LabPageTarget,
    intendedCode: string,
    expectedCurrentCode: string,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  publishPage(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  unpublishPage(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult>;
  runFixedPageLifecycle(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedPageLifecycleResult>;
  createPageFromReference(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedReferencePageCreateResult>;
  cleanupReferencePage(
    sourceTarget: LabPageTarget,
    createdPageId: string,
    expectedActivePageIds: readonly string[],
    expectedPageOrder: readonly string[],
    expectedSourceRecords: readonly EditorRecordIdentity[],
    expectedCreatedRecords: readonly EditorRecordIdentity[],
    timeoutMs: number,
  ): Promise<FixedReferencePageCleanupResult>;
  addKnownTemplate(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs: number,
  ): Promise<FixedKnownTemplateAddResult>;
}

function normalizeProbeTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Trusted browser probe timeout must be a positive integer.");
  }
  return Math.min(timeoutMs, MAX_PROBE_TIMEOUT_MS);
}

function assertRootUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "tilda.ru" ||
    url.pathname !== "/projects/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.searchParams.has("projectid") ||
    url.searchParams.has("projectId")
  ) {
    throw new Error("Trusted binding requires the exact top-level Tilda projects route.");
  }
  return url;
}

function projectUrl(projectId: string): URL {
  if (!CANONICAL_ID.test(projectId)) {
    throw new Error("Trusted project probe requires a canonical project ID.");
  }
  const url = new URL("https://tilda.ru/projects/");
  url.searchParams.set("projectid", projectId);
  return url;
}

function canonicalPageTarget(target: LabPageTarget): LabPageTarget {
  if (!CANONICAL_ID.test(target.projectId) || !CANONICAL_ID.test(target.pageId)) {
    throw new Error("Trusted editor target requires canonical project and page IDs.");
  }
  return Object.freeze({ projectId: target.projectId, pageId: target.pageId });
}

function canonicalRecordTarget(target: LabRecordTarget): LabRecordTarget {
  const page = canonicalPageTarget(target);
  if (!CANONICAL_ID.test(target.recordId)) {
    throw new Error("Trusted editor target requires a canonical record ID.");
  }
  return Object.freeze({ ...page, recordId: target.recordId });
}

function editorPageUrl(target: LabPageTarget): URL {
  const canonical = canonicalPageTarget(target);
  const url = new URL("https://tilda.ru/page/");
  url.searchParams.set("pageid", canonical.pageId);
  url.searchParams.set("projectid", canonical.projectId);
  return url;
}

function pageHeadCodeUrl(target: LabPageTarget): URL {
  const canonical = canonicalPageTarget(target);
  const url = new URL("https://tilda.ru/projects/editheadcode/");
  url.searchParams.set("projectid", canonical.projectId);
  url.searchParams.set("pageid", canonical.pageId);
  return url;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDomProbe<T extends { uiReady: boolean }>(
  connection: CdpConnection,
  expression: string,
  accept: (probe: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + normalizeProbeTimeout(timeoutMs);
  let lastError: unknown = null;
  let lastUiReady = false;
  let lastAccepted = false;
  while (Date.now() < deadline) {
    try {
      const probe = await connection.evaluate<T>(expression);
      lastUiReady = probe.uiReady;
      lastAccepted = accept(probe);
      if (lastUiReady && lastAccepted) return probe;
    } catch (error) {
      lastError = error;
    }
    await delay(125);
  }
  throw new Error(
    lastError instanceof Error
      ? `Timed out waiting for rendered Tilda UI (${lastError.message}).`
      : `Timed out waiting for rendered Tilda UI (uiReady=${lastUiReady}, routeMatched=${lastAccepted}).`,
  );
}

function exactProbeUrl(probe: { host: string; route: string; href: string }, expected: URL): boolean {
  try {
    const actual = new URL(probe.href);
    return (
      probe.host === expected.hostname &&
      probe.route === expected.pathname &&
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    );
  } catch {
    return false;
  }
}

async function navigateAndProbe<T extends { uiReady: boolean; host: string; route: string; href: string }>(
  connection: CdpConnection,
  url: URL,
  expression: string,
  timeoutMs: number,
  acceptProbe: (probe: T) => boolean = () => true,
): Promise<T> {
  const navigation = await connection.send<{ errorText?: string }>("Page.navigate", {
    url: url.href,
  });
  if (navigation.errorText !== undefined && navigation.errorText !== "") {
    throw new Error("The dedicated CDP tab could not navigate to the required read-only route.");
  }
  return waitForDomProbe<T>(
    connection,
    expression,
    (probe) => exactProbeUrl(probe, url) && acceptProbe(probe),
    timeoutMs,
  );
}

const EDITOR_PAGE_PROBE = String.raw`(target => {
  const url = new URL(location.href);
  const loginSurface = Boolean(
    document.querySelector('input[type="password"], form[action*="login" i], [class*="login" i] input')
  ) || /\/login|\/signin/i.test(url.pathname);
  const nodes = Array.from(document.querySelectorAll('[data-record-id], [data-recordid], [id^="record"]'));
  const seen = new Set();
  const records = [];
  const attribute = (node, names) => {
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value !== null && value !== "") return value;
    }
    return "";
  };
  for (const node of nodes) {
    const recordId = attribute(node, ["data-record-id", "data-recordid"]) ||
      ((node.id || "").match(/^record([1-9]\d*)$/i) || [])[1] || "";
    if (!/^[1-9]\d*$/.test(recordId) || seen.has(recordId)) continue;
    const recordType = attribute(node, ["data-record-type", "data-recordtype"]);
    const recordCode = attribute(node, ["data-record-cod", "data-recordcod"]);
    const recordCategory = attribute(node, ["data-record-category", "data-recordcategory"]);
    if (!recordType || !recordCode || !recordCategory) continue;
    seen.add(recordId);
    records.push({ recordId, recordType, recordCode, recordCategory });
  }
  const inputValue = names => {
    for (const name of names) {
      const node = document.querySelector('[name="' + name + '"], #' + name);
      if (node && "value" in node) return String(node.value || "") || null;
    }
    return null;
  };
  const globalString = names => {
    for (const name of names) {
      const value = window[name];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
    return null;
  };
  const scriptPaths = Array.from(document.scripts).map(script => {
    try { return new URL(script.src, location.href).pathname; } catch { return ""; }
  }).filter(Boolean).sort();
  const globalId = names => {
    for (const name of names) {
      const value = window[name];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
    return "";
  };
  const loadedContainer = document.querySelector("#allrecords, .t-records");
  const editorLoadedAnchor =
    globalId(["projectid", "projectId"]) === target.projectId &&
    globalId(["pageid", "pageId"]) === target.pageId &&
    typeof window.pagepublished === "string" &&
    loadedContainer instanceof HTMLElement &&
    loadedContainer.isConnected;
  return {
    uiReady: document.readyState !== "loading",
    host: url.hostname,
    route: url.pathname,
    href: url.href,
    authenticated: !loginSurface,
    target,
    records,
    changed: inputValue(["changed", "pagechanged"]) ?? globalString(["pagechanged", "changed"]),
    published: inputValue(["published", "pagepublished"]) ?? globalString(["pagepublished", "published"]),
    editorLoadedAnchor,
    scriptPaths
  };
})`;

const EXACT_RECORD_READ_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.get("pageid") !== input.target.pageId
  ) throw new Error("AUTHORITY_EDITOR_TARGET_MISMATCH");
  const record = document.getElementById("record" + input.target.recordId) ||
    document.querySelector('[data-record-id="' + input.target.recordId + '"]') ||
    document.querySelector('[data-recordid="' + input.target.recordId + '"]');
  if (!record) throw new Error("AUTHORITY_RECORD_TARGET_MISMATCH");
  const readAttribute = names => {
    for (const name of names) {
      const value = record.getAttribute(name);
      if (value !== null && value !== "") return value;
    }
    return "";
  };
  const identity = {
    recordId: input.target.recordId,
    recordType: readAttribute(["data-record-type", "data-recordtype"]),
    recordCode: readAttribute(["data-record-cod", "data-recordcod"]),
    recordCategory: readAttribute(["data-record-category", "data-recordcategory"])
  };
  if (!identity.recordType || !identity.recordCode || !identity.recordCategory) {
    throw new Error("AUTHORITY_RECORD_IDENTITY_INCOMPLETE");
  }
  let path;
  let body;
  if (input.kind === "standard") {
    path = "/page/edit/";
    body = new URLSearchParams({
      comm: "editrecordsettings",
      pageid: input.target.pageId,
      recordid: input.target.recordId,
      tab: "settings"
    });
  } else if (input.kind === "t123") {
    path = "/page/edit/";
    body = new URLSearchParams({
      comm: "editrecordcontent",
      pageid: input.target.pageId,
      recordid: input.target.recordId,
      tab: "content"
    });
  } else if (input.kind === "zero_server") {
    path = "/zero/get/";
    body = new FormData();
    body.set("comm", "getzerocode");
    body.set("pageid", input.target.pageId);
    body.set("recordid", input.target.recordId);
  } else {
    throw new Error("AUTHORITY_READ_KIND_REJECTED");
  }
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    ...(body instanceof URLSearchParams ? {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      }
    } : {}),
    body
  });
  const responseUrl = new URL(response.url);
  if (!response.ok || responseUrl.origin !== location.origin || responseUrl.pathname !== path) {
    throw new Error("AUTHORITY_READ_RESPONSE_REJECTED");
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("AUTHORITY_RESPONSE_JSON_REJECTED"); }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AUTHORITY_RESPONSE_SHAPE_REJECTED");
  }
  let writableField;
  let renderedFields;
  let ambiguousRenderedFields;
  if (input.kind === "standard") {
    const fields = new Map();
    for (const node of Array.from(record.querySelectorAll("[field]"))) {
      const name = node.getAttribute("field") || "";
      if (!/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(name) || !(node instanceof HTMLElement)) continue;
      if (fields.has(name)) fields.set(name, null);
      else fields.set(name, node.innerHTML);
    }
    renderedFields = Array.from(fields.entries())
      .filter((entry) => typeof entry[1] === "string")
      .map(([name, value]) => ({ name, value, representation: "rendered_inner_html" }));
    ambiguousRenderedFields = Array.from(fields.entries())
      .filter((entry) => entry[1] === null)
      .map(([name]) => name)
      .sort();
    let field;
    if (identity.recordType === "128" && identity.recordCode === "TL04") field = "title";
    else if (identity.recordType === "778" && identity.recordCode === "ST310N") field = "buttontitle";
    if (field !== undefined) {
      const nodes = Array.from(record.querySelectorAll('[field="' + field + '"]'));
      if (nodes.length > 1 || (field === "title" && nodes.length !== 1)) {
        throw new Error("AUTHORITY_STANDARD_FIELD_AMBIGUOUS");
      }
      if (nodes.length === 0) {
        writableField = { name: field, value: "", representation: "absent_empty" };
      } else {
        const fieldNode = nodes[0];
        if (!(fieldNode instanceof HTMLElement) || typeof fieldNode.innerHTML !== "string") {
          throw new Error("AUTHORITY_STANDARD_FIELD_SHAPE_REJECTED");
        }
        writableField = {
          name: field,
          value: fieldNode.innerHTML,
          representation: "rendered_inner_html"
        };
      }
    }
  }
  return {
    target: input.target,
    identity,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    payload,
    ...(renderedFields === undefined ? {} : { renderedFields }),
    ...(ambiguousRenderedFields === undefined ? {} : { ambiguousRenderedFields }),
    ...(writableField === undefined ? {} : { writableField })
  };
}`;

const FIXED_RECORD_WRITE_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.get("pageid") !== input.target.pageId
  ) throw new Error("AUTHORITY_EDITOR_TARGET_MISMATCH");
  const record = document.getElementById("record" + input.target.recordId) ||
    document.querySelector('[data-record-id="' + input.target.recordId + '"]') ||
    document.querySelector('[data-recordid="' + input.target.recordId + '"]');
  if (!record) throw new Error("AUTHORITY_RECORD_TARGET_MISMATCH");
  const readAttribute = names => {
    for (const name of names) {
      const value = record.getAttribute(name);
      if (value !== null && value !== "") return value;
    }
    return "";
  };
  const recordType = readAttribute(["data-record-type", "data-recordtype"]);
  const recordCode = readAttribute(["data-record-cod", "data-recordcod"]);
  const body = new URLSearchParams();
  body.set("comm", "saverecord");
  body.set("pageid", input.target.pageId);
  body.set("recordid", input.target.recordId);
  if (input.kind === "standard") {
    if (
      !/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(input.field) ||
      recordType === "" ||
      recordCode === "" ||
      typeof input.value !== "string"
    ) {
      throw new Error("AUTHORITY_STANDARD_WRITE_CONTRACT_REJECTED");
    }
    body.set("onlythisfield", input.field);
    body.set(input.field, input.value);
  } else if (input.kind === "t123") {
    if (recordType !== "131" || recordCode !== "T123" || typeof input.code !== "string") {
      throw new Error("AUTHORITY_T123_WRITE_CONTRACT_REJECTED");
    }
    body.set("code", input.code);
  } else {
    throw new Error("AUTHORITY_WRITE_KIND_REJECTED");
  }
  const response = await fetch("/page/submit/", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== location.origin || responseUrl.pathname !== "/page/submit/") {
    throw new Error("AUTHORITY_WRITE_RESPONSE_TARGET_REJECTED");
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  let responseBytes = 0;
  let responseText = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
      }
      responseText += decoder.decode(next.value, { stream: true });
    }
    responseText += decoder.decode();
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    responseBytes = bytes.byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
    responseText = new TextDecoder().decode(bytes);
  }
  const applicationAcknowledged = (${hasExactRecordWriteApplicationAck.toString()})(
    response.ok,
    responseText
  );
  return {
    dispatched: true,
    httpOk: applicationAcknowledged,
    status: response.status,
    responseBytes
  };
}`;

const ZERO_OPEN_COMMAND = String.raw`(async input => {
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.getAll("pageid").length !== 1 ||
    url.searchParams.get("pageid") !== input.target.pageId ||
    url.hash !== ""
  ) throw new Error("AUTHORITY_EDITOR_TARGET_MISMATCH");
  if (typeof window.tp__record__getRecordElement !== "function") {
    throw new Error("AUTHORITY_ZERO_RECORD_GETTER_MISSING");
  }
  const record = window.tp__record__getRecordElement(input.target.recordId);
  if (
    !(record instanceof HTMLElement) ||
    !record.isConnected ||
    record.id !== "record" + input.target.recordId ||
    record.getAttribute("data-record-type") !== "396" ||
    record.getAttribute("data-record-cod") !== "T396"
  ) throw new Error("AUTHORITY_ZERO_RECORD_IDENTITY_REJECTED");
  const uiControl = record.uiControl;
  let elements = uiControl && uiControl.elements;
  let contentButton = elements && Object.hasOwn(elements, "contentButton")
    ? elements.contentButton
    : null;
  if (
    contentButton instanceof HTMLElement &&
    !contentButton.isConnected &&
    uiControl &&
    typeof uiControl.handlePointerEnter === "function" &&
    uiControl.handlePointerEnter.length === 0
  ) {
    uiControl.handlePointerEnter();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !contentButton.isConnected) {
      await new Promise(resolve => setTimeout(resolve, 25));
      elements = uiControl.elements;
      contentButton = elements && Object.hasOwn(elements, "contentButton")
        ? elements.contentButton
        : null;
    }
  }
  if (
    !elements ||
    !Object.hasOwn(elements, "contentButton") ||
    !(contentButton instanceof HTMLElement) ||
    !contentButton.isConnected
  ) throw new Error("AUTHORITY_ZERO_CONTENT_CONTROL_REJECTED");
  contentButton.click();
  return { opened: true };
})`;

const EXACT_RECORD_HOVER_CONTROL_REVEAL_PROBE = String.raw`async input => {
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.getAll("pageid").length !== 1 ||
    url.searchParams.get("pageid") !== input.target.pageId ||
    url.hash !== ""
  ) throw new Error("AUTHORITY_EDITOR_TARGET_MISMATCH");
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.controlKey)) {
    throw new Error("AUTHORITY_RECORD_CONTROL_KEY_REJECTED");
  }
  const record = document.getElementById("record" + input.target.recordId) ||
    document.querySelector('[data-record-id="' + input.target.recordId + '"]') ||
    document.querySelector('[data-recordid="' + input.target.recordId + '"]');
  if (!(record instanceof HTMLElement) || !record.isConnected) {
    throw new Error("AUTHORITY_RECORD_TARGET_MISMATCH");
  }
  const attribute = names => {
    for (const name of names) {
      const value = record.getAttribute(name);
      if (value !== null && value !== "") return value;
    }
    return "";
  };
  const identity = {
    recordId: input.target.recordId,
    recordType: attribute(["data-record-type", "data-recordtype"]),
    recordCode: attribute(["data-record-cod", "data-recordcod"]),
    recordCategory: attribute(["data-record-category", "data-recordcategory"])
  };
  if (
    identity.recordId !== input.expectedIdentity.recordId ||
    identity.recordType !== input.expectedIdentity.recordType ||
    identity.recordCode !== input.expectedIdentity.recordCode ||
    identity.recordCategory !== input.expectedIdentity.recordCategory
  ) throw new Error("AUTHORITY_RECORD_IDENTITY_CHANGED");
  const uiControl = record.uiControl;
  if (!uiControl || typeof uiControl !== "object") {
    throw new Error("AUTHORITY_RECORD_UI_CONTROL_MISSING");
  }
  const readControl = () => {
    const elements = uiControl.elements;
    return elements && Object.hasOwn(elements, input.controlKey)
      ? elements[input.controlKey]
      : null;
  };
  let control = readControl();
  if (!(control instanceof HTMLElement) || !control.isConnected) {
    const pointerEnter = typeof PointerEvent === "function"
      ? new PointerEvent("pointerenter", { bubbles: false, cancelable: false })
      : new Event("pointerenter", { bubbles: false, cancelable: false });
    record.dispatchEvent(pointerEnter);
    record.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: false }));
    control = readControl();
    if (
      (!(control instanceof HTMLElement) || !control.isConnected) &&
      typeof uiControl.handlePointerEnter === "function" &&
      uiControl.handlePointerEnter.length === 0
    ) {
      uiControl.handlePointerEnter();
    }
    const deadline = Date.now() + Math.min(input.waitMs, 1500);
    while (Date.now() < deadline) {
      control = readControl();
      if (control instanceof HTMLElement && control.isConnected) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!(control instanceof HTMLElement) || !control.isConnected) {
    throw new Error("AUTHORITY_RECORD_CONTROL_NOT_REVEALED");
  }
  const editorRecords = Array.from(document.querySelectorAll('[id^="record"], [data-record-id], [data-recordid]'))
    .filter(candidate => candidate instanceof HTMLElement);
  const controllerOwners = editorRecords.filter(candidate => candidate.uiControl === uiControl);
  const controlOwners = editorRecords.filter(candidate => {
    const candidateControl = candidate.uiControl;
    const elements = candidateControl && typeof candidateControl === "object"
      ? candidateControl.elements : null;
    return elements && Object.hasOwn(elements, input.controlKey) && elements[input.controlKey] === control;
  });
  const closestOwner = control.closest('[data-record-id], [data-recordid], [id^="record"]');
  if (
    controllerOwners.length !== 1 || controllerOwners[0] !== record ||
    controlOwners.length !== 1 || controlOwners[0] !== record ||
    (closestOwner !== null && closestOwner !== record)
  ) {
    throw new Error("AUTHORITY_RECORD_CONTROL_OWNERSHIP_REJECTED");
  }
  return {
    target: input.target,
    identity,
    controlKey: input.controlKey,
    ownerRecordId: input.target.recordId,
    tagName: control.tagName.toLowerCase(),
    connected: true
  };
}`;

const RENDERED_BLOCK_LIBRARY_READ_PROBE = String.raw`input => {
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.getAll("pageid").length !== 1 ||
    url.searchParams.get("pageid") !== input.target.pageId ||
    url.hash !== ""
  ) throw new Error("AUTHORITY_EDITOR_TARGET_MISMATCH");
  const attribute = (node, names) => {
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value !== null && value.trim() !== "") return value.trim();
    }
    return "";
  };
  const candidates = Array.from(document.querySelectorAll(
    "[data-tplid], [data-tpl-id], [data-template-id]"
  ));
  if (candidates.length > 5000) throw new Error("AUTHORITY_BLOCK_LIBRARY_TOO_LARGE");
  const templates = [];
  const seen = new Set();
  for (const node of candidates) {
    const templateId = attribute(node, ["data-tplid", "data-tpl-id", "data-template-id"]);
    const code = attribute(node, ["data-record-code", "data-record-cod", "data-code"]);
    if (!/^[1-9]\d*$/.test(templateId) || !/^[A-Z][A-Z0-9]{1,15}$/.test(code)) continue;
    const owner = node.closest("[data-category], [data-category-name], [data-block-category]");
    const category = owner
      ? attribute(owner, ["data-category", "data-category-name", "data-block-category"])
      : "";
    const key = templateId + ":" + code;
    if (seen.has(key)) continue;
    seen.add(key);
    templates.push({ templateId, code, category: category || null });
  }
  if (templates.length === 0) {
    throw new Error("AUTHORITY_BLOCK_LIBRARY_NOT_RENDERED_OR_UNRECOGNIZED");
  }
  const categories = Array.from(new Set(templates.map(item => item.category).filter(Boolean))).sort();
  templates.sort((left, right) => Number(left.templateId) - Number(right.templateId));
  return { target: input.target, categories, templates, mutationIssued: false };
}`;

const KNOWN_TEMPLATE_ADD_PREFLIGHT_PROBE = String.raw`async input => {
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.getAll("pageid").length !== 1 ||
    url.searchParams.get("pageid") !== input.target.pageId ||
    url.hash !== "" ||
    !["128", "778", "131", "396"].includes(input.templateId)
  ) throw new Error("AUTHORITY_KNOWN_TEMPLATE_PREFLIGHT_REJECTED");
  if (typeof window.tp__addRecord !== "function") {
    throw new Error("AUTHORITY_ADD_RECORD_RUNTIME_MISSING");
  }
  const bytes = new TextEncoder().encode(Function.prototype.toString.call(window.tp__addRecord));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const runtimeFunctionHash = Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
  return {
    target: input.target,
    templateId: input.templateId,
    runtimeFunction: "tp__addRecord",
    runtimeFunctionHash,
    ready: runtimeFunctionHash === input.expectedRuntimeFunctionHash,
    mutationIssued: false,
    evidence: "LIVE_OBSERVED_PREFLIGHT_ONLY"
  };
}`;

const FIXED_KNOWN_TEMPLATE_ADD_COMMAND = String.raw`async input => {
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" ||
    url.pathname !== "/page/" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.get("pageid") !== input.target.pageId ||
    String(window.projectid ?? "") !== input.target.projectId ||
    String(window.pageid ?? "") !== input.target.pageId ||
    !["128", "778", "131", "396"].includes(input.templateId) ||
    typeof window.tp__addRecord !== "function"
  ) throw new Error("AUTHORITY_KNOWN_TEMPLATE_ADD_TARGET_REJECTED");
  const bytes = new TextEncoder().encode(Function.prototype.toString.call(window.tp__addRecord));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const runtimeHash = Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
  if (runtimeHash !== input.expectedRuntimeFunctionHash) {
    throw new Error("AUTHORITY_ADD_RECORD_RUNTIME_CHANGED");
  }
  const invocation = input.templateId === "396"
    ? window.tp__addRecord(input.templateId)
    : window.tp__addRecord(input.templateId, null, null);
  await Promise.resolve(invocation);
  await new Promise(resolve => setTimeout(resolve, 250));
  return { dispatched: true };
}`;

const ZERO_RUNTIME_READ_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const topUrl = new URL(location.href);
  const exactTopKeys = Array.from(topUrl.searchParams.keys()).sort().join(",") === "pageid,recordid";
  const frames = Array.from(document.querySelectorAll("iframe.t396__iframe"));
  if (
    topUrl.origin !== "https://tilda.ru" ||
    topUrl.pathname !== "/zero/" ||
    topUrl.hash !== "" ||
    !exactTopKeys ||
    topUrl.searchParams.getAll("recordid").length !== 1 ||
    topUrl.searchParams.get("recordid") !== input.target.recordId ||
    topUrl.searchParams.getAll("pageid").length !== 1 ||
    topUrl.searchParams.get("pageid") !== input.target.pageId ||
    frames.length !== 1 ||
    !frames[0].isConnected
  ) throw new Error("AUTHORITY_ZERO_TOP_TARGET_REJECTED");
  const frame = frames[0];
  const frameUrl = new URL(frame.src, location.href);
  const frameKeys = Array.from(frameUrl.searchParams.keys()).sort().join(",");
  if (
    frameUrl.origin !== location.origin ||
    frameUrl.pathname !== "/zero/" ||
    frameUrl.hash !== "" ||
    frameKeys !== "iframe,nocash,pageid,recordid" ||
    frameUrl.searchParams.getAll("recordid").length !== 1 ||
    frameUrl.searchParams.get("recordid") !== input.target.recordId ||
    frameUrl.searchParams.getAll("pageid").length !== 1 ||
    frameUrl.searchParams.get("pageid") !== input.target.pageId ||
    frameUrl.searchParams.getAll("iframe").length !== 1 ||
    frameUrl.searchParams.get("iframe") !== "y" ||
    frameUrl.searchParams.getAll("nocash").length !== 1 ||
    !frameUrl.searchParams.get("nocash")
  ) throw new Error("AUTHORITY_ZERO_FRAME_TARGET_REJECTED");
  const runtime = frame.contentWindow;
  const frameDocument = frame.contentDocument;
  if (!runtime || !frameDocument) throw new Error("AUTHORITY_ZERO_FRAME_UNAVAILABLE");
  const getter = runtime.ab__getDBSaveData;
  const saver = runtime.ab__saveToDataBase;
  if (
    typeof getter !== "function" || getter.length !== 0 ||
    typeof saver !== "function" || saver.length !== 0
  ) throw new Error("AUTHORITY_ZERO_RUNTIME_CONTRACT_REJECTED");
  const sha256 = async value => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  };
  if (
    await sha256(String(getter)) !== "4fa5cfe3b0fe1337638cc2d5d0757332a336d3b89fbbcabf2b8abbdeaa7c218d" ||
    await sha256(String(saver)) !== "5b5991469d7cab8e14f8dd7817b8e06429dd1605871efd85f02b08dade574c46"
  ) throw new Error("AUTHORITY_ZERO_RUNTIME_FINGERPRINT_REJECTED");
  const artboards = Array.from(frameDocument.querySelectorAll(".tn-artboard"));
  if (
    artboards.length !== 1 ||
    artboards[0].getAttribute("data-page-id") !== input.target.pageId ||
    artboards[0].getAttribute("data-record-id") !== input.target.recordId
  ) throw new Error("AUTHORITY_ZERO_ARTBOARD_TARGET_REJECTED");
  const data = getter.call(runtime);
  if (
    data === null || typeof data !== "object" || Array.isArray(data) ||
    Object.keys(data).sort().join(",") !== "cleanElementsData,elementsData,timestamp,zbGrid"
  ) throw new Error("AUTHORITY_ZERO_RUNTIME_MODEL_REJECTED");
  const isPlainObject = value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === runtime.Object.prototype || prototype === null;
  };
  const isCanonicalElementKey = key =>
    /^(?:0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key));
  const isCanonicalElementId = value =>
    typeof value === "string" && /^[1-9]\d*$/.test(value);
  const cleanModel = data.cleanElementsData;
  let hydrated = isPlainObject(cleanModel);
  const modelKeys = hydrated ? Object.keys(cleanModel) : [];
  const elementKeys = modelKeys.filter(isCanonicalElementKey);
  if (
    hydrated &&
    modelKeys.some(key => /^\d+$/.test(key) && !isCanonicalElementKey(key))
  ) hydrated = false;
  if (
    hydrated &&
    !["groups", "meta", "timestamp"].every(key => Object.hasOwn(cleanModel, key))
  ) hydrated = false;
  if (elementKeys.length === 0) hydrated = false;
  const elementIds = new Set();
  for (const key of elementKeys) {
    const element = cleanModel[key];
    if (!isPlainObject(element) || !isCanonicalElementId(element.elem_id) || elementIds.has(element.elem_id)) {
      hydrated = false;
      break;
    }
    elementIds.add(element.elem_id);
  }
  const payload = {
    cleanElementsData: data.cleanElementsData,
    zbGrid: data.zbGrid
  };
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  return {
    uiReady: frameDocument.readyState !== "loading" && hydrated,
    target: input.target,
    identity: input.identity,
    status: 200,
    contentType: "application/x-tilda-zero-runtime+json",
    payload: JSON.parse(serialized)
  };
}`;

const ZERO_CLOSE_COMMAND = String.raw`(input => {
  const frames = Array.from(document.querySelectorAll("iframe.t396__iframe"));
  if (frames.length === 0) return { closed: true };
  if (frames.length !== 1) throw new Error("AUTHORITY_ZERO_FRAME_AMBIGUOUS");
  const frameUrl = new URL(frames[0].src, location.href);
  if (
    frameUrl.origin !== location.origin ||
    frameUrl.pathname !== "/zero/" ||
    frameUrl.searchParams.get("recordid") !== input.target.recordId ||
    frameUrl.searchParams.get("pageid") !== input.target.pageId
  ) throw new Error("AUTHORITY_ZERO_FRAME_TARGET_REJECTED");
  const runtime = frames[0].contentWindow;
  if (!runtime || typeof runtime.tn_close !== "function") {
    throw new Error("AUTHORITY_ZERO_CLOSE_UNAVAILABLE");
  }
  runtime.tn_close();
  return { closed: true };
})`;

/**
 * Tilda may refresh the Zero runtime's service timestamp between the outer
 * adapter read and the inner fixed-writer hydration. Keep this narrow rebase
 * in one self-contained function so the browser probe and its regression test
 * use the same policy.
 */
export function rebaseZeroRuntimeTimestamp(
  current: Record<string, unknown>,
  intended: Record<string, unknown>,
): Record<string, unknown> {
  const rebound = Object.create(Object.getPrototypeOf(intended)) as Record<string, unknown>;
  Object.assign(rebound, intended);
  rebound.timestamp = current.timestamp;
  return rebound;
}

const ZERO_TIMESTAMP_REBASE_SOURCE = `(${rebaseZeroRuntimeTimestamp.toString()})`;

/** Only the service timestamp may change between the two inner Zero reads. */
export function zeroRuntimeModelsEqualExceptTimestamp(
  first: Record<string, unknown>,
  latest: Record<string, unknown>,
): boolean {
  const normalizedFirst = Object.create(Object.getPrototypeOf(first)) as Record<string, unknown>;
  Object.assign(normalizedFirst, first);
  normalizedFirst.timestamp = latest.timestamp;
  return JSON.stringify(normalizedFirst) === JSON.stringify(latest);
}

const ZERO_RUNTIME_MODEL_STABILITY_SOURCE =
  `(${zeroRuntimeModelsEqualExceptTimestamp.toString()})`;

const FIXED_ZERO_WRITE_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const runtimeRead = await (${ZERO_RUNTIME_READ_PROBE})(input);
  if (!runtimeRead.uiReady) {
    throw new Error("AUTHORITY_ZERO_CLEAN_MODEL_NOT_HYDRATED");
  }
  const current = runtimeRead.payload.cleanElementsData;
  let intended = input.intendedCleanElementsData;
  const isPlainObject = value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const isCanonicalElementKey = key =>
    /^(?:0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key));
  const isCanonicalElementId = value =>
    typeof value === "string" && /^[1-9]\d*$/.test(value);
  const inspectModel = value => {
    if (!isPlainObject(value)) return null;
    const keys = Object.keys(value);
    if (keys.some(key => /^\d+$/.test(key) && !isCanonicalElementKey(key))) return null;
    if (!["groups", "meta", "timestamp"].every(key => Object.hasOwn(value, key))) return null;
    const elementKeys = keys.filter(isCanonicalElementKey);
    if (elementKeys.length === 0) return null;
    const ids = new Set();
    for (const key of elementKeys) {
      const element = value[key];
      if (!isPlainObject(element) || !isCanonicalElementId(element.elem_id) || ids.has(element.elem_id)) {
        return null;
      }
      ids.add(element.elem_id);
    }
    return { keys, elementKeys, ids };
  };
  const currentInfo = inspectModel(current);
  const intendedInfo = inspectModel(intended);
  if (currentInfo === null || intendedInfo === null) {
    throw new Error("AUTHORITY_ZERO_CLEAN_MODEL_REJECTED");
  }
  // The enclosing adapter validates the caller model against an earlier
  // hydration. Opening the Zero runtime for this fixed writer hydrates it
  // once more, and Tilda may refresh this service-level field between those
  // reads. Rebind only timestamp to this innermost current model; all other
  // metadata remains strict below.
  intended = ${ZERO_TIMESTAMP_REBASE_SOURCE}(current, intended);
  const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sameKeySet = (left, right) => {
    if (left.length !== right.length) return false;
    const rightKeys = new Set(right);
    return left.every(key => rightKeys.has(key));
  };
  const elementId = element => element && typeof element === "object" && !Array.isArray(element)
    ? element.elem_id : "";
  const elementType = element => element && typeof element === "object" && !Array.isArray(element)
    ? (element.type ?? element.elem_type) : "";
  const basicElementTypes = new Set(["text", "image", "shape", "button", "html"]);
  const primitiveKind = value => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return typeof value;
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    return null;
  };
  const canonicalProperty = value =>
    /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(value) &&
    !["elem_id", "type", "elem_type"].includes(value);
  const stripCloneFields = element => Object.fromEntries(
    Object.entries(element).filter(([key]) => !["elem_id", "left", "top", "zindex"].includes(key))
  );
  const allCommonValuesEqual = (left, right, keys) =>
    keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  const maxNumericKey = keys => Math.max(...keys.map(key => Number(key)));
  const geometryIsFinite = element =>
    [element.left, element.top, element.zindex].every(value =>
      typeof value === "number" && Number.isFinite(value)
    );
  const runtimeGeometryIsFinite = element =>
    [element.left, element.top, element.zindex].every(value =>
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
        Number.isFinite(Number(value)))
    );
  let transitionAccepted = false;
  if (sameKeySet(currentInfo.keys, intendedInfo.keys)) {
    const changed = [];
    for (const key of currentInfo.keys) {
      const before = current[key];
      const after = intended[key];
      if (isCanonicalElementKey(key)) {
        if (elementId(before) !== elementId(after)) {
          throw new Error("AUTHORITY_ZERO_ELEMENT_ORDER_REJECTED");
        }
        if (!jsonEqual(before, after)) changed.push({ key, before, after });
      } else if (!jsonEqual(before, after)) {
        throw new Error("AUTHORITY_ZERO_MODEL_METADATA_CHANGED");
      }
    }
    if (changed.length === 1) {
      const { before, after } = changed[0];
      const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
      const changedKeys = keys.filter(key => !jsonEqual(before[key], after[key]));
      const property = changedKeys[0];
      const currentType = elementType(before);
      const genericPrimitivePatch =
        changedKeys.length === 1 &&
        typeof property === "string" &&
        canonicalProperty(property) &&
        basicElementTypes.has(currentType) &&
        elementType(after) === currentType &&
        Object.hasOwn(before, property) &&
        Object.hasOwn(after, property) &&
        primitiveKind(before[property]) !== null &&
        primitiveKind(before[property]) === primitiveKind(after[property]);
      transitionAccepted =
        genericPrimitivePatch ||
        (changedKeys.length === 1 && changedKeys[0] === "link" &&
          elementType(before) === "text" &&
          (typeof after.link === "string" ||
            (typeof before.link === "string" && !Object.hasOwn(after, "link")))) ||
        (changedKeys.length === 1 && changedKeys[0] === "left-res-480" &&
          elementType(before) === "shape" &&
          typeof after["left-res-480"] === "number" &&
          Number.isFinite(after["left-res-480"]));
    }
  } else {
    const addedKeys = intendedInfo.elementKeys.filter(key => !currentInfo.elementKeys.includes(key));
    const removedKeys = currentInfo.elementKeys.filter(key => !intendedInfo.elementKeys.includes(key));
    const metadataKeys = currentInfo.keys.filter(key => !isCanonicalElementKey(key));
    const metadataUnchanged =
      metadataKeys.length === intendedInfo.keys.filter(key => !isCanonicalElementKey(key)).length &&
      metadataKeys.every(key => Object.hasOwn(intended, key) && jsonEqual(current[key], intended[key]));
    if (addedKeys.length === 1 && removedKeys.length === 0 && metadataUnchanged) {
      const addedKey = addedKeys[0];
      const expectedKey = String(maxNumericKey(currentInfo.elementKeys) + 1);
      const clone = intended[addedKey];
      const sources = currentInfo.elementKeys
        .map(key => current[key])
        .filter(element =>
          basicElementTypes.has(elementType(element)) &&
          elementType(element) === elementType(clone) &&
          jsonEqual(stripCloneFields(element), stripCloneFields(clone))
        );
      transitionAccepted =
        addedKey === expectedKey &&
        allCommonValuesEqual(current, intended, currentInfo.keys) &&
        basicElementTypes.has(elementType(clone)) &&
        isCanonicalElementId(elementId(clone)) &&
        !currentInfo.ids.has(elementId(clone)) &&
        sources.length === 1 &&
        runtimeGeometryIsFinite(clone);
    } else if (addedKeys.length === 0 && removedKeys.length === 1 && metadataUnchanged) {
      const removedKey = removedKeys[0];
      const expectedKey = String(maxNumericKey(currentInfo.elementKeys));
      const removed = current[removedKey];
      const sources = intendedInfo.elementKeys
        .map(key => intended[key])
        .filter(element =>
          basicElementTypes.has(elementType(element)) &&
          elementType(element) === elementType(removed) &&
          jsonEqual(stripCloneFields(element), stripCloneFields(removed))
        );
      transitionAccepted =
        removedKey === expectedKey &&
        allCommonValuesEqual(intended, current, intendedInfo.keys) &&
        basicElementTypes.has(elementType(removed)) &&
        isCanonicalElementId(elementId(removed)) &&
        !intendedInfo.ids.has(elementId(removed)) &&
        sources.length === 1 &&
        runtimeGeometryIsFinite(removed);
    }
  }
  if (!transitionAccepted) throw new Error("AUTHORITY_ZERO_DIFF_REJECTED");
  const frames = Array.from(document.querySelectorAll("iframe.t396__iframe"));
  if (frames.length !== 1 || !frames[0].contentWindow) {
    throw new Error("AUTHORITY_ZERO_FRAME_UNAVAILABLE");
  }
  const runtime = frames[0].contentWindow;
  const liveData = runtime.ab__getDBSaveData.call(runtime);
  if (liveData === null || typeof liveData !== "object") {
    throw new Error("AUTHORITY_ZERO_MODEL_CHANGED_BEFORE_DISPATCH");
  }
  const latestSerialized = JSON.stringify(liveData.cleanElementsData);
  if (
    typeof latestSerialized !== "string" ||
    new TextEncoder().encode(latestSerialized).byteLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("AUTHORITY_ZERO_MODEL_CHANGED_BEFORE_DISPATCH");
  }
  // Values returned by the child frame belong to that frame's JavaScript
  // realm. Canonicalize through the already-reproduced JSON boundary before
  // applying top-frame plain-object checks; this changes no model value.
  const latest = JSON.parse(latestSerialized);
  const latestInfo = inspectModel(latest);
  if (latestInfo === null) {
    throw new Error("AUTHORITY_ZERO_MODEL_CHANGED_BEFORE_DISPATCH");
  }
  if (!${ZERO_RUNTIME_MODEL_STABILITY_SOURCE}(current, latest)) {
    if (input.mode === "preflight") {
      const currentElementKeys = new Set(currentInfo.elementKeys);
      const latestElementKeys = new Set(latestInfo.elementKeys);
      const commonElementKeys = currentInfo.elementKeys.filter(key => latestElementKeys.has(key));
      const topLevelKeys = Array.from(new Set([...currentInfo.keys, ...latestInfo.keys]))
        .filter(key => !isCanonicalElementKey(key) && key !== "timestamp")
        .filter(key => !jsonEqual(current[key], latest[key]))
        .sort();
      const changedElements = commonElementKeys.filter(key => !jsonEqual(current[key], latest[key]));
      const elementFieldNames = Array.from(new Set(changedElements.flatMap(key => {
        const before = current[key];
        const after = latest[key];
        if (!before || typeof before !== "object" || !after || typeof after !== "object") return [];
        return Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
          .filter(field => !jsonEqual(before[field], after[field]));
      }))).sort();
      return {
        preflight: true,
        code: "REJECTED",
        subreason: "MODEL_CHANGED_BEFORE_DISPATCH",
        drift: {
          topLevelKeys,
          elementFieldNames,
          changedElementCount: changedElements.length,
          elementKeySetChanged:
            currentElementKeys.size !== latestElementKeys.size ||
            [...currentElementKeys].some(key => !latestElementKeys.has(key))
        }
      };
    }
    throw new Error("AUTHORITY_ZERO_MODEL_CHANGED_BEFORE_DISPATCH");
  }
  // The second hydration is the one serialized to Tilda; refresh only the
  // service timestamp again so it matches that exact model.
  intended = ${ZERO_TIMESTAMP_REBASE_SOURCE}(latest, intended);
  const grid = liveData.zbGrid;
  const gridPrototype = grid !== null && typeof grid === "object" ? Object.getPrototypeOf(grid) : null;
  if (
    grid === null || typeof grid !== "object" || Array.isArray(grid) ||
    (gridPrototype !== runtime.Object.prototype && gridPrototype !== null)
  ) throw new Error("AUTHORITY_ZERO_GRID_REJECTED");
  const serializedGrid = Object.keys(grid).length === 0 ? "reset" : JSON.stringify(grid);
  if (typeof serializedGrid !== "string") throw new Error("AUTHORITY_ZERO_GRID_REJECTED");
  const serializedModel = JSON.stringify(intended);
  if (
    typeof serializedModel !== "string" ||
    new TextEncoder().encode(serializedModel).byteLength > MAX_RESPONSE_BYTES
  ) throw new Error("AUTHORITY_ZERO_BODY_REJECTED");
  const body = new FormData();
  body.set("code", serializedModel);
  body.set("comm", "savezerocode");
  body.set("fromzero", "yes");
  body.set("onlythisfield", "code");
  body.set("pageid", input.target.pageId);
  body.set("recordid", input.target.recordId);
  body.set("zb_grid", serializedGrid);
  if (Array.from(body.keys()).sort().join(",") !== "code,comm,fromzero,onlythisfield,pageid,recordid,zb_grid") {
    throw new Error("AUTHORITY_ZERO_BODY_REJECTED");
  }
  if (input.mode === "preflight") {
    return { preflight: true, code: "READY" };
  }
  const response = await fetch("/zero/submit/", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    body
  });
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== location.origin || responseUrl.pathname !== "/zero/submit/") {
    throw new Error("AUTHORITY_WRITE_RESPONSE_TARGET_REJECTED");
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  let responseBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
      }
    }
  } else {
    responseBytes = (await response.arrayBuffer()).byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  return { dispatched: true, httpOk: response.ok, status: response.status, responseBytes };
}`;

const FIXED_ZERO_WRITE_PREFLIGHT_PROBE = String.raw`async (input) => {
  try {
    const result = await (${FIXED_ZERO_WRITE_PROBE})({ ...input, mode: "preflight" });
    if (result && result.preflight === true && result.code === "REJECTED") return result;
    return { preflight: true, code: "READY" };
  } catch (error) {
    const message = error && typeof error === "object" && typeof error.message === "string"
      ? error.message : "";
    const exact = {
      AUTHORITY_ZERO_CLEAN_MODEL_NOT_HYDRATED: "CLEAN_MODEL_NOT_HYDRATED",
      AUTHORITY_ZERO_CLEAN_MODEL_REJECTED: "CLEAN_MODEL_REJECTED",
      AUTHORITY_ZERO_ELEMENT_ORDER_REJECTED: "ELEMENT_ORDER_REJECTED",
      AUTHORITY_ZERO_MODEL_METADATA_CHANGED: "MODEL_METADATA_CHANGED",
      AUTHORITY_ZERO_DIFF_REJECTED: "DIFF_REJECTED",
      AUTHORITY_ZERO_FRAME_UNAVAILABLE: "FRAME_UNAVAILABLE",
      AUTHORITY_ZERO_MODEL_CHANGED_BEFORE_DISPATCH: "MODEL_CHANGED_BEFORE_DISPATCH",
      AUTHORITY_ZERO_GRID_REJECTED: "GRID_REJECTED",
      AUTHORITY_ZERO_BODY_REJECTED: "BODY_REJECTED"
    };
    const subreason = Object.hasOwn(exact, message)
      ? exact[message]
      : message.startsWith("AUTHORITY_ZERO_")
        ? "RUNTIME_READ_REJECTED"
        : "UNKNOWN_REJECTION";
    return { preflight: true, code: "REJECTED", subreason };
  }
}`;

const PAGE_SETTINGS_OPEN_COMMAND = String.raw`(input => {
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" || url.pathname !== "/projects/" || url.hash !== "" ||
    Array.from(url.searchParams.keys()).join(",") !== "projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId
  ) throw new Error("AUTHORITY_PROJECT_TARGET_MISMATCH");
  // The exact project/page ownership check is performed immediately before
  // opening this surface by readProject() plus the authority page allowlist.
  // The current dashboard exposes the reproduced opener under
  // td__showform__EditPageSettings; older captures used the *_new alias.
  const opener = typeof window.td__showform__EditPageSettings === "function"
    ? window.td__showform__EditPageSettings
    : typeof window.showformEditPageSettings_new === "function"
      ? window.showformEditPageSettings_new
      : null;
  if (opener === null) throw new Error("AUTHORITY_PAGE_SETTINGS_OPEN_UNAVAILABLE");
  opener(input.target.pageId);
  return { opened: true };
})`;

const PAGE_SETTINGS_READ_PROBE = String.raw`(input => {
  const MAX_RESPONSE_BYTES = 5000000;
  const url = new URL(location.href);
  if (
    url.origin !== "https://tilda.ru" || url.pathname !== "/projects/" || url.hash !== "" ||
    Array.from(url.searchParams.keys()).join(",") !== "projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId
  ) throw new Error("AUTHORITY_PROJECT_TARGET_MISMATCH");
  const forms = Array.from(document.querySelectorAll("form#formpageedit"));
  if (forms.length !== 1) throw new Error("AUTHORITY_PAGE_SETTINGS_FORM_AMBIGUOUS");
  const form = forms[0];
  if (
    !(form instanceof HTMLFormElement) || !form.isConnected ||
    form.getAttribute("name") !== "formpageedit" || form.method.toUpperCase() !== "POST"
  ) throw new Error("AUTHORITY_PAGE_SETTINGS_FORM_REJECTED");
  const hidden = (name, value) => {
    const matches = Array.from(form.querySelectorAll('input[type="hidden"][name="' + name + '"]'));
    return matches.length === 1 && matches[0].value === value;
  };
  if (!hidden("comm", "savepagesettings") || !hidden("pageid", input.target.pageId)) {
    throw new Error("AUTHORITY_PAGE_SETTINGS_FORM_TARGET_REJECTED");
  }
  const fields = [];
  for (const [name, value] of new FormData(form).entries()) {
    if (typeof value !== "string") throw new Error("AUTHORITY_PAGE_SETTINGS_FILE_REJECTED");
    fields.push([name, value]);
  }
  const values = name => fields.filter(entry => entry[0] === name).map(entry => entry[1]);
  if (
    values("comm").length !== 1 || values("comm")[0] !== "savepagesettings" ||
    values("pageid").length !== 1 || values("pageid")[0] !== input.target.pageId ||
    values("meta_descr").length !== 1
  ) throw new Error("AUTHORITY_PAGE_SETTINGS_FIELDS_REJECTED");
  const serialized = JSON.stringify(fields);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  return { uiReady: true, target: input.target, fields };
})`;

const PAGE_SETTINGS_CLOSE_COMMAND = String.raw`(() => {
  if (!document.querySelector("form#formpageedit")) return { closed: true };
  if (typeof window.closepopup !== "function") {
    throw new Error("AUTHORITY_PAGE_SETTINGS_CLOSE_UNAVAILABLE");
  }
  window.closepopup();
  return { closed: true };
})()`;

const FIXED_PAGE_SETTINGS_WRITE_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const read = (${PAGE_SETTINGS_READ_PROBE})(input);
  const current = read.fields;
  const intended = input.intendedFields;
  if (!Array.isArray(intended) || current.length !== intended.length) {
    throw new Error("AUTHORITY_PAGE_SETTINGS_DIFF_REJECTED");
  }
  let metaChanges = 0;
  const body = new URLSearchParams();
  let jsSubmitCount = 0;
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index];
    const after = intended[index];
    if (!Array.isArray(after) || after.length !== 2 || after[0] !== before[0] || typeof after[1] !== "string") {
      throw new Error("AUTHORITY_PAGE_SETTINGS_DIFF_REJECTED");
    }
    if (before[0] === "meta_descr") {
      if (before[1] !== after[1]) metaChanges += 1;
      body.append(before[0], after[1]);
    } else {
      if (before[1] !== after[1]) throw new Error("AUTHORITY_PAGE_SETTINGS_DIFF_REJECTED");
      if (before[0] === "jssubmit") {
        jsSubmitCount += 1;
        body.append("jssubmit", "y");
      } else {
        body.append(before[0], before[1]);
      }
    }
  }
  if (metaChanges !== 1 || jsSubmitCount > 1) {
    throw new Error("AUTHORITY_PAGE_SETTINGS_DIFF_REJECTED");
  }
  if (jsSubmitCount === 0) body.append("jssubmit", "y");
  if (
    body.getAll("comm").length !== 1 || body.get("comm") !== "savepagesettings" ||
    body.getAll("pageid").length !== 1 || body.get("pageid") !== input.target.pageId ||
    body.getAll("meta_descr").length !== 1 || body.getAll("jssubmit").length !== 1 ||
    body.get("jssubmit") !== "y"
  ) throw new Error("AUTHORITY_PAGE_SETTINGS_BODY_REJECTED");
  const response = await fetch("/projects/submit/", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== location.origin || responseUrl.pathname !== "/projects/submit/") {
    throw new Error("AUTHORITY_WRITE_RESPONSE_TARGET_REJECTED");
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  let responseBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
      }
    }
  } else {
    responseBytes = (await response.arrayBuffer()).byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  return { dispatched: true, httpOk: response.ok, status: response.status, responseBytes };
}`;

const PAGE_HEAD_CODE_SAVE_FUNCTION_HASH =
  "e987075affaeb5cfd769eb6ed62e8226cf938b372aafb051e0b1031231fafcf9";

const PAGE_HEAD_CODE_READ_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const url = new URL(location.href);
  const loginSurface = Boolean(
    document.querySelector('input[type="password"], form[action*="login" i], [class*="login" i] input')
  ) || /\/login|\/signin/i.test(url.pathname);
  const exactRoute =
    url.origin === "https://tilda.ru" &&
    url.pathname === "/projects/editheadcode/" &&
    url.hash === "" &&
    Array.from(url.searchParams.keys()).sort().join(",") === "pageid,projectid" &&
    url.searchParams.getAll("projectid").length === 1 &&
    url.searchParams.getAll("pageid").length === 1 &&
    url.searchParams.get("projectid") === input.target.projectId &&
    url.searchParams.get("pageid") === input.target.pageId &&
    String(window.projectid) === input.target.projectId &&
    String(window.pageid) === input.target.pageId;
  const named = Array.from(document.querySelectorAll('textarea[name="headcode"]'));
  const editor = window.aceeditor;
  const save = window.td__pageheadcode__saveCode;
  if (
    !exactRoute || loginSurface || named.length !== 1 ||
    !editor || typeof editor.getValue !== "function" || typeof editor.setValue !== "function" ||
    typeof save !== "function" || save.length !== 0
  ) {
    return {
      uiReady: false,
      host: url.hostname,
      route: url.pathname,
      href: url.href,
      target: input.target,
      code: "",
      saveFunctionHash: ""
    };
  }
  const code = editor.getValue();
  if (typeof code !== "string" || named[0].value !== code) {
    throw new Error("AUTHORITY_PAGE_HEAD_EDITOR_SYNC_REJECTED");
  }
  if (new TextEncoder().encode(code).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  const source = Function.prototype.toString.call(save);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const saveFunctionHash = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    uiReady: document.readyState === "complete",
    host: url.hostname,
    route: url.pathname,
    href: url.href,
    target: input.target,
    code,
    saveFunctionHash
  };
}`;

const FIXED_PAGE_HEAD_CODE_WRITE_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const read = await (${PAGE_HEAD_CODE_READ_PROBE})(input);
  if (
    !read.uiReady || read.target.projectId !== input.target.projectId ||
    read.target.pageId !== input.target.pageId ||
    read.saveFunctionHash !== input.saveFunctionHash ||
    typeof input.intendedCode !== "string" || typeof input.expectedCurrentCode !== "string" ||
    read.code !== input.expectedCurrentCode || read.code === input.intendedCode ||
    new TextEncoder().encode(input.intendedCode).byteLength > MAX_RESPONSE_BYTES ||
    new TextEncoder().encode(input.expectedCurrentCode).byteLength > MAX_RESPONSE_BYTES
  ) throw new Error("AUTHORITY_PAGE_HEAD_DIFF_REJECTED");
  if (typeof window.getCSRF !== "function") {
    throw new Error("AUTHORITY_PAGE_HEAD_CSRF_UNAVAILABLE");
  }
  const csrf = window.getCSRF();
  if (typeof csrf !== "string" || csrf.length < 1 || csrf.length > 4096 || /[\r\n]/u.test(csrf)) {
    throw new Error("AUTHORITY_PAGE_HEAD_CSRF_REJECTED");
  }
  const body = new URLSearchParams();
  body.append("comm", "editpageheadcode");
  body.append("projectid", input.target.projectId);
  body.append("pageid", input.target.pageId);
  body.append("headcode", input.intendedCode);
  body.append("csrf", csrf);
  if (
    Array.from(new Set(body.keys())).sort().join(",") !== "comm,csrf,headcode,pageid,projectid" ||
    body.getAll("comm").length !== 1 || body.get("comm") !== "editpageheadcode" ||
    body.getAll("projectid").length !== 1 || body.get("projectid") !== input.target.projectId ||
    body.getAll("pageid").length !== 1 || body.get("pageid") !== input.target.pageId ||
    body.getAll("headcode").length !== 1 || body.getAll("csrf").length !== 1
  ) throw new Error("AUTHORITY_PAGE_HEAD_BODY_REJECTED");
  const response = await fetch("/projects/submit/", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== location.origin || responseUrl.pathname !== "/projects/submit/") {
    throw new Error("AUTHORITY_WRITE_RESPONSE_TARGET_REJECTED");
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  const responseText = await response.text();
  const responseBytes = new TextEncoder().encode(responseText).byteLength;
  if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  return {
    dispatched: true,
    httpOk: response.ok && responseText.trim() === "OK",
    status: response.status,
    responseBytes
  };
}`;

const FIXED_PUBLICATION_WRITE_PROBE = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const url = new URL(location.href);
  const loaded = document.querySelector("#allrecords");
  if (
    url.origin !== "https://tilda.ru" || url.pathname !== "/page/" || url.hash !== "" ||
    Array.from(url.searchParams.keys()).sort().join(",") !== "pageid,projectid" ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    url.searchParams.get("pageid") !== input.target.pageId ||
    String(window.projectid ?? "") !== input.target.projectId ||
    String(window.pageid ?? "") !== input.target.pageId ||
    typeof window.pagepublished !== "string" ||
    !(loaded instanceof HTMLElement) || !loaded.isConnected ||
    typeof window.getCSRF !== "function"
  ) throw new Error("AUTHORITY_PUBLICATION_TARGET_REJECTED");
  const csrf = window.getCSRF();
  if (typeof csrf !== "string" || csrf.length === 0) {
    throw new Error("AUTHORITY_CSRF_UNAVAILABLE");
  }
  let path;
  const body = new FormData();
  if (input.action === "publish") {
    path = "/page/publish/";
    body.set("projectid", input.target.projectId);
    body.set("comm", "pagepublish");
    body.set("pageid", input.target.pageId);
    body.set("csrf", csrf);
    body.set("returnjson", "yes");
    if (Array.from(body.keys()).sort().join(",") !== "comm,csrf,pageid,projectid,returnjson") {
      throw new Error("AUTHORITY_PUBLICATION_BODY_REJECTED");
    }
  } else if (input.action === "unpublish") {
    path = "/page/unpublish/";
    body.set("pageid", input.target.pageId);
    body.set("csrf", csrf);
    if (Array.from(body.keys()).sort().join(",") !== "csrf,pageid") {
      throw new Error("AUTHORITY_UNPUBLISH_BODY_REJECTED");
    }
  } else {
    throw new Error("AUTHORITY_PUBLICATION_ACTION_REJECTED");
  }
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    body
  });
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== location.origin || responseUrl.pathname !== path) {
    throw new Error("AUTHORITY_WRITE_RESPONSE_TARGET_REJECTED");
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  let responseBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
      }
    }
  } else {
    responseBytes = (await response.arrayBuffer()).byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  return { dispatched: true, httpOk: response.ok, status: response.status, responseBytes };
}`;

const PAGE_LIFECYCLE_READ_PROBE = String.raw`(input => {
  const url = new URL(location.href);
  const sortable = document.querySelector("#pagesortable");
  if (
    url.origin !== "https://tilda.ru" || url.pathname !== "/projects/" || url.hash !== "" ||
    Array.from(url.searchParams.keys()).join(",") !== "projectid" ||
    url.searchParams.getAll("projectid").length !== 1 ||
    url.searchParams.get("projectid") !== input.target.projectId ||
    !(sortable instanceof HTMLElement) || !sortable.isConnected
  ) throw new Error("AUTHORITY_LIFECYCLE_PROJECT_REJECTED");
  const cards = Array.from(sortable.querySelectorAll(":scope > div.td-page"));
  const pageOrder = cards.map(card => String(card.id || "").replace(/^page/, ""));
  if (
    pageOrder.length === 0 ||
    pageOrder.some(pageId => !/^[1-9]\d*$/.test(pageId)) ||
    new Set(pageOrder).size !== pageOrder.length
  ) throw new Error("AUTHORITY_LIFECYCLE_PAGE_ORDER_REJECTED");
  return {
    uiReady: document.readyState === "complete",
    target: input.target,
    activePageIds: pageOrder,
    pageOrder
  };
})`;

const FIXED_PAGE_LIFECYCLE_COMMAND = String.raw`async (input) => {
  const MAX_RESPONSE_BYTES = 5000000;
  const current = (${PAGE_LIFECYCLE_READ_PROBE})(input);
  if (!current.uiReady || typeof window.getCSRF !== "function") {
    throw new Error("AUTHORITY_LIFECYCLE_RUNTIME_REJECTED");
  }
  const csrf = window.getCSRF();
  if (typeof csrf !== "string" || csrf.length === 0) {
    throw new Error("AUTHORITY_CSRF_UNAVAILABLE");
  }
  const body = new URLSearchParams();
  if (input.action === "duplicate") {
    if (
      !Array.isArray(input.expectedPageOrder) ||
      input.expectedPageOrder.length < 1 ||
      input.expectedPageOrder.some(pageId => !/^[1-9]\d*$/.test(pageId)) ||
      new Set(input.expectedPageOrder).size !== input.expectedPageOrder.length ||
      input.expectedPageOrder.join(",") !== current.pageOrder.join(",") ||
      !current.pageOrder.includes(input.target.pageId)
    ) {
      throw new Error("AUTHORITY_LIFECYCLE_BASELINE_SCOPE_REJECTED");
    }
    body.append("comm", "dublicatepage");
    body.append("pageid", input.target.pageId);
    body.append("csrf", csrf);
  } else if (input.action === "sort") {
    if (
      !Array.isArray(input.pageOrder) || input.pageOrder.length !== 2 ||
      input.pageOrder.some(pageId => !/^[1-9]\d*$/.test(pageId)) ||
      new Set(input.pageOrder).size !== input.pageOrder.length ||
      !input.pageOrder.every(pageId => current.pageOrder.includes(pageId))
    ) throw new Error("AUTHORITY_LIFECYCLE_SORT_REJECTED");
    body.append("comm", "savepagessort");
    body.append("projectid", input.target.projectId);
    input.pageOrder.forEach((pageId, index) => body.append("sorts[" + index + "]", pageId));
    body.append("csrf", csrf);
  } else if (input.action === "delete_temp") {
    if (
      typeof input.temporaryPageId !== "string" ||
      !/^[1-9]\d*$/.test(input.temporaryPageId) ||
      input.temporaryPageId === input.target.pageId ||
      !current.pageOrder.includes(input.target.pageId) ||
      !current.pageOrder.includes(input.temporaryPageId) ||
      !Array.isArray(input.expectedPageOrder) ||
      input.expectedPageOrder.join(",") !== current.pageOrder.join(",")
    ) throw new Error("AUTHORITY_LIFECYCLE_DELETE_REJECTED");
    body.append("comm", "delpage");
    body.append("pageid", input.temporaryPageId);
    body.append("csrf", csrf);
  } else {
    throw new Error("AUTHORITY_LIFECYCLE_ACTION_REJECTED");
  }
  const response = await fetch("/projects/submit/", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
  const responseUrl = new URL(response.url);
  if (
    responseUrl.origin !== location.origin || responseUrl.pathname !== "/projects/submit/" ||
    response.status < 200 || response.status >= 300
  ) throw new Error("AUTHORITY_LIFECYCLE_RESPONSE_REJECTED");
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
  }
  if (input.action === "duplicate") {
    const temporaryPageId = text.trim();
    if (!/^[1-9]\d*$/.test(temporaryPageId) || temporaryPageId === input.target.pageId) {
      throw new Error("AUTHORITY_LIFECYCLE_DUPLICATE_RECEIPT_REJECTED");
    }
    return { dispatched: true, temporaryPageId };
  }
  return { dispatched: true };
}`;

function invokeFixedProbe(source: string, input: unknown): string {
  return `(${source})(${JSON.stringify(input)})`;
}

function jsonTextEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class LoopbackCdpTrustedBrowserSession implements AuthorityOwnedLoopbackBrowserSession {
  readonly transport = "loopback_cdp" as const;
  readonly sessionId: string;
  readonly #connection: CdpConnection;
  readonly #rootUrl: URL;
  #closed = false;

  private constructor(target: CdpTarget, connection: CdpConnection) {
    this.sessionId = target.id;
    this.#rootUrl = assertRootUrl(target.url);
    this.#connection = connection;
  }

  static async create(target: CdpTarget): Promise<LoopbackCdpTrustedBrowserSession> {
    if (target.webSocketDebuggerUrl === undefined || target.id.trim() === "") {
      throw new Error("The selected projects target is missing a CDP endpoint or target ID.");
    }
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    try {
      await connection.send("Page.enable");
      return new LoopbackCdpTrustedBrowserSession(target, connection);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async readRoot(timeoutMs: number): Promise<ProjectsRootProbe> {
    this.#assertOpen();
    return waitForDomProbe<ProjectsRootProbe>(
      this.#connection,
      PROJECTS_ROOT_DOM_PROBE,
      (probe) => exactProbeUrl(probe, this.#rootUrl),
      timeoutMs,
    );
  }

  async readIdentity(timeoutMs: number): Promise<IdentityProbe> {
    this.#assertOpen();
    return navigateAndProbe<IdentityProbe>(
      this.#connection,
      new URL("https://tilda.ru/identity/"),
      IDENTITY_DOM_PROBE,
      timeoutMs,
    );
  }

  async readProject(projectId: string, timeoutMs: number): Promise<ProjectPagesProbe> {
    this.#assertOpen();
    return navigateAndProbe<ProjectPagesProbe>(
      this.#connection,
      projectUrl(projectId),
      PROJECT_PAGES_DOM_PROBE,
      timeoutMs,
    );
  }

  async restoreRoot(timeoutMs: number): Promise<ProjectsRootProbe> {
    this.#assertOpen();
    return navigateAndProbe<ProjectsRootProbe>(
      this.#connection,
      this.#rootUrl,
      PROJECTS_ROOT_DOM_PROBE,
      timeoutMs,
    );
  }

  async readEditorPage(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<ExactEditorPageSnapshot> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    const expectedUrl = editorPageUrl(canonical);
    const result = await navigateAndProbe<ExactEditorPageSnapshot>(
      this.#connection,
      expectedUrl,
      invokeFixedProbe(EDITOR_PAGE_PROBE, canonical),
      timeoutMs,
      isReadyExactEditorPageSnapshot,
    );
    if (
      !result.authenticated ||
      result.target.projectId !== canonical.projectId ||
      result.target.pageId !== canonical.pageId
    ) {
      throw new Error("The exact editor page did not preserve authenticated target identity.");
    }
    return result;
  }

  async readStandardSettings(
    target: LabRecordTarget,
    timeoutMs: number,
  ): Promise<ExactEditorRecordRead> {
    return this.#readRecord(target, "standard", timeoutMs);
  }

  async readT123Content(
    target: LabRecordTarget,
    timeoutMs: number,
  ): Promise<ExactEditorRecordRead> {
    return this.#readRecord(target, "t123", timeoutMs);
  }

  async readZeroModel(
    target: LabRecordTarget,
    timeoutMs: number,
  ): Promise<ExactEditorRecordRead> {
    return this.#withZeroRuntime(target, timeoutMs, async (read) => read);
  }

  async readZeroServerRepresentation(
    target: LabRecordTarget,
    timeoutMs: number,
  ): Promise<ExactEditorRecordRead> {
    return this.#readRecord(target, "zero_server", timeoutMs);
  }

  async revealExactRecordControl(
    target: LabRecordTarget,
    expectedIdentity: EditorRecordIdentity,
    controlKey: string,
    timeoutMs: number,
  ): Promise<ExactRecordHoverControlReveal> {
    this.#assertOpen();
    const canonical = canonicalRecordTarget(target);
    if (
      expectedIdentity.recordId !== canonical.recordId ||
      expectedIdentity.recordType.trim() === "" ||
      expectedIdentity.recordCode.trim() === "" ||
      expectedIdentity.recordCategory.trim() === "" ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(controlKey)
    ) {
      throw new Error("The exact record control request is malformed.");
    }
    const waitMs = Math.min(normalizeProbeTimeout(timeoutMs), 1_500);
    return this.#connection.evaluate<ExactRecordHoverControlReveal>(
      invokeFixedProbe(EXACT_RECORD_HOVER_CONTROL_REVEAL_PROBE, {
        target: canonical,
        expectedIdentity,
        controlKey,
        waitMs,
      }),
    );
  }

  async readRenderedBlockLibrary(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<RenderedBlockLibraryIndex> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    await this.readEditorPage(canonical, timeoutMs);
    return this.#connection.evaluate<RenderedBlockLibraryIndex>(
      invokeFixedProbe(RENDERED_BLOCK_LIBRARY_READ_PROBE, { target: canonical }),
    );
  }

  async preflightKnownTemplateAdd(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs: number,
  ): Promise<KnownTemplateAddPreflight> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    await this.readEditorPage(canonical, timeoutMs);
    return this.#connection.evaluate<KnownTemplateAddPreflight>(
      invokeFixedProbe(KNOWN_TEMPLATE_ADD_PREFLIGHT_PROBE, {
        target: canonical,
        templateId,
        expectedRuntimeFunctionHash: "19510095bc198f51ed297e2ba02291d9e6d3ebc72da7b0724886af7ff60ae5cc",
      }),
    );
  }

  async writeStandard(
    target: LabRecordTarget,
    field: StandardWritableField,
    value: string,
    _timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    this.#assertOpen();
    const canonical = canonicalRecordTarget(target);
    return this.#connection.evaluate<FixedBrowserDispatchResult>(
      invokeFixedProbe(FIXED_RECORD_WRITE_PROBE, {
        kind: "standard",
        target: canonical,
        field,
        value,
      }),
    );
  }

  async writeT123(
    target: LabRecordTarget,
    code: string,
    _timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    this.#assertOpen();
    const canonical = canonicalRecordTarget(target);
    return this.#connection.evaluate<FixedBrowserDispatchResult>(
      invokeFixedProbe(FIXED_RECORD_WRITE_PROBE, {
        kind: "t123",
        target: canonical,
        code,
      }),
    );
  }

  async writeZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    return this.#withZeroRuntime(target, timeoutMs, async (read) => {
      return this.#connection.evaluate<FixedBrowserDispatchResult>(
        invokeFixedProbe(FIXED_ZERO_WRITE_PROBE, {
          target: read.target,
          identity: read.identity,
          intendedCleanElementsData,
        }),
      );
    });
  }

  async preflightZeroModel(
    target: LabRecordTarget,
    intendedCleanElementsData: unknown,
    timeoutMs: number,
  ): Promise<FixedZeroWritePreflightResult> {
    return this.#withZeroRuntime(target, timeoutMs, async (read) => {
      return this.#connection.evaluate<FixedZeroWritePreflightResult>(
        invokeFixedProbe(FIXED_ZERO_WRITE_PREFLIGHT_PROBE, {
          target: read.target,
          identity: read.identity,
          intendedCleanElementsData,
        }),
      );
    });
  }

  async readPageSettings(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<ExactPageSettingsRead> {
    return this.#withPageSettings(target, timeoutMs, async (read) => read);
  }

  async writePageSettings(
    target: LabPageTarget,
    intendedFields: readonly (readonly [string, string])[],
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    return this.#withPageSettings(target, timeoutMs, async (read) => {
      return this.#connection.evaluate<FixedBrowserDispatchResult>(
        invokeFixedProbe(FIXED_PAGE_SETTINGS_WRITE_PROBE, {
          target: read.target,
          intendedFields,
        }),
      );
    });
  }

  async readPageHeadCode(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<ExactPageHeadCodeRead> {
    return this.#withPageHeadCode(target, timeoutMs, async (read) => read);
  }

  async writePageHeadCode(
    target: LabPageTarget,
    intendedCode: string,
    expectedCurrentCode: string,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    return this.#withPageHeadCode(target, timeoutMs, async (read) => {
      return this.#connection.evaluate<FixedBrowserDispatchResult>(
        invokeFixedProbe(FIXED_PAGE_HEAD_CODE_WRITE_PROBE, {
          target: read.target,
          intendedCode,
          expectedCurrentCode,
          saveFunctionHash: read.saveFunctionHash,
        }),
      );
    });
  }

  async publishPage(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    return this.#writePublication(target, "publish", timeoutMs);
  }

  async unpublishPage(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    return this.#writePublication(target, "unpublish", timeoutMs);
  }

  async createPageFromReference(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedReferencePageCreateResult> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    try {
      const baselineProject = await this.#readLifecycleProject(canonical, timeoutMs);
      if (
        baselineProject.pageOrder.length < 1 ||
        !baselineProject.pageOrder.includes(canonical.pageId)
      ) {
        throw new Error("Reference page is absent from the exact project baseline.");
      }
      const sourceBefore = await this.readEditorPage(canonical, timeoutMs);
      if (sourceBefore.records.length === 0) {
        throw new Error("Reference page must contain at least one exact record identity.");
      }
      await this.#readLifecycleProject(canonical, timeoutMs);
      const duplicate = await this.#connection.evaluate<{
        readonly dispatched: true;
        readonly temporaryPageId: string;
      }>(invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
        action: "duplicate",
        target: canonical,
        expectedPageOrder: baselineProject.pageOrder,
      }));
      const createdPageId = duplicate.temporaryPageId;
      const afterProject = await this.#readLifecycleProject(canonical, timeoutMs);
      const added = afterProject.activePageIds.filter(
        (pageId) => !baselineProject.activePageIds.includes(pageId),
      );
      const removed = baselineProject.activePageIds.filter(
        (pageId) => !afterProject.activePageIds.includes(pageId),
      );
      if (
        added.length !== 1 ||
        added[0] !== createdPageId ||
        removed.length !== 0 ||
        afterProject.activePageIds.length !== baselineProject.activePageIds.length + 1
      ) {
        throw new Error("Duplicate response and exact project inventory delta disagree.");
      }
      const createdTarget = canonicalPageTarget({
        projectId: canonical.projectId,
        pageId: createdPageId,
      });
      const createdPage = await this.readEditorPage(createdTarget, timeoutMs);
      const sourceAfter = await this.readEditorPage(canonical, timeoutMs);
      const family = (records: readonly EditorRecordIdentity[]) => records.map(
        ({ recordType, recordCode, recordCategory }) => ({ recordType, recordCode, recordCategory }),
      );
      const sourceIds = new Set(sourceBefore.records.map(({ recordId }) => recordId));
      const createdIds = createdPage.records.map(({ recordId }) => recordId);
      if (
        createdPage.published !== "" ||
        createdPage.records.length !== sourceBefore.records.length ||
        createdIds.some((recordId) => sourceIds.has(recordId)) ||
        new Set(createdIds).size !== createdIds.length ||
        !jsonTextEqual(family(createdPage.records), family(sourceBefore.records)) ||
        !jsonTextEqual(sourceAfter.records, sourceBefore.records)
      ) {
        throw new Error("Created reference page failed exact unpublished record-parity readback.");
      }
      return {
        baseline: {
          target: canonical,
          activePageIds: baselineProject.activePageIds,
          pageOrder: baselineProject.pageOrder,
          sourceRecords: sourceBefore.records,
        },
        created: {
          target: createdTarget,
          activePageIds: afterProject.activePageIds,
          pageOrder: afterProject.pageOrder,
          records: createdPage.records,
          published: false,
        },
      };
    } finally {
      await this.restoreRoot(timeoutMs);
    }
  }

  async cleanupReferencePage(
    sourceTarget: LabPageTarget,
    createdPageId: string,
    expectedActivePageIds: readonly string[],
    expectedPageOrder: readonly string[],
    expectedSourceRecords: readonly EditorRecordIdentity[],
    expectedCreatedRecords: readonly EditorRecordIdentity[],
    timeoutMs: number,
  ): Promise<FixedReferencePageCleanupResult> {
    this.#assertOpen();
    const source = canonicalPageTarget(sourceTarget);
    const created = canonicalPageTarget({ projectId: source.projectId, pageId: createdPageId });
    try {
      const current = await this.#readLifecycleProject(source, timeoutMs);
      if (
        !jsonTextEqual(current.activePageIds, expectedActivePageIds) ||
        !jsonTextEqual(current.pageOrder, expectedPageOrder) ||
        !current.pageOrder.includes(source.pageId) ||
        !current.pageOrder.includes(created.pageId)
      ) {
        throw new Error("Reference cleanup project inventory drifted from its creation receipt.");
      }
      const sourceBefore = await this.readEditorPage(source, timeoutMs);
      const createdBefore = await this.readEditorPage(created, timeoutMs);
      if (
        createdBefore.published !== "" ||
        !jsonTextEqual(sourceBefore.records, expectedSourceRecords) ||
        !jsonTextEqual(createdBefore.records, expectedCreatedRecords)
      ) {
        throw new Error("Reference cleanup page identities drifted from the creation receipt.");
      }
      await this.#readLifecycleProject(source, timeoutMs);
      await this.#connection.evaluate(
        invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
          action: "delete_temp",
          target: source,
          temporaryPageId: created.pageId,
          expectedPageOrder,
        }),
      );
      const after = await this.#readLifecycleProject(source, timeoutMs);
      const expectedAfterOrder = expectedPageOrder.filter((pageId) => pageId !== created.pageId);
      const expectedAfterIds = expectedActivePageIds.filter((pageId) => pageId !== created.pageId);
      const sourceAfter = await this.readEditorPage(source, timeoutMs);
      if (
        after.activePageIds.includes(created.pageId) ||
        !jsonTextEqual(after.activePageIds, expectedAfterIds) ||
        !jsonTextEqual(after.pageOrder, expectedAfterOrder) ||
        !jsonTextEqual(sourceAfter.records, expectedSourceRecords)
      ) {
        throw new Error("Reference cleanup did not prove exact clone absence and source preservation.");
      }
      return {
        sourceTarget: source,
        removedPageId: created.pageId,
        activePageIds: after.activePageIds,
        pageOrder: after.pageOrder,
        removedPageAbsent: true,
        sourceRecords: sourceAfter.records,
      };
    } finally {
      await this.restoreRoot(timeoutMs);
    }
  }

  async addKnownTemplate(
    target: LabPageTarget,
    templateId: KnownObservedTemplateId,
    timeoutMs: number,
  ): Promise<FixedKnownTemplateAddResult> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    const expected = {
      "128": { recordType: "128", recordCode: "TL04" },
      "778": { recordType: "778", recordCode: "ST310N" },
      "131": { recordType: "131", recordCode: "T123" },
      "396": { recordType: "396", recordCode: "T396" },
    }[templateId];
    try {
      const before = await this.readEditorPage(canonical, timeoutMs);
      await this.#connection.evaluate(
        invokeFixedProbe(FIXED_KNOWN_TEMPLATE_ADD_COMMAND, {
          target: canonical,
          templateId,
          expectedRuntimeFunctionHash: "19510095bc198f51ed297e2ba02291d9e6d3ebc72da7b0724886af7ff60ae5cc",
        }),
      );
      const after = await this.readEditorPage(canonical, timeoutMs);
      const beforeIds = new Set(before.records.map(({ recordId }) => recordId));
      const added = after.records.filter(({ recordId }) => !beforeIds.has(recordId));
      const removed = before.records.filter(
        ({ recordId }) => !after.records.some((record) => record.recordId === recordId),
      );
      const createdRecord = added[0];
      if (
        added.length !== 1 ||
        removed.length !== 0 ||
        after.records.length !== before.records.length + 1 ||
        createdRecord === undefined ||
        createdRecord.recordType !== expected.recordType ||
        createdRecord.recordCode !== expected.recordCode ||
        after.published !== before.published
      ) {
        throw new Error("Known-template add did not produce one exact expected record-set delta.");
      }
      for (const prior of before.records) {
        const reread = after.records.find(({ recordId }) => recordId === prior.recordId);
        if (reread === undefined || !jsonTextEqual(reread, prior)) {
          throw new Error("Known-template add changed an existing record identity.");
        }
      }
      return {
        target: canonical,
        templateId,
        beforeRecords: before.records,
        afterRecords: after.records,
        createdRecord,
        publishedUnchanged: true,
      };
    } finally {
      await this.restoreRoot(timeoutMs);
    }
  }

  async runFixedPageLifecycle(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<FixedPageLifecycleResult> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    let temporaryPageId: string | null = null;
    let restoreSortAttempted = false;
    let deleteAttempted = false;
    let completed = false;
    let baselineOrder: readonly string[] = [];
    try {
      const baselineProject = await this.#readLifecycleProject(canonical, timeoutMs);
      baselineOrder = baselineProject.pageOrder;
      if (baselineOrder.length !== 1 || baselineOrder[0] !== canonical.pageId) {
        throw new Error("Fixed page lifecycle requires the reproduced one-source-page lab baseline.");
      }
      const sourceBefore = await this.readEditorPage(canonical, timeoutMs);
      if (sourceBefore.published !== "" || sourceBefore.records.length === 0) {
        throw new Error("Fixed page lifecycle requires one exact unpublished nonblank source page.");
      }
      await this.#readLifecycleProject(canonical, timeoutMs);
      const duplicate = await this.#connection.evaluate<{
        dispatched: true;
        temporaryPageId: string;
      }>(invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
        action: "duplicate",
        target: canonical,
        expectedPageOrder: baselineOrder,
      }));
      temporaryPageId = duplicate.temporaryPageId;
      const afterDuplicate = await this.#readLifecycleProject(canonical, timeoutMs);
      const expectedWithTemporary = [canonical.pageId, temporaryPageId];
      if (
        afterDuplicate.pageOrder.length !== 2 ||
        afterDuplicate.pageOrder[0] !== expectedWithTemporary[0] ||
        afterDuplicate.pageOrder[1] !== expectedWithTemporary[1]
      ) throw new Error("Duplicate receipt did not bind one exact appended temporary page.");

      const duplicatePage = await this.readEditorPage(
        { projectId: canonical.projectId, pageId: temporaryPageId },
        timeoutMs,
      );
      const beforeSequence = sourceBefore.records.map(
        ({ recordType, recordCode, recordCategory }) => ({ recordType, recordCode, recordCategory }),
      );
      const duplicateSequence = duplicatePage.records.map(
        ({ recordType, recordCode, recordCategory }) => ({ recordType, recordCode, recordCategory }),
      );
      const sourceRecordIds = sourceBefore.records.map(({ recordId }) => recordId);
      const duplicateRecordIds = duplicatePage.records.map(({ recordId }) => recordId);
      if (
        duplicatePage.published !== "" ||
        !jsonTextEqual(beforeSequence, duplicateSequence) ||
        duplicateRecordIds.length !== sourceRecordIds.length ||
        duplicateRecordIds.some((recordId) => sourceRecordIds.includes(recordId))
      ) throw new Error("Temporary duplicate did not preserve exact sanitized record parity.");

      await this.#readLifecycleProject(canonical, timeoutMs);
      await this.#connection.evaluate(
        invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
          action: "sort",
          target: canonical,
          pageOrder: [temporaryPageId, canonical.pageId],
        }),
      );
      const reversed = await this.#readLifecycleProject(canonical, timeoutMs);
      if (reversed.pageOrder[0] !== temporaryPageId || reversed.pageOrder[1] !== canonical.pageId) {
        throw new Error("Temporary page order mutation was not proved by fresh reread.");
      }

      restoreSortAttempted = true;
      await this.#connection.evaluate(
        invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
          action: "sort",
          target: canonical,
          pageOrder: expectedWithTemporary,
        }),
      );
      const restoredOrder = await this.#readLifecycleProject(canonical, timeoutMs);
      if (!jsonTextEqual(restoredOrder.pageOrder, expectedWithTemporary)) {
        throw new Error("Temporary page order restore was not proved by fresh reread.");
      }

      deleteAttempted = true;
      await this.#connection.evaluate(
        invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
          action: "delete_temp",
          target: canonical,
          temporaryPageId,
          expectedPageOrder: restoredOrder.pageOrder,
        }),
      );
      const finalProject = await this.#readLifecycleProject(canonical, timeoutMs);
      if (!jsonTextEqual(finalProject.pageOrder, baselineOrder)) {
        throw new Error("Temporary page cleanup did not restore the exact baseline page order.");
      }
      const sourceAfter = await this.readEditorPage(canonical, timeoutMs);
      const restoredRecordIds = sourceAfter.records.map(({ recordId }) => recordId);
      const sourceUnchanged =
        sourceAfter.published === sourceBefore.published &&
        sourceAfter.changed === sourceBefore.changed &&
        jsonTextEqual(restoredRecordIds, sourceRecordIds);
      if (!sourceUnchanged) {
        throw new Error("Source page identity changed during the fixed lifecycle transaction.");
      }
      completed = true;
      return {
        baseline: {
          target: canonical,
          activePageIds: baselineOrder,
          pageOrder: baselineOrder,
          sourceRecordIds,
          sourcePublished: false,
          sourceChanged: sourceBefore.changed,
        },
        restored: {
          target: canonical,
          activePageIds: finalProject.activePageIds,
          pageOrder: finalProject.pageOrder,
          sourceRecordIds: restoredRecordIds,
          sourcePublished: false,
          sourceChanged: sourceAfter.changed,
          temporaryPageId,
          temporaryPageAbsent: !finalProject.activePageIds.includes(temporaryPageId),
          pageOrderRestored: jsonTextEqual(finalProject.pageOrder, baselineOrder),
          sourceUnchanged,
          exactBaselineRestored:
            !finalProject.activePageIds.includes(temporaryPageId) &&
            jsonTextEqual(finalProject.pageOrder, baselineOrder) &&
            sourceUnchanged,
        },
      };
    } finally {
      try {
        if (!completed && temporaryPageId !== null) {
          const current = await this.#readLifecycleProject(canonical, timeoutMs).catch(() => null);
          if (current?.pageOrder.includes(temporaryPageId) === true) {
            if (
              !restoreSortAttempted &&
              current.pageOrder.length === 2 &&
              !jsonTextEqual(current.pageOrder, [canonical.pageId, temporaryPageId])
            ) {
              restoreSortAttempted = true;
              await this.#connection.evaluate(
                invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
                  action: "sort",
                  target: canonical,
                  pageOrder: [canonical.pageId, temporaryPageId],
                }),
              ).catch(() => undefined);
              await this.#readLifecycleProject(canonical, timeoutMs).catch(() => null);
            }
            if (!deleteAttempted) {
              deleteAttempted = true;
              await this.#connection.evaluate(
                invokeFixedProbe(FIXED_PAGE_LIFECYCLE_COMMAND, {
                  action: "delete_temp",
                  target: canonical,
                  temporaryPageId,
                  expectedPageOrder: current.pageOrder,
                }),
              ).catch(() => undefined);
            }
          }
        }
      } finally {
        await this.restoreRoot(timeoutMs);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Trusted browser session is closed.");
  }

  async #readRecord(
    target: LabRecordTarget,
    kind: "standard" | "t123" | "zero_server",
    timeoutMs: number,
  ): Promise<ExactEditorRecordRead> {
    this.#assertOpen();
    const canonical = canonicalRecordTarget(target);
    const page = await this.readEditorPage(canonical, timeoutMs);
    if (page.records.filter((record) => record.recordId === canonical.recordId).length !== 1) {
      throw new Error("The exact record was not uniquely present on the editor page.");
    }
    return this.#connection.evaluate<ExactEditorRecordRead>(
      invokeFixedProbe(EXACT_RECORD_READ_PROBE, { kind, target: canonical }),
    );
  }

  async #writePublication(
    target: LabPageTarget,
    action: "publish" | "unpublish",
    timeoutMs: number,
  ): Promise<FixedBrowserDispatchResult> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    await this.readEditorPage(canonical, timeoutMs);
    return this.#connection.evaluate<FixedBrowserDispatchResult>(
      invokeFixedProbe(FIXED_PUBLICATION_WRITE_PROBE, { target: canonical, action }),
    );
  }

  async #readLifecycleProject(
    target: LabPageTarget,
    timeoutMs: number,
  ): Promise<{
    readonly uiReady: boolean;
    readonly target: LabPageTarget;
    readonly activePageIds: readonly string[];
    readonly pageOrder: readonly string[];
  }> {
    await this.readProject(target.projectId, timeoutMs);
    return waitForDomProbe(
      this.#connection,
      invokeFixedProbe(PAGE_LIFECYCLE_READ_PROBE, { target }),
      (probe) =>
        probe.target.projectId === target.projectId &&
        probe.target.pageId === target.pageId &&
        probe.pageOrder.includes(target.pageId),
      timeoutMs,
    );
  }

  async #withZeroRuntime<T>(
    target: LabRecordTarget,
    timeoutMs: number,
    action: (read: ExactEditorRecordRead) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const canonical = canonicalRecordTarget(target);
    try {
      const page = await this.readEditorPage(canonical, timeoutMs);
      const matches = page.records.filter((record) => record.recordId === canonical.recordId);
      if (
        matches.length !== 1 ||
        matches[0]!.recordType !== "396" ||
        matches[0]!.recordCode !== "T396"
      ) {
        throw new Error("The exact record is not the reproduced T396 / 396 runtime contract.");
      }
      await this.#connection.evaluate(
        invokeFixedProbe(ZERO_OPEN_COMMAND, { target: canonical }),
      );
      const read = await waitForDomProbe<ExactEditorRecordRead & { uiReady: boolean }>(
        this.#connection,
        invokeFixedProbe(ZERO_RUNTIME_READ_PROBE, {
          target: canonical,
          identity: matches[0],
        }),
        (probe) =>
          probe.target.projectId === canonical.projectId &&
          probe.target.pageId === canonical.pageId &&
          probe.target.recordId === canonical.recordId &&
          probe.identity.recordType === "396" &&
          probe.identity.recordCode === "T396",
        timeoutMs,
      );
      return await action(read);
    } finally {
      try {
        await this.#connection.evaluate(
          invokeFixedProbe(ZERO_CLOSE_COMMAND, { target: canonical }),
        );
      } finally {
        await this.restoreRoot(timeoutMs);
      }
    }
  }

  async #withPageSettings<T>(
    target: LabPageTarget,
    timeoutMs: number,
    action: (read: ExactPageSettingsRead) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    try {
      const project = await this.readProject(canonical.projectId, timeoutMs);
      if (!project.pageIds.includes(canonical.pageId)) {
        throw new Error("The exact page is not owned by the current project surface.");
      }
      await this.#connection.evaluate(
        invokeFixedProbe(PAGE_SETTINGS_OPEN_COMMAND, { target: canonical }),
      );
      const read = await waitForDomProbe<ExactPageSettingsRead & { uiReady: boolean }>(
        this.#connection,
        invokeFixedProbe(PAGE_SETTINGS_READ_PROBE, { target: canonical }),
        (probe) =>
          probe.target.projectId === canonical.projectId &&
          probe.target.pageId === canonical.pageId,
        timeoutMs,
      );
      return await action(read);
    } finally {
      try {
        await this.#connection.evaluate(PAGE_SETTINGS_CLOSE_COMMAND);
      } finally {
        await this.restoreRoot(timeoutMs);
      }
    }
  }

  async #withPageHeadCode<T>(
    target: LabPageTarget,
    timeoutMs: number,
    action: (read: ExactPageHeadCodeRead) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const canonical = canonicalPageTarget(target);
    try {
      const project = await this.readProject(canonical.projectId, timeoutMs);
      if (!project.pageIds.includes(canonical.pageId)) {
        throw new Error("The exact page is not owned by the current project surface.");
      }
      const expectedUrl = pageHeadCodeUrl(canonical);
      const read = await navigateAndProbe<ExactPageHeadCodeRead>(
        this.#connection,
        expectedUrl,
        invokeFixedProbe(PAGE_HEAD_CODE_READ_PROBE, { target: canonical }),
        timeoutMs,
        (probe) =>
          probe.target.projectId === canonical.projectId &&
          probe.target.pageId === canonical.pageId &&
          probe.saveFunctionHash === PAGE_HEAD_CODE_SAVE_FUNCTION_HASH,
      );
      return await action(read);
    } finally {
      await this.restoreRoot(timeoutMs);
    }
  }
}

export async function createLoopbackCdpTrustedBrowserSession(
  target: CdpTarget,
): Promise<AuthorityOwnedLoopbackBrowserSession> {
  return LoopbackCdpTrustedBrowserSession.create(target);
}
