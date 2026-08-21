import { describe, expect, it } from "vitest";

import {
  extractT123ExternalDependencies,
  inspectT123Structure,
  planT123BulkLiteralReplacements,
  planT123CodeEdit,
  planT123FullReplace,
  planT123SingleLiteralReplace,
} from "../../src/adapters/t123-code-helper.js";

describe("bounded T123 code helper", () => {
  it("plans a full exact replacement without rewriting its text", () => {
    const before = "<div>before</div>\r\n<script>const x = 1;</script>";
    const after = "<div>после</div>\r\n<script>const x = 2;</script>";
    const plan = planT123FullReplace(before, after);
    expect(plan.code).toBe(after);
    expect(plan.beforeHash).not.toBe(plan.afterHash);
    expect(plan.spans).toEqual([{ start: 0, end: before.length, replacementLength: after.length }]);
  });

  it("requires exactly one literal match and preserves every code unit outside that span", () => {
    const before = "A\r\nconst label = 'old';\r\nB";
    const plan = planT123SingleLiteralReplace(before, "'old'", "'новый'");
    expect(plan.code).toBe("A\r\nconst label = 'новый';\r\nB");
    expect(plan.code.slice(0, plan.spans[0]!.start)).toBe(before.slice(0, plan.spans[0]!.start));
    expect(plan.code.endsWith(";\r\nB")).toBe(true);
    expect(() => planT123SingleLiteralReplace("old old", "old", "new"))
      .toThrow(expect.objectContaining({ code: "MATCH_COUNT_MISMATCH" }));
  });

  it("applies bounded bulk literals simultaneously and rejects overlapping spans", () => {
    const before = "alpha beta alpha";
    const plan = planT123BulkLiteralReplacements(before, [
      { match: "alpha", replacement: "A", expectedMatches: 2 },
      { match: "beta", replacement: "B", expectedMatches: 1 },
    ]);
    expect(plan.code).toBe("A B A");
    expect(plan.replacementCount).toBe(3);
    expect(() => planT123BulkLiteralReplacements("abcdef", [
      { match: "abc", replacement: "x", expectedMatches: 1 },
      { match: "bc", replacement: "y", expectedMatches: 1 },
    ])).toThrow(expect.objectContaining({ code: "OVERLAPPING_REPLACEMENTS" }));
  });

  it("rejects obvious structural damage conservatively", () => {
    expect(inspectT123Structure("<script>ok()</script><style>.x{}</style>")).toEqual([]);
    expect(inspectT123Structure("<!-- open")).toContainEqual(
      expect.objectContaining({ code: "UNCLOSED_HTML_COMMENT" }),
    );
    expect(() => planT123SingleLiteralReplace(
      "<script>ok()</script>",
      "</script>",
      "",
    )).toThrow(expect.objectContaining({ code: "STRUCTURAL_DAMAGE" }));
  });

  it("extracts bounded external dependencies without normalizing or fetching them", () => {
    const code = [
      '<script src="https://cdn.example.test/app.js"></script>',
      '<link href="//cdn.example.test/site.css" rel="stylesheet">',
      '<img src="/local.png">',
      '<style>.x{background:url(\'https://img.example.test/a.png?x=1\')}</style>',
    ].join("\n");
    expect(extractT123ExternalDependencies(code)).toEqual([
      expect.objectContaining({ url: "https://cdn.example.test/app.js", kind: "script" }),
      expect.objectContaining({ url: "//cdn.example.test/site.css", kind: "stylesheet" }),
      expect.objectContaining({ url: "https://img.example.test/a.png?x=1", kind: "css-url" }),
    ]);
  });

  it("exposes one typed planner seam and rejects no-op requests", () => {
    expect(planT123CodeEdit("one", {
      kind: "replace_once",
      match: "one",
      replacement: "two",
    }).code).toBe("two");
    expect(() => planT123CodeEdit("same", { kind: "full_replace", code: "same" }))
      .toThrow(expect.objectContaining({ code: "NO_CHANGE" }));
  });
});
