import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PageSettingsAdapter } from "../../src/adapters/page-settings.js";
import { PageHeadCodeAdapter } from "../../src/adapters/page-head-code.js";
import { StaticAdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterSessionFactory,
  BoundAdapterSession,
  DispatchReceipt,
  PageHeadCodeData,
  PageSettingsData,
  StandardRecordData,
  T123RecordData,
  ZeroRecordData,
} from "../../src/adapters/session.js";
import { StandardFieldAdapter } from "../../src/adapters/standard.js";
import { T123CodeAdapter } from "../../src/adapters/t123.js";
import { ZeroModelAdapter } from "../../src/adapters/zero.js";
import { TildaChangeSetEngine } from "../../src/core/engine.js";
import { ChangeSetStore } from "../../src/core/store.js";
import type { ElementTarget, PageTarget, RecordTarget } from "../../src/core/contracts.js";

const recordTarget: RecordTarget = {
  kind: "record",
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};
const pageTarget: PageTarget = {
  kind: "page",
  projectId: "9101",
  pageId: "9201",
};
const textTarget: ElementTarget = {
  ...recordTarget,
  kind: "element",
  recordId: "9305",
  elementId: "9401",
};
const shapeTarget: ElementTarget = {
  ...textTarget,
  elementId: "9402",
};

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt(): DispatchReceipt {
  return {
    operationId: crypto.randomUUID(),
    requestDispatched: true,
    acknowledgement: "acknowledged",
    publishObserved: false,
  };
}

class FakeSession implements BoundAdapterSession {
  readonly leaseId = "fake-lease";
  readonly sessionId = "fake-session";
  standard: StandardRecordData = {
    record: { id: recordTarget.recordId, title: "baseline", unknown: { keep: true } },
    recordType: "128",
    recordCode: "TL04",
  };
  t123: T123RecordData = { record: { id: "9303", code: "" }, code: "" };
  zero: ZeroRecordData = {
    model: {
      "0": { elem_id: textTarget.elementId, type: "text", link: "", unknown: { keep: true } },
      "1": { elem_id: shapeTarget.elementId, type: "shape", left: 10, top: 20, zindex: 3, "left-res-480": 5 },
      groups: { keep: true },
      meta: { keep: true },
      timestamp: 1,
      unknownMetadata: { keep: true },
    },
    serverCanonicalHash: "a".repeat(64),
  };
  settings: PageSettingsData = {
    fields: [["meta_descr", ""], ["unknown", "keep"]],
    changed: "1",
    published: "",
  };
  pageHead: PageHeadCodeData = {
    code: "<meta name=\"baseline\">",
    changed: "1",
    published: "",
  };
  writeCount = 0;

  async readStandard(): Promise<StandardRecordData> {
    return structuredClone(this.standard);
  }
  async writeStandard(_target: RecordTarget, field: "title" | "buttontitle", value: string) {
    this.writeCount += 1;
    this.standard = { ...this.standard, record: { ...this.standard.record, [field]: value } };
    return receipt();
  }
  async readT123(): Promise<T123RecordData> {
    return structuredClone(this.t123);
  }
  async writeT123(_target: RecordTarget, code: string) {
    this.writeCount += 1;
    this.t123 = { record: { ...this.t123.record, code }, code };
    return receipt();
  }
  async readZero(): Promise<ZeroRecordData> {
    return structuredClone(this.zero);
  }
  async writeZero(_target: RecordTarget | ElementTarget, cleanModel: unknown) {
    this.writeCount += 1;
    this.zero = { ...this.zero, model: structuredClone(cleanModel) };
    return receipt();
  }
  async readPageSettings(): Promise<PageSettingsData> {
    return structuredClone(this.settings);
  }
  async writePageSettings(_target: PageTarget, fields: readonly (readonly [string, string])[]) {
    this.writeCount += 1;
    this.settings = {
      fields: fields.map(([key, value]) => [key, value]),
      changed: String(Number(this.settings.changed) + 1),
      published: this.settings.published,
    };
    return receipt();
  }
  async readPageHeadCode(): Promise<PageHeadCodeData> {
    return structuredClone(this.pageHead);
  }
  async writePageHeadCode(_target: PageTarget, code: string, _expectedCurrentCode: string) {
    this.writeCount += 1;
    this.pageHead = {
      ...this.pageHead,
      code,
      changed: String(Number(this.pageHead.changed) + 1),
    };
    return receipt();
  }
  async readPublication() {
    return { changed: "1", published: "", pageUrl: "page9201.html", publicUrl: "https://example.test/" };
  }
  async publish() { return receipt(); }
  async unpublish() { return receipt(); }
}

