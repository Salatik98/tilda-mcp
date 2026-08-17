import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CdpEvent } from "../../src/research/cdp-client.js";
import {
  Observatory,
  SanitizedTraceStore,
  TraceStateError,
  type TraceEventSource,
} from "../../src/research/observatory.js";
import { SanitizationError } from "../../src/research/security/index.js";

class FakeSource implements TraceEventSource {
  snapshotValue: Record<string, unknown> = { records: [{ id: "1", type: "396" }] };
  readonly listeners = new Set<(event: CdpEvent) => void>();

  snapshot(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.snapshotValue));
  }

  subscribe(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CdpEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; source: FakeSource; observatory: Observatory }> {
  const root = await mkdtemp(join(tmpdir(), "tilda-observatory-"));
  temporaryRoots.push(root);
  const source = new FakeSource();
  return {
    root,
    source,
    observatory: new Observatory(source, new SanitizedTraceStore(root)),
  };
}

describe("Observatory", () => {
  it("persists only projected, sanitized metadata with before/after hashes", async () => {
    const { root, source, observatory } = await setup();
    const started = await observatory.startTrace({
      purpose: "observe one read-only navigation",
      target: { projectId: "123", pageId: "456" },
      redactionProfile: "strict",
    });

    source.emit({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "req-1",
        type: "XHR",
        request: {
          url: "https://tilda.ru/page/edit/?pageid=456&token=top-secret",
          method: "POST",
          hasPostData: true,
          postData: "password=never-persist",
          headers: { Cookie: "never-persist" },
        },
      },
    });
    source.snapshotValue = { records: [{ id: "1", type: "396" }, { id: "2", type: "131" }] };

    const stopped = await observatory.stopTrace(started.traceId);
    const raw = await readFile(stopped.artifactPath, "utf8");
    expect(raw).not.toContain("top-secret");
    expect(raw).not.toContain("never-persist");
    expect(raw).not.toContain("postData");
    expect(raw).not.toContain("headers");
    expect(raw).toContain("REDACTED");
    expect(stopped.changed).toBe(true);
    expect(await readdir(root)).toEqual([`${started.traceId}.json`]);
  });

  it("rejects concurrent traces and mismatched handles", async () => {
    const { observatory } = await setup();
    const first = await observatory.startTrace({
      purpose: "single semantic action",
      target: { projectId: "123" },
      redactionProfile: "strict",
    });

    await expect(
      observatory.startTrace({
        purpose: "another action",
        target: { projectId: "123" },
        redactionProfile: "strict",
      }),
    ).rejects.toMatchObject({ code: "TRACE_ALREADY_ACTIVE" });
    await expect(observatory.stopTrace("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      TraceStateError,
    );
    await observatory.stopTrace(first.traceId);
  });

  it("fails closed and leaves no artifact when sanitization fails", async () => {
    const { root, source, observatory } = await setup();
    const started = await observatory.startTrace({
      purpose: "adversarial sanitizer test",
      target: { projectId: "123" },
      redactionProfile: "strict",
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    source.snapshotValue = cyclic;

    await expect(observatory.stopTrace(started.traceId)).rejects.toBeInstanceOf(SanitizationError);
    expect(await readdir(root)).toEqual([]);
  });
});
