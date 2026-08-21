export type PracticalEvidenceStatus =
  | "AVAILABLE"
  | "COPY_ACCEPTANCE_REQUIRED"
  | "UNAVAILABLE_EVIDENCE_GAP";

export interface PracticalAdapterEvidence {
  readonly capability: string;
  readonly status: PracticalEvidenceStatus;
  readonly boundary: string;
}

/** Checked-in fail-closed routing; unsupported areas never fall back to guessed requests. */
const evidenceEntries = [
  { capability: "standard.inspect", status: "AVAILABLE", boundary: "Any exact readable standard settings record; read only." },
  { capability: "standard.field.patch", status: "AVAILABLE", boundary: "Any exact existing own top-level string field discovered by a fresh standard-record read." },
  { capability: "block.library.inspect", status: "AVAILABLE", boundary: "Read only from an exact currently rendered library surface; no template is selected." },
  { capability: "standard.known-template.add", status: "COPY_ACCEPTANCE_REQUIRED", boundary: "Templates 128/778/131/396 have EXP-06 create/readback observation; cleanup replay remains unproven." },
  { capability: "standard.clone", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "No exact clone/readback/cleanup contract for a record." },
  { capability: "standard.order", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "EXP-07 is blocked; page sort cannot be reused for records." },
  { capability: "zero.text.link.patch", status: "AVAILABLE", boundary: "Exact text element link leaf." },
  { capability: "zero.shape.left-res-480.patch", status: "AVAILABLE", boundary: "Exact shape element and breakpoint 480." },
  { capability: "zero.shape.clone", status: "AVAILABLE", boundary: "Known-valid shape clone with exact reread and cleanup." },
  { capability: "zero.property.patch", status: "AVAILABLE", boundary: "One existing own primitive field on exact text/image/shape/button/html; no nested creation or identity fields." },
  { capability: "zero.element.clone", status: "AVAILABLE", boundary: "Clone the current valid exact text/image/shape/button/html element model with new identity and geometry." },
  { capability: "zero.created-shape.move", status: "COPY_ACCEPTANCE_REQUIRED", boundary: "Exact same-transaction admitted shape clone only." },
  { capability: "zero.created-shape.delete", status: "AVAILABLE", boundary: "Exact same-transaction admitted shape clone only." },
  { capability: "page.reference.clone", status: "AVAILABLE", boundary: "Same-project duplicate with ordered record parity; initially unpublished." },
  { capability: "page.reference.cross-project", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "No reproduced cross-project copy/move contract." },
  { capability: "asset.upload-or-replace", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "EXP-18 lacks trusted lab fixture and reversible live contract." },
  { capability: "form.configure-or-clone", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "EXP-20 lacks synthetic form/webhook lab fixture and reproduced write contract." },
  { capability: "popup.configure-or-clone", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "No exact popup write/readback/restore evidence." },
  { capability: "catalog.write", status: "UNAVAILABLE_EVIDENCE_GAP", boundary: "Official import path exists, but no lab catalog transaction evidence." },
] satisfies PracticalAdapterEvidence[];

export const PRACTICAL_ADAPTER_EVIDENCE: readonly PracticalAdapterEvidence[] = Object.freeze(
  evidenceEntries.map((entry) => Object.freeze(entry)),
);

export function practicalAdapterEvidence(capability: string): PracticalAdapterEvidence {
  const matches = PRACTICAL_ADAPTER_EVIDENCE.filter((entry) => entry.capability === capability);
  if (matches.length !== 1) {
    return Object.freeze({
      capability,
      status: "UNAVAILABLE_EVIDENCE_GAP",
      boundary: "No checked-in adapter recipe exists; one bounded copy experiment is required.",
    });
  }
  return matches[0]!;
}
