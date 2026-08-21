import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdapterSessionFactory,
  BoundAdapterSession,
  DispatchReceipt,
  StandardRecordData,
  T123RecordData,
  ZeroRecordData,
  PageSettingsData,
} from "../../src/adapters/session.js";
import type { ElementTarget, ExactTarget, PageTarget, RecordTarget } from "../../src/core/contracts.js";
import { AdapterSessionCapabilityLearningProvider } from "../../src/learning/adapter-session-learning-provider.js";
import type {
  CapabilityLearningExecutionAuthority,
  LearnCapabilityRequest,
} from "../../src/learning/contracts.js";
import { FileCapabilityLearningExecutionJournal } from "../../src/learning/journal.js";
import { InMemoryCapabilityRecipeRegistry } from "../../src/learning/registry.js";
import { CapabilityLearningWorkflow } from "../../src/learning/workflow.js";

const receipt: DispatchReceipt = {
  operationId: "copy-test-operation",
  requestDispatched: true,
  acknowledgement: "acknowledged",
  publishObserved: false,
};

const standardTarget: RecordTarget = {
  kind: "record",
  projectId: "9101",
  pageId: "9201",
  recordId: "9301",
};
const t123Target: RecordTarget = {
  kind: "record",
  projectId: "9101",
  pageId: "9201",
  recordId: "9302",
};
const zeroTarget: ElementTarget = {
  kind: "element",
  projectId: "9101",
  pageId: "9201",
  recordId: "9305",
  elementId: "1780001",
};
const pageTarget: PageTarget = {
  kind: "page",
  projectId: "9101",
  pageId: "9201",
};

interface FakeState {
  standard: StandardRecordData;
  t123: T123RecordData;
  zero: ZeroRecordData;
  page: PageSettingsData;
}

class FakeAdapterSessionFactory implements AdapterSessionFactory {
  readonly writes: string[] = [];
  sessions = 0;
  #state: FakeState;

  constructor(state: FakeState) {
    this.#state = structuredClone(state);
  }

