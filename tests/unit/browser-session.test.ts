import { describe, expect, it } from "vitest";

import {
  rebaseZeroRuntimeTimestamp,
  zeroRuntimeModelsEqualExceptTimestamp,
} from "../../src/research/browser-session.js";

describe("Zero runtime write timestamp policy", () => {
  it("rebases only the service timestamp and preserves the caller model", () => {
    const current = {
      timestamp: 2,
      groups: { preserve: true },
      meta: { preserve: true },
    };
    const intended = {
      timestamp: 1,
      groups: { preserve: true },
      meta: { preserve: true },
      unknownMetadata: { preserve: true },
      "0": { elem_id: "1001", type: "text", link: "changed" },
    };

    const rebound = rebaseZeroRuntimeTimestamp(current, intended);

    expect(rebound).toEqual({ ...intended, timestamp: 2 });
    expect(rebound).not.toBe(intended);
    expect(intended.timestamp).toBe(1);
    expect(rebound.unknownMetadata).toEqual(intended.unknownMetadata);
  });

  it("preserves a null-prototype clean model while rebasing timestamp", () => {
    const current = { timestamp: 9 };
    const intended = Object.assign(Object.create(null), {
      timestamp: 1,
      groups: {},
      meta: {},
      "0": { elem_id: "1001", type: "text", link: "changed" },
    }) as Record<string, unknown>;

    const rebound = rebaseZeroRuntimeTimestamp(current, intended);

    expect(Object.getPrototypeOf(rebound)).toBeNull();
    expect(rebound.timestamp).toBe(9);
    expect(rebound.groups).toEqual({});
    expect(rebound["0"]).toEqual(intended["0"]);
  });

  it("accepts only timestamp drift between sequential inner reads", () => {
    const first = {
      timestamp: 1,
      groups: { preserve: true },
      meta: { preserve: true },
      unknownMetadata: { preserve: true },
      "0": { elem_id: "1001", type: "text", link: "" },
    };
    const latest = { ...first, timestamp: 2 };
    expect(zeroRuntimeModelsEqualExceptTimestamp(first, latest)).toBe(true);
    expect(
      zeroRuntimeModelsEqualExceptTimestamp(
        first,
        { ...latest, unknownMetadata: { preserve: false } },
      ),
    ).toBe(false);
  });

  it("compares null-prototype models without widening the allowed drift", () => {
    const first = Object.assign(Object.create(null), {
      timestamp: 1,
      groups: {},
      meta: {},
      "0": { elem_id: "1001", type: "text", link: "" },
    }) as Record<string, unknown>;
    const latest = Object.assign(Object.create(null), {
      timestamp: 2,
      groups: {},
      meta: {},
      "0": { elem_id: "1001", type: "text", link: "" },
    }) as Record<string, unknown>;

    expect(zeroRuntimeModelsEqualExceptTimestamp(first, latest)).toBe(true);
    latest.meta = { drifted: true };
    expect(zeroRuntimeModelsEqualExceptTimestamp(first, latest)).toBe(false);
  });
});
