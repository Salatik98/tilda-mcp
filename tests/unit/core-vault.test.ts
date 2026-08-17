import { describe, expect, it } from "vitest";

import type {
  AdapterState,
  PlannedMutation,
  StandardFieldPatch,
} from "../../src/core/contracts.js";
import { VolatileSnapshotVault } from "../../src/core/vault.js";

const target = {
  kind: "record" as const,
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};

function material() {
  const before: AdapterState = {
    hash: `sha256:${"1".repeat(64)}`,
    payload: { title: "private before" },
    summary: "TL04 structural snapshot",
  };
  const request: StandardFieldPatch = {
    operation: "standard.field.patch",
    target,
    expectedIdentity: { recordType: "128", recordCode: "TL04" },
    field: "title",
    value: "private after",
  };
  const intendedState: AdapterState = {
    hash: `sha256:${"2".repeat(64)}`,
    payload: { title: "private after" },
    summary: "TL04 intended state",
  };
  const plan: PlannedMutation = {
    adapter: "test-adapter-v1",
    capability: "standard.field.patch",
    request,
    expectedBeforeHash: before.hash,
    expectedAfterHash: intendedState.hash,
    intendedState,
    changedPaths: ["record.title"],
    summary: "Patch exact lab title",
  };
  return { before, request, plan };
}

describe("VolatileSnapshotVault", () => {
  it("defensively clones material on both put and get", () => {
    const vault = new VolatileSnapshotVault();
    const input = material();
    vault.put("change-1", input);

    (input.before.payload as { title: string }).title = "caller mutation";
    const first = vault.get("change-1");
    expect(first.before.payload).toEqual({ title: "private before" });

    (first.before.payload as { title: string }).title = "reader mutation";
    expect(vault.get("change-1").before.payload).toEqual({ title: "private before" });
  });

  it("rejects non-cloneable private material without retaining it", () => {
    const vault = new VolatileSnapshotVault();
    const input = material();
    (input.before as { payload: unknown }).payload = { unsafe: () => "not cloneable" };

    expect(() => vault.put("change-2", input)).toThrow(
      expect.objectContaining({ code: "INVALID_VOLATILE_MATERIAL" }),
    );
    expect(vault.has("change-2")).toBe(false);
  });
});