  snapshot(): FakeState {
    return structuredClone(this.#state);
  }

  async withSession<T>(action: (session: BoundAdapterSession) => Promise<T>): Promise<T> {
    this.sessions += 1;
    const session: BoundAdapterSession = {
      leaseId: `lease-${this.sessions}`,
      sessionId: `session-${this.sessions}`,
      readStandard: async (_target): Promise<StandardRecordData> => structuredClone(this.#state.standard),
      writeStandard: async (_target, field, value): Promise<DispatchReceipt> => {
        this.writes.push(`standard:${field}`);
        (this.#state.standard.record as Record<string, unknown>)[field] = value;
        return receipt;
      },
      readT123: async (_target): Promise<T123RecordData> => structuredClone(this.#state.t123),
      writeT123: async (_target, code): Promise<DispatchReceipt> => {
        this.writes.push("t123:code");
        (this.#state.t123 as { code: string }).code = code;
        return receipt;
      },
      readZero: async (_target): Promise<ZeroRecordData> => structuredClone(this.#state.zero),
      writeZero: async (_target, model): Promise<DispatchReceipt> => {
        this.writes.push("zero:model");
        (this.#state.zero as { model: unknown }).model = structuredClone(model);
        return receipt;
      },
      readPageSettings: async (_target): Promise<PageSettingsData> => structuredClone(this.#state.page),
      writePageSettings: async (_target, fields): Promise<DispatchReceipt> => {
        this.writes.push("page:settings");
        (this.#state.page as { fields: readonly (readonly [string, string])[] }).fields = structuredClone(fields);
        return receipt;
      },
      readPageHeadCode: async () => ({ code: "", changed: "", published: "0" }),
      writePageHeadCode: async () => receipt,
      readPublication: async () => ({ changed: "", published: "0", pageUrl: "", publicUrl: "" }),
      publish: async () => receipt,
      unpublish: async () => receipt,
    };
    return action(session);
  }
}

function state(): FakeState {
  return {
    standard: {
      record: { title: "Card title", unknown: { preserved: true } },
      recordType: "128",
      recordCode: "TL04",
    },
    t123: {
      record: { code: "<div>trusted test fixture</div>" },
      code: "<div>trusted test fixture</div>",
    },
    zero: {
      model: {
        groups: [],
        meta: { source: "fixture" },
        timestamp: 1,
        "0": { elem_id: "1780001", type: "text", text: "Zero text", link: "/" },
      },
    },
    page: {
      fields: [["title", "Fixture"], ["meta_descr", "Original description"], ["unknown", "preserve"]],
      changed: "revision-before",
      published: "0",
    },
  };
}

function request(
  target: ExactTarget,
  capability: LearnCapabilityRequest["capability"],
  family: LearnCapabilityRequest["family"],
  targetRole: "copy" | "test-object" = "test-object",
  action: "edit" | "configure" = "edit",
): LearnCapabilityRequest {
  return {
    mode: "copy-test",
    target,
    targetRole,
    capability,
    family,
    action,
    dryRun: false,
    idempotencyKey: "learning-adapter-session-1",
  };
}

async function learn(factory: FakeAdapterSessionFactory, input: LearnCapabilityRequest) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "tilda-learning-adapter-"));
  const authority: CapabilityLearningExecutionAuthority = {
    receipt: () => ({
      taskId: "123e4567-e89b-42d3-a456-426614174000",
      grantHash: `sha256:${"f".repeat(64)}`,
    }),
    assertCopyTestWrite: () => undefined,
    beginTaskExecution: () => ({ kind: "task-execution-lease", release: () => undefined }),
  };
  try {
    const workflow = new CapabilityLearningWorkflow({
      provider: new AdapterSessionCapabilityLearningProvider({ sessions: factory }),
      registry: new InMemoryCapabilityRecipeRegistry(),
      journal: new FileCapabilityLearningExecutionJournal(join(runtimeRoot, "executions"), runtimeRoot),
      now: () => "2026-08-20T00:00:00.000Z",
      createRecipeId: () => "recipe-adapter-session-1",
    });
    return await workflow.learn(input, authority);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

describe("bounded adapter-session capability learning", () => {
  it("learns a standard title patch and restores it with four one-shot mutations", async () => {
    const factory = new FakeAdapterSessionFactory(state());
    const before = factory.snapshot();
    const result = await learn(factory, request(standardTarget, "standard.field.patch", "standard", "copy"));

    expect(result).toMatchObject({ ok: true, code: "LEARNING_REGISTERED", stateChanged: false });
    expect(result.recipe?.changedPaths).toEqual(["record.title"]);
    expect(factory.writes).toHaveLength(4);
    expect(factory.sessions).toBe(13);
    expect(factory.snapshot()).toEqual(before);
    expect(JSON.stringify(result.recipe)).not.toContain("Card title");
    expect(JSON.stringify(result.recipe)).not.toContain("copy_test");
  });

  it("learns T123 through one inert comment and never persists its code in evidence", async () => {
    const factory = new FakeAdapterSessionFactory(state());
    const before = factory.snapshot();
    const result = await learn(factory, request(t123Target, "t123.code.replace", "t123"));

    expect(result).toMatchObject({ ok: true, code: "LEARNING_REGISTERED", stateChanged: false });
    expect(result.recipe?.changedPaths).toEqual(["record.code"]);
    expect(factory.writes).toHaveLength(4);
    expect(factory.snapshot()).toEqual(before);
    expect(JSON.stringify(result.recipe)).not.toContain("trusted test fixture");
    expect(JSON.stringify(result.recipe)).not.toContain("tilda-copy-test");
  });

  it("learns one existing Zero primitive property and restores the exact model", async () => {
    const factory = new FakeAdapterSessionFactory(state());
    const before = factory.snapshot();
    const result = await learn(factory, request(zeroTarget, "zero.property.patch", "zero"));

    expect(result).toMatchObject({ ok: true, code: "LEARNING_REGISTERED", stateChanged: false });
    expect(result.recipe?.changedPaths).toEqual(["1780001.text"]);
    expect(result.recipe?.transport).toBe("editor_runtime");
    expect(factory.writes).toHaveLength(4);
    expect(factory.snapshot()).toEqual(before);
  });

  it("learns only page meta_descr for SEO and rejects unsupported family/action pairs", async () => {
    const factory = new FakeAdapterSessionFactory(state());
    const before = factory.snapshot();
    const result = await learn(factory, request(pageTarget, "page.seo.patch", "page", "test-object", "configure"));

    expect(result).toMatchObject({ ok: true, code: "LEARNING_REGISTERED", stateChanged: false });
    expect(result.recipe?.changedPaths).toEqual(["page.meta_descr"]);
    expect(factory.writes).toHaveLength(4);
    expect(factory.snapshot()).toEqual(before);

    const unsupported = new AdapterSessionCapabilityLearningProvider({ sessions: factory });
    await expect(unsupported.open(request(pageTarget, "page.seo.patch", "standard"))).rejects.toMatchObject({
      code: "LEARNING_CAPABILITY_UNSUPPORTED",
    });
    await expect(unsupported.open({
      ...request(pageTarget, "page.seo.patch", "page"),
      action: "clone",
    })).rejects.toMatchObject({ code: "LEARNING_ACTION_UNSUPPORTED" });
  });
});
