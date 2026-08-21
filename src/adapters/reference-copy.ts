import { TildaEngineError } from "../core/contracts.js";

const ID = /^[1-9]\d*$/u;

export interface PageReferenceRecordIdentity {
  readonly recordId: string;
  readonly recordType: string;
  readonly recordCode: string;
  readonly recordCategory: string;
}
export interface PageReferenceCloneEvidence {
  readonly sourcePageId: string;
  readonly clonePageId: string;
  readonly sameProject: true;
  readonly unpublished: true;
  readonly recordParity: true;
  readonly cleanupScope: "exact_transaction_created_clone";
  readonly evidence: "LIVE_REPRODUCED";
}

/**
 * Verify the deterministic part of EXP-16 without treating new record IDs as
 * reusable authority. Cross-project copy, folders, trash restore, and blank
 * creation intentionally remain outside this recipe.
 */
export function verifySameProjectReferenceClone(input: {
  readonly sourcePageId: string;
  readonly clonePageId: string;
  readonly clonePublished: boolean;
  readonly sourceRecords: readonly PageReferenceRecordIdentity[];
  readonly cloneRecords: readonly PageReferenceRecordIdentity[];
}): PageReferenceCloneEvidence {
  if (
    !ID.test(input.sourcePageId) ||
    !ID.test(input.clonePageId) ||
    input.sourcePageId === input.clonePageId ||
    input.clonePublished
  ) {
    throw new TildaEngineError("REFERENCE_CLONE_REJECTED", "Reference clone identity/state is invalid.");
  }
  if (input.sourceRecords.length === 0 || input.sourceRecords.length !== input.cloneRecords.length) {
    throw new TildaEngineError("REFERENCE_CLONE_REJECTED", "Reference clone record count changed.");
  }
  const sourceIds = new Set(input.sourceRecords.map(({ recordId }) => recordId));
  const cloneIds = new Set(input.cloneRecords.map(({ recordId }) => recordId));
  if (
    sourceIds.size !== input.sourceRecords.length ||
    cloneIds.size !== input.cloneRecords.length ||
    [...sourceIds].some((recordId) => cloneIds.has(recordId))
  ) {
    throw new TildaEngineError("REFERENCE_CLONE_REJECTED", "Reference clone record identities are ambiguous.");
  }
  const parity = input.sourceRecords.every((source, index) => {
    const clone = input.cloneRecords[index];
    return clone !== undefined &&
      source.recordType === clone.recordType &&
      source.recordCode === clone.recordCode &&
      source.recordCategory === clone.recordCategory;
  });
  if (!parity) {
    throw new TildaEngineError("REFERENCE_CLONE_REJECTED", "Reference clone family sequence changed.");
  }
  return Object.freeze({
    sourcePageId: input.sourcePageId,
    clonePageId: input.clonePageId,
    sameProject: true,
    unpublished: true,
    recordParity: true,
    cleanupScope: "exact_transaction_created_clone",
    evidence: "LIVE_REPRODUCED",
  });
}
