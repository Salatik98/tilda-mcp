import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "../../src/research/hash.js";

describe("canonical hashing", () => {
  it("is independent of object key order and preserves array order", () => {
    const left = { z: 1, nested: { b: 2, a: 3 }, array: [2, 1] };
    const right = { array: [2, 1], nested: { a: 3, b: 2 }, z: 1 };
    const different = { array: [1, 2], nested: { a: 3, b: 2 }, z: 1 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalHash(left)).toBe(canonicalHash(right));
    expect(canonicalHash(left)).not.toBe(canonicalHash(different));
  });
});
