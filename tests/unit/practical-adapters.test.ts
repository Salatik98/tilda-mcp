import { describe, expect, it } from "vitest";

import { practicalAdapterEvidence } from "../../src/adapters/practical-evidence.js";
import { verifySameProjectReferenceClone } from "../../src/adapters/reference-copy.js";
import {
  inspectStandardRecord,
  planStandardRecordPatch,
} from "../../src/adapters/standard-schema.js";
import {
  planKnownTemplateAddPreflight,
  requireStandardStructuralRecipe,
} from "../../src/adapters/structural-recipes.js";
import {
  admitExactShapeClone,
  planCreatedShapeDelete,
  planCreatedShapeMove,
  planProvenZeroLeafPatch,
} from "../../src/adapters/zero-practical.js";
import { isSafeStandardContentField } from "../../src/core/standard-field-safety.js";
import { canonicalHash } from "../../src/research/hash.js";

const sourceIdentity = {
  recordId: "1001",
  recordType: "128",
  recordCode: "TL04",
  recordCategory: "8",
};

function zeroBaseline() {
  return {
    "0": { elem_id: "1001", type: "text", link: "", unknown: { keep: true } },
    "1": { elem_id: "1002", type: "shape", left: "10", top: "20", zindex: 1, color: "#fff" },
    groups: { keep: true },
    meta: { keep: true },
    timestamp: 1,
    unknownMetadata: { keep: true },
  };
}

describe("practical adapter recipes", () => {
  it("inspects all standard fields but marks only live-reproduced recipes writable", () => {
    const record = {
      id: "1001",
      pageid: "2001",
      title: "before",
      image: "https://example.test/a.jpg",
      unknown: { keep: true },
    };
    const inspection = inspectStandardRecord("128", "TL04", record);
    expect(isSafeStandardContentField("custom_field:desktop")).toBe(true);
    expect(isSafeStandardContentField("id")).toBe(false);
    expect(isSafeStandardContentField("pageid")).toBe(false);
    expect(isSafeStandardContentField("page-id")).toBe(false);
    expect(isSafeStandardContentField("toString")).toBe(false);
    expect(inspection.fields.find(({ name }) => name === "title")).toMatchObject({
      writable: true,
      evidence: "SCHEMA_DRIVEN_EXACT_STRING",
    });
    expect(inspection.fields.find(({ name }) => name === "image")).toMatchObject({
      writable: true,
      evidence: "SCHEMA_DRIVEN_EXACT_STRING",
    });
    expect(inspection.fields.find(({ name }) => name === "id")).toMatchObject({
      writable: false,
      evidence: "READ_ONLY_UNPROVEN_WRITE",
    });
    expect(inspection.fields.find(({ name }) => name === "pageid")).toMatchObject({
      writable: false,
      evidence: "READ_ONLY_UNPROVEN_WRITE",
    });
    const plan = planStandardRecordPatch({
      recordType: "128",
      recordCode: "TL04",
      record,
      field: "title",
      expectedCurrentValue: "before",
      value: "after",
    });
    expect(plan.record).toEqual({ ...record, title: "after" });
    expect(plan.record.unknown).toEqual({ keep: true });
    expect(() => planStandardRecordPatch({
      recordType: "128",
      recordCode: "TL04",
      record,
      field: "nested",
      expectedCurrentValue: "not-an-object",
      value: "blocked",
    })).toThrow(/not represented as text/u);
    expect(() => planStandardRecordPatch({
      recordType: "128",
      recordCode: "TL04",
      record,
      field: "id",
      expectedCurrentValue: "1001",
      value: "9999",
    })).toThrow(/not canonical/u);
  });

  it("keeps existing Zero writes on exact reproduced leaves", () => {
    const before = zeroBaseline();
    const plan = planProvenZeroLeafPatch({
      model: before,
      elementId: "1001",
      path: "link",
      expectedCurrentValue: "",
      value: "#next",
    });
    expect(plan.changedPaths).toEqual(["1001.link"]);
    expect(plan.model).toMatchObject({
      "0": { link: "#next", unknown: { keep: true } },
      unknownMetadata: { keep: true },
    });
    expect(() => planProvenZeroLeafPatch({
      model: before,
      elementId: "1002",
      path: "link",
      expectedCurrentValue: "",
      value: "#blocked",
    })).toThrow(/lacks live write evidence/u);
  });

  it("admits, moves, and deletes only one exact reread shape clone", () => {
    const before = zeroBaseline();
    const after = {
      ...structuredClone(before),
      "2": { elem_id: "2001", type: "shape", left: "15", top: "26", zindex: 2, color: "#fff" },
    };
    const receipt = admitExactShapeClone({
      recordId: "9305",
      before,
      after,
      sourceElementId: "1002",
    });
    const element = after["2"];
    const moved = planCreatedShapeMove({
      recordId: "9305",
      model: after,
      receipt,
      expectedElementHash: canonicalHash(element),
      delta: { left: 2, top: -1 },
    });
    expect(moved.model["2"]).toMatchObject({ left: "17", top: "25" });
    expect(moved.evidence).toBe("DERIVED_EXACT_CREATED_SHAPE_REQUIRES_ONE_BOUNDED_COPY_ACCEPTANCE");
    const cleanup = planCreatedShapeDelete({
      recordId: "9305",
      model: after,
      receipt,
      expectedElementHash: canonicalHash(element),
    });
    expect(cleanup.model).not.toHaveProperty("2");
    expect(cleanup.changedPaths).toEqual(["elements.-2001"]);
    expect(() => planCreatedShapeDelete({
      recordId: "999999999",
      model: after,
      receipt,
      expectedElementHash: canonicalHash(element),
    })).toThrow(/not an admitted/u);
  });

  it("verifies same-project reference clone parity without reusing record IDs", () => {
    const evidence = verifySameProjectReferenceClone({
      sourcePageId: "9201",
      clonePageId: "9203",
      clonePublished: false,
      sourceRecords: [sourceIdentity, { ...sourceIdentity, recordId: "1002", recordType: "131", recordCode: "T123" }],
      cloneRecords: [
        { ...sourceIdentity, recordId: "2001" },
        { ...sourceIdentity, recordId: "2002", recordType: "131", recordCode: "T123" },
      ],
    });
    expect(evidence).toMatchObject({ recordParity: true, unpublished: true });
    expect(() => verifySameProjectReferenceClone({
      sourcePageId: "9201",
      clonePageId: "9203",
      clonePublished: false,
      sourceRecords: [sourceIdentity],
      cloneRecords: [{ ...sourceIdentity, recordId: "2001", recordCode: "BF502N" }],
    })).toThrow(/family sequence/u);
  });

  it("keeps add preflight non-dispatchable and fails closed for clone/order/assets/forms", () => {
    expect(planKnownTemplateAddPreflight({ templateId: "128" })).toMatchObject({
      remoteDispatchAllowed: false,
      reason: "BOUNDED_CREATE_CLEANUP_ACCEPTANCE_REQUIRED",
    });
    expect(requireStandardStructuralRecipe("standard.add").state).toBe("PREFLIGHT_ONLY");
    expect(() => requireStandardStructuralRecipe("standard.clone")).toThrow(/No exact standard-record clone/u);
    expect(practicalAdapterEvidence("asset.upload-or-replace").status).toBe("UNAVAILABLE_EVIDENCE_GAP");
    expect(practicalAdapterEvidence("form.configure-or-clone").status).toBe("UNAVAILABLE_EVIDENCE_GAP");
    expect(practicalAdapterEvidence("unseen.operation").boundary).toContain("bounded copy experiment");
  });
});
