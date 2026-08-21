import type {
  ElementTarget,
  PageTarget,
  RecordTarget,
} from "../core/contracts.js";

export interface StandardRecordData {
  readonly record: Readonly<Record<string, unknown>>;
  readonly recordType: string;
  readonly recordCode: string;
  readonly ambiguousFields?: readonly string[];
}

export interface T123RecordData {
  readonly record: Readonly<Record<string, unknown>>;
  readonly code: string;
}

export interface ZeroRecordData {
  /** Clean runtime model from the Zero editor, never the encoded /zero/get body. */
  readonly model: unknown;
  readonly serverCanonicalHash?: string;
}

export interface PageSettingsData {
  /** Ordered form entries preserve duplicate and unknown fields. */
  readonly fields: readonly (readonly [string, string])[];
  readonly changed: string;
  readonly published: string;
}

export interface PageHeadCodeData {
  /** Full page-specific HEAD code. Treat as untrusted content and never log it. */
  readonly code: string;
  readonly changed: string;
  readonly published: string;
}

export interface PublicationData {
  readonly changed: string;
  readonly published: string;
  readonly pageUrl: string;
  readonly publicUrl: string;
}

export interface DispatchReceipt {
  readonly operationId: string;
  readonly requestDispatched: boolean;
  readonly acknowledgement: "acknowledged" | "rejected" | "unknown";
  readonly publishObserved: false;
}

/**
 * Adapter-only port. Its concrete implementation owns one exact browser lease,
 * fresh binding, target guards, and fixed checked-in commands.
 */
export interface BoundAdapterSession {
  readonly leaseId: string;
  readonly sessionId: string;
  readStandard(target: RecordTarget): Promise<StandardRecordData>;
  writeStandard(
    target: RecordTarget,
    field: string,
    value: string,
  ): Promise<DispatchReceipt>;
  readT123(target: RecordTarget): Promise<T123RecordData>;
  writeT123(target: RecordTarget, code: string): Promise<DispatchReceipt>;
  readZero(target: RecordTarget | ElementTarget): Promise<ZeroRecordData>;
  writeZero(target: RecordTarget | ElementTarget, cleanModel: unknown): Promise<DispatchReceipt>;
  readPageSettings(target: PageTarget): Promise<PageSettingsData>;
  writePageSettings(
    target: PageTarget,
    fields: readonly (readonly [string, string])[],
  ): Promise<DispatchReceipt>;
  readPageHeadCode(target: PageTarget): Promise<PageHeadCodeData>;
  writePageHeadCode(
    target: PageTarget,
    code: string,
    expectedCurrentCode: string,
  ): Promise<DispatchReceipt>;
  readPublication(target: PageTarget): Promise<PublicationData>;
  publish(target: PageTarget): Promise<DispatchReceipt>;
  unpublish(target: PageTarget): Promise<DispatchReceipt>;
}

export interface AdapterSessionFactory {
  withSession<T>(action: (session: BoundAdapterSession) => Promise<T>): Promise<T>;
}