function factory(session: FakeSession): AdapterSessionFactory {
  return { async withSession<T>(action: (bound: BoundAdapterSession) => Promise<T>) { return action(session); } };
}

describe("Phase 2 adapters and ChangeSet engine", () => {
  it("plans without a write and completes apply, verify, rollback, and baseline verify", async () => {
    const session = new FakeSession();
    const adapter = new StandardFieldAdapter(factory(session));
    mkdirSync(resolve(process.cwd(), ".tilda-runtime"), { recursive: true });
    const root = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "engine-test-"));
    temporaryRoots.push(root);
    const engine = new TildaChangeSetEngine(
      new StaticAdapterRegistry([adapter]),
      new ChangeSetStore(root),
    );

    const planned = await engine.plan({
      operation: "standard.field.patch",
      target: recordTarget,
      expectedIdentity: { recordType: "128", recordCode: "TL04" },
      field: "title",
      value: "changed",
    });
    expect(session.writeCount).toBe(0);
    expect((await engine.apply(planned.changeSet.changeSetId)).dryRun).toBe(true);
    expect(session.writeCount).toBe(0);
    expect((await engine.apply(planned.changeSet.changeSetId, false, "apply-standard-1")).changeSet.state).toBe("APPLIED");
    expect((await engine.verify(planned.changeSet.changeSetId)).changeSet.state).toBe("VERIFIED");
    expect((await engine.rollback(planned.changeSet.changeSetId, false, "rollback-standard-1")).changeSet.state).toBe("ROLLED_BACK");
    expect((await engine.verify(planned.changeSet.changeSetId)).changeSet.verification?.exactMatch).toBe(true);
    expect(session.standard.record).toMatchObject({ title: "baseline", unknown: { keep: true } });
  });

  it("rejects an unproved Standard family/field pair", async () => {
    const session = new FakeSession();
    const adapter = new StandardFieldAdapter(factory(session));
    const before = await adapter.read(recordTarget);
    expect(() => adapter.plan(before, {
      operation: "standard.field.patch",
      target: recordTarget,
      expectedIdentity: { recordType: "128", recordCode: "TL04" },
      field: "buttontitle",
      value: "no",
    })).toThrow(/not proven/u);
  });

  it("replaces and exactly restores full T123 code", async () => {
    const session = new FakeSession();
    const adapter = new T123CodeAdapter(factory(session));
    const before = await adapter.read(recordTarget);
    const plan = adapter.plan(before, { operation: "t123.code.replace", target: recordTarget, code: "<div>x</div>" });
    expect((await adapter.apply(plan)).hash).toBe(plan.expectedAfterHash);
    expect((await adapter.restore(recordTarget, before)).hash).toBe(before.hash);
  });

  it("patches only a proven Zero text link and preserves unknown fields", async () => {
    const session = new FakeSession();
    const adapter = new ZeroModelAdapter(factory(session));
    const before = await adapter.read(textTarget);
    const plan = adapter.plan(before, { operation: "zero.leaf.patch", target: textTarget, path: "link", value: "#next" });
    expect(plan.changedPaths).toEqual([`${textTarget.elementId}.link`]);
    expect((await adapter.apply(plan)).hash).toBe(plan.expectedAfterHash);
    expect(JSON.stringify(session.zero.model)).toContain('"unknown":{"keep":true}');
  });

  it("ignores only the volatile top-level Zero timestamp in stale-state checks", async () => {
    const session = new FakeSession();
    const adapter = new ZeroModelAdapter(factory(session));
    const first = await adapter.read(textTarget);
    (session.zero.model as Record<string, unknown>).timestamp = 999;
    const second = await adapter.read(textTarget);
    expect(second.hash).toBe(first.hash);
    expect(second.revision).toBe(first.revision);
    const plan = adapter.plan(first, {
      operation: "zero.leaf.patch",
      target: textTarget,
      path: "link",
      value: "#stable",
    });
    await expect(adapter.apply(plan)).resolves.toMatchObject({ hash: plan.expectedAfterHash });
  });

  it("supports only the reproduced shape 480 leaf and shape clone", async () => {
    const session = new FakeSession();
    const adapter = new ZeroModelAdapter(factory(session));
    const before = await adapter.read(shapeTarget);
    const responsive = adapter.plan(before, { operation: "zero.responsive.patch", target: shapeTarget, path: "left-res-480", value: 42 });
    expect(responsive.changedPaths).toEqual([`${shapeTarget.elementId}.left-res-480`]);
    const clone = adapter.plan(before, { operation: "zero.shape.clone", target: shapeTarget, offset: { left: 5, top: 6 } });
    expect(clone.changedPaths[0]).toMatch(/^elements\.\+\d+$/u);
    expect(JSON.stringify(clone.intendedState.payload)).toContain('"left":15');
    expect(clone.intendedState.payload).toMatchObject({
      model: {
        "0": { elem_id: textTarget.elementId },
        "1": { elem_id: shapeTarget.elementId },
        groups: { keep: true },
        meta: { keep: true },
        timestamp: 1,
        unknownMetadata: { keep: true },
      },
    });

    session.zero = {
      ...session.zero,
      model: {
        ...session.zero.model as Record<string, unknown>,
        "1": { elem_id: shapeTarget.elementId, type: "shape", left: "10", top: "20", zindex: 3, "left-res-480": 5 },
      },
    };
    const stringGeometryBefore = await adapter.read(shapeTarget);
    const stringGeometryClone = adapter.plan(stringGeometryBefore, {
      operation: "zero.shape.clone",
      target: shapeTarget,
      offset: { left: 5, top: 6 },
    });
    expect(JSON.stringify(stringGeometryClone.intendedState.payload)).toContain('"left":"15"');
    expect(JSON.stringify(stringGeometryClone.intendedState.payload)).toContain('"top":"26"');
  });

  it("preserves unknown page form fields across SEO patch and restore", async () => {
    const session = new FakeSession();
    const adapter = new PageSettingsAdapter(factory(session));
    const before = await adapter.read(pageTarget);
    const plan = adapter.plan(before, { operation: "page.seo.patch", target: pageTarget, field: "meta_descr", value: "test" });
    expect((await adapter.apply(plan)).hash).toBe(plan.expectedAfterHash);
    await adapter.restore(pageTarget, before);
    expect(session.settings.fields).toEqual([["meta_descr", ""], ["unknown", "keep"]]);
  });

  it("replaces complete page-specific HEAD code and restores it through the engine", async () => {
    const session = new FakeSession();
    const adapter = new PageHeadCodeAdapter(factory(session));
    const before = await adapter.read(pageTarget);
    const nextCode = "<meta name=\"replacement\"><script>void 0;</script>";
    const plan = adapter.plan(before, {
      operation: "page.head.code.replace",
      target: pageTarget,
      code: nextCode,
    });

    expect(plan.changedPaths).toEqual(["page.headcode"]);
    expect(plan.summary).toContain("without publishing");
    expect(plan.intendedState.payload).toEqual({ code: nextCode, published: "" });
    expect(session.writeCount).toBe(0);
    expect(() => adapter.plan(before, {
      operation: "page.head.code.replace",
      target: pageTarget,
      code: "<meta name=\"baseline\">",
    })).toThrow(/already matches/u);

    mkdirSync(resolve(process.cwd(), ".tilda-runtime"), { recursive: true });
    const root = mkdtempSync(resolve(process.cwd(), ".tilda-runtime", "head-engine-test-"));
    temporaryRoots.push(root);
    const engine = new TildaChangeSetEngine(
      new StaticAdapterRegistry([adapter]),
      new ChangeSetStore(root),
    );
    const planned = await engine.plan({
      operation: "page.head.code.replace",
      target: pageTarget,
      code: nextCode,
    });
    expect(planned.changeSet.capability).toBe("page.head.code.replace");
    expect(session.writeCount).toBe(0);
    expect((await engine.apply(planned.changeSet.changeSetId, false, "head-apply-1")).changeSet.state)
      .toBe("APPLIED");
    expect(session.pageHead.code).toBe(nextCode);
    expect(session.pageHead.published).toBe("");
    expect((await engine.verify(planned.changeSet.changeSetId)).changeSet.state).toBe("VERIFIED");
    expect((await engine.rollback(planned.changeSet.changeSetId, false, "head-rollback-1"))
      .changeSet.state).toBe("ROLLED_BACK");
    expect((await engine.verify(planned.changeSet.changeSetId)).changeSet.verification?.exactMatch)
      .toBe(true);
    expect(session.pageHead.code).toBe("<meta name=\"baseline\">");
    expect(session.writeCount).toBe(2);
  });
});
