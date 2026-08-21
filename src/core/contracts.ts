export const CHANGE_OPERATIONS = [
  "standard.field.patch",
  "t123.code.replace",
  "zero.leaf.patch",
  "zero.responsive.patch",
  "zero.shape.clone",
  "zero.property.patch",
  "zero.element.clone",
  "page.seo.patch",
  "page.head.code.replace",
  "standard.template.add",
  "page.reference.clone",
  "page.reference.cleanup",
  "page.lifecycle",
] as const;

export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

export const CHANGESET_STATES = [
  "PLANNED",
  "APPLIED",
  "VERIFIED",
  "ROLLED_BACK",
  "FAILED",
] as const;

export type ChangeSetState = (typeof CHANGESET_STATES)[number];

export interface ProjectTarget {
  kind: "project";
  projectId: string;
}

export interface PageTarget {
  kind: "page";
  projectId: string;
  pageId: string;
}

export interface RecordTarget {
  kind: "record";
  projectId: string;
  pageId: string;
  recordId: string;
}

export interface ElementTarget {
  kind: "element";
  projectId: string;
  pageId: string;
  recordId: string;
  elementId: string;
}

export type ExactTarget = ProjectTarget | PageTarget | RecordTarget | ElementTarget;

export interface StandardFieldPatch {
  operation: "standard.field.patch";
  target: RecordTarget;
  expectedIdentity: {
    recordType: string;
    recordCode: string;
  };
  /** Exact existing own top-level string field from a fresh standard read. */
  field: string;
  value: string;
}

export interface T123LiteralReplacement {
  readonly match: string;
  readonly replacement: string;
  readonly expectedMatches: number;
}

export type T123CodeEditRequest =
  | { readonly kind: "full_replace"; readonly code: string }
  | { readonly kind: "replace_once"; readonly match: string; readonly replacement: string }
  | { readonly kind: "replace_literals"; readonly replacements: readonly T123LiteralReplacement[] };

export interface T123CodeReplace {
  operation: "t123.code.replace";
  target: RecordTarget;
  edit: T123CodeEditRequest;
}

export interface ZeroLeafPatch {
  operation: "zero.leaf.patch";
  target: ElementTarget;
  path: "link";
  value: string;
}

export interface ZeroResponsivePatch {
  operation: "zero.responsive.patch";
  target: ElementTarget;
  path: "left-res-480";
  value: number;
}

export interface ZeroShapeClone {
  operation: "zero.shape.clone";
  target: ElementTarget;
  offset: { left: number; top: number };
}

export type BasicZeroElementType = "text" | "image" | "shape" | "button" | "html";
export type ZeroPrimitiveKind = "string" | "number" | "boolean" | "null";
export type ZeroPrimitiveValue = string | number | boolean | null;

export interface ZeroPropertyPatch {
  operation: "zero.property.patch";
  target: ElementTarget;
  expectedElementType: BasicZeroElementType;
  property: string;
  expectedPrimitiveKind: ZeroPrimitiveKind;
  value: ZeroPrimitiveValue;
}

export interface ZeroElementClone {
  operation: "zero.element.clone";
  target: ElementTarget;
  expectedElementType: BasicZeroElementType;
  offset: { left: number; top: number };
}

export interface PageSeoPatch {
  operation: "page.seo.patch";
  target: PageTarget;
  field: "meta_descr";
  value: string;
}

export interface PageHeadCodeReplace {
  operation: "page.head.code.replace";
  target: PageTarget;
  code: string;
}

export type ChangeRequest =
  | StandardFieldPatch
  | T123CodeReplace
  | ZeroLeafPatch
  | ZeroResponsivePatch
  | ZeroShapeClone
  | ZeroPropertyPatch
  | ZeroElementClone
  | PageSeoPatch
  | PageHeadCodeReplace;

export interface AdapterState {
  /** A canonical hash of the complete state relevant to this adapter. */
  hash: string;
  /** Adapter-private state. It may contain lab content and stays in ignored local storage. */
  payload: unknown;
  revision?: string;
  summary: string;
}

export interface PlannedMutation {
  adapter: string;
  capability: string;
  request: ChangeRequest;
  expectedBeforeHash: string;
  expectedBeforeRevision?: string;
  expectedAfterHash: string;
  intendedState: AdapterState;
  changedPaths: readonly string[];
  summary: string;
}

export interface ChangeAdapter {
  readonly id: string;
  readonly capabilities: readonly string[];
  supports(request: ChangeRequest): boolean;
  read(target: ExactTarget): Promise<AdapterState>;
  plan(before: AdapterState, request: ChangeRequest): PlannedMutation;
  apply(plan: PlannedMutation): Promise<AdapterState>;
  restore(target: ExactTarget, snapshot: AdapterState): Promise<AdapterState>;
}

export interface SnapshotEnvelope {
  format: "tilda-mcp-snapshot-v1";
  snapshotId: string;
  createdAt: string;
  adapter: string;
  target: ExactTarget;
  stateHash: string;
  revision?: string;
  summary: string;
}

export interface VerificationRecord {
  checkedAt: string;
  expectedHash: string;
  actualHash: string;
  exactMatch: boolean;
  changedPaths?: readonly string[];
}

/** Content-free provenance binding a plan to one exact ephemeral task grant. */
export interface ChangeSetTaskAuthority {
  taskId: string;
  grantHash: string;
}

export interface ChangeSetRecord {
  format: "tilda-mcp-changeset-v1";
  changeSetId: string;
  snapshotId: string;
  state: ChangeSetState;
  createdAt: string;
  updatedAt: string;
  adapter: string;
  capability: string;
  target: ExactTarget;
  operation: ChangeOperation;
  requestHash: string;
  expectedBeforeHash: string;
  expectedBeforeRevision?: string;
  expectedAfterHash: string;
  changedPaths: readonly string[];
  summary: string;
  taskAuthority?: ChangeSetTaskAuthority;
  /** Digest only. Raw idempotency keys must never enter the journal. */
  planIdempotencyHash?: string;
  appliedHash?: string;
  verification?: VerificationRecord;
  failureCode?: string;
  reconciliationCode?: string;
}

export const PUBLICATION_JOURNAL_STATES = [
  "CLAIMED",
  "SUCCEEDED",
  "NOOP",
  "FAILED",
  "AMBIGUOUS",
] as const;

export type PublicationJournalState = (typeof PUBLICATION_JOURNAL_STATES)[number];

/**
 * Durable, content-free publication intent journal. Public URLs and Tilda
 * response bodies deliberately stay out of local state.
 */
export interface PublicationJournalRecord {
  format: "tilda-mcp-publication-v1";
  keyHash: string;
  intentHash: string;
  action: "publish" | "unpublish";
  target: PageTarget;
  state: PublicationJournalState;
  createdAt: string;
  updatedAt: string;
  beforePublished: boolean;
  beforeChangedHash: string;
  failureCode?: string;
  reconciliationCode?: string;
}

export interface AdapterRegistry {
  forRequest(request: ChangeRequest): ChangeAdapter;
  byId(adapterId: string): ChangeAdapter;
  listCapabilities(): readonly {
    adapter: string;
    capabilities: readonly string[];
  }[];
}

export class TildaEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TildaEngineError";
  }
}
