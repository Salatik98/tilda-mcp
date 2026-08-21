import { createHash } from "node:crypto";
import type {
  T123CodeEditRequest,
  T123LiteralReplacement,
} from "../core/contracts.js";

export type { T123CodeEditRequest, T123LiteralReplacement } from "../core/contracts.js";

export const MAX_T123_CODE_BYTES = 5_000_000;
export const MAX_T123_LITERAL_RULES = 128;
export const MAX_T123_LITERAL_MATCHES = 2_048;
export const MAX_T123_DEPENDENCIES = 128;
export const MAX_T123_DEPENDENCY_URL_BYTES = 2_048;

export type T123CodeHelperErrorCode =
  | "INVALID_INPUT"
  | "LIMIT_EXCEEDED"
  | "MATCH_COUNT_MISMATCH"
  | "OVERLAPPING_REPLACEMENTS"
  | "NO_CHANGE"
  | "STRUCTURAL_DAMAGE";

export class T123CodeHelperError extends Error {
  constructor(readonly code: T123CodeHelperErrorCode, message: string) {
    super(message);
    this.name = "T123CodeHelperError";
  }
}

export type T123StructureIssueCode =
  | "NUL_CHARACTER"
  | "STRAY_HTML_COMMENT_CLOSE"
  | "UNCLOSED_HTML_COMMENT"
  | "UNCLOSED_TAG_DECLARATION"
  | "SCRIPT_TAG_UNBALANCED"
  | "STYLE_TAG_UNBALANCED";

export interface T123StructureIssue {
  readonly code: T123StructureIssueCode;
  readonly offset: number;
}

export interface T123ExternalDependency {
  readonly url: string;
  readonly kind: "script" | "stylesheet" | "media" | "frame" | "css-url";
  readonly offset: number;
}

export interface T123ReplacementSpan {
  /** UTF-16 offsets into the exact original JavaScript string. */
  readonly start: number;
  readonly end: number;
  readonly replacementLength: number;
}

export interface T123CodeEditPlan {
  readonly kind: T123CodeEditRequest["kind"];
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly replacementCount: number;
  readonly spans: readonly T123ReplacementSpan[];
  /** Exact planned text. The helper never persists or transmits it. */
  readonly code: string;
  readonly structureIssues: readonly [];
  readonly externalDependencies: readonly T123ExternalDependency[];
}

interface InternalSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertBoundedText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new T123CodeHelperError("INVALID_INPUT", `${field} must be a string.`);
  }
  if (bytes(value) > MAX_T123_CODE_BYTES) {
    throw new T123CodeHelperError(
      "LIMIT_EXCEEDED",
      `${field} exceeds the ${MAX_T123_CODE_BYTES}-byte limit.`,
    );
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function asciiLower(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[index];
  }
  return result;
}

function isSpace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n" || value === "\f";
}

function isNameCharacter(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "-" ||
    value === "_" ||
    value === ":"
  );
}

function findTagEnd(code: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function trackedTagIssues(code: string, tagName: "script" | "style"): T123StructureIssue[] {
  const lower = asciiLower(code);
  const opening = `<${tagName}`;
  const closing = `</${tagName}`;
  const stack: number[] = [];
  const issues: T123StructureIssue[] = [];
  let cursor = 0;
  while (cursor < lower.length) {
    const openAt = lower.indexOf(opening, cursor);
    const closeAt = lower.indexOf(closing, cursor);
    const candidates = [openAt, closeAt].filter((offset) => offset >= 0);
    if (candidates.length === 0) break;
    const offset = Math.min(...candidates);
    const isClosing = offset === closeAt;
    const tokenLength = isClosing ? closing.length : opening.length;
    const boundary = lower[offset + tokenLength];
    if (!(boundary === ">" || boundary === "/" || isSpace(boundary))) {
      cursor = offset + tokenLength;
      continue;
    }
    const end = findTagEnd(code, offset + tokenLength);
    if (end < 0) {
      issues.push({ code: "UNCLOSED_TAG_DECLARATION", offset });
      break;
    }
    if (isClosing) {
      if (stack.length === 0) {
        issues.push({
          code: tagName === "script" ? "SCRIPT_TAG_UNBALANCED" : "STYLE_TAG_UNBALANCED",
          offset,
        });
      } else {
        stack.pop();
      }
    } else {
      let beforeEnd = end - 1;
      while (beforeEnd > offset && isSpace(code[beforeEnd])) beforeEnd -= 1;
      if (code[beforeEnd] !== "/") stack.push(offset);
    }
    cursor = end + 1;
  }
  for (const offset of stack) {
    issues.push({
      code: tagName === "script" ? "SCRIPT_TAG_UNBALANCED" : "STYLE_TAG_UNBALANCED",
      offset,
    });
  }
  return issues;
}

export function inspectT123Structure(value: string): readonly T123StructureIssue[] {
  const code = assertBoundedText(value, "T123 code");
  const issues: T123StructureIssue[] = [];
  const nul = code.indexOf("\0");
  if (nul >= 0) issues.push({ code: "NUL_CHARACTER", offset: nul });
  let cursor = 0;
  while (cursor < code.length) {
    const open = code.indexOf("<!--", cursor);
    const close = code.indexOf("-->", cursor);
    if (close >= 0 && (open < 0 || close < open)) {
      issues.push({ code: "STRAY_HTML_COMMENT_CLOSE", offset: close });
      cursor = close + 3;
      continue;
    }
    if (open < 0) break;
    const matchingClose = code.indexOf("-->", open + 4);
    if (matchingClose < 0) {
      issues.push({ code: "UNCLOSED_HTML_COMMENT", offset: open });
      break;
    }
    cursor = matchingClose + 3;
  }
  issues.push(...trackedTagIssues(code, "script"), ...trackedTagIssues(code, "style"));
  return Object.freeze(
    issues
      .sort((left, right) => left.offset - right.offset || left.code.localeCompare(right.code))
      .map((issue) => Object.freeze(issue)),
  );
}

function assertSafeStructure(code: string): void {
  const issues = inspectT123Structure(code);
  if (issues.length > 0) {
    throw new T123CodeHelperError(
      "STRUCTURAL_DAMAGE",
      `Planned T123 code has an obvious structural issue: ${issues[0]!.code}.`,
    );
  }
}

function exactMatches(code: string, match: string): number[] {
  if (match.length === 0) {
    throw new T123CodeHelperError("INVALID_INPUT", "Literal match must not be empty.");
  }
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= code.length - match.length) {
    const offset = code.indexOf(match, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    if (offsets.length > MAX_T123_LITERAL_MATCHES) {
      throw new T123CodeHelperError(
        "LIMIT_EXCEEDED",
        `Literal matches exceed the ${MAX_T123_LITERAL_MATCHES}-match limit.`,
      );
    }
    cursor = offset + match.length;
  }
  return offsets;
}

function literalSpans(
  code: string,
  rules: readonly T123LiteralReplacement[],
): readonly InternalSpan[] {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_T123_LITERAL_RULES) {
    throw new T123CodeHelperError(
      "LIMIT_EXCEEDED",
      `Literal replacements must contain 1-${MAX_T123_LITERAL_RULES} rules.`,
    );
  }
  const seenMatches = new Set<string>();
  const spans: InternalSpan[] = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw new T123CodeHelperError("INVALID_INPUT", "Each literal replacement must be an object.");
    }
    const match = assertBoundedText(rule.match, "Literal match");
    const replacement = assertBoundedText(rule.replacement, "Literal replacement");
    if (
      !Number.isSafeInteger(rule.expectedMatches) ||
      rule.expectedMatches < 1 ||
      rule.expectedMatches > MAX_T123_LITERAL_MATCHES
    ) {
      throw new T123CodeHelperError(
        "INVALID_INPUT",
        `expectedMatches must be 1-${MAX_T123_LITERAL_MATCHES}.`,
      );
    }
    if (seenMatches.has(match)) {
      throw new T123CodeHelperError("INVALID_INPUT", "Literal match rules must be unique.");
    }
    seenMatches.add(match);
    const offsets = exactMatches(code, match);
    if (offsets.length !== rule.expectedMatches) {
      throw new T123CodeHelperError(
        "MATCH_COUNT_MISMATCH",
        `Literal match count is ${offsets.length}; expected ${rule.expectedMatches}.`,
      );
    }
    for (const start of offsets) {
      spans.push({ start, end: start + match.length, replacement });
    }
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index]!.start < spans[index - 1]!.end) {
      throw new T123CodeHelperError(
        "OVERLAPPING_REPLACEMENTS",
        "Literal replacement spans overlap in the original text.",
      );
    }
  }
  return spans;
}

function applySpans(code: string, spans: readonly InternalSpan[]): string {
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    output += code.slice(cursor, span.start);
    output += span.replacement;
    cursor = span.end;
  }
  output += code.slice(cursor);
  return output;
}

function dependencyKind(tag: string, attribute: string): T123ExternalDependency["kind"] | null {
  if (tag === "script" && attribute === "src") return "script";
  if (tag === "link" && attribute === "href") return "stylesheet";
  if (["img", "source", "audio"].includes(tag) && attribute === "src") return "media";
  if (tag === "video" && (attribute === "src" || attribute === "poster")) return "media";
  if (tag === "object" && attribute === "data") return "media";
  if (tag === "iframe" && attribute === "src") return "frame";
  return null;
}

function isExternalHttpUrl(value: string): boolean {
  if (
    !(value.startsWith("https://") || value.startsWith("http://") || value.startsWith("//")) ||
    bytes(value) > MAX_T123_DEPENDENCY_URL_BYTES
  ) return false;
  try {
    const parsed = new URL(value, "https://tilda.invalid/");
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function pushDependency(
  dependencies: T123ExternalDependency[],
  seen: Set<string>,
  candidate: T123ExternalDependency,
): void {
  if (!isExternalHttpUrl(candidate.url) || seen.has(candidate.url)) return;
  if (dependencies.length >= MAX_T123_DEPENDENCIES) {
    throw new T123CodeHelperError(
      "LIMIT_EXCEEDED",
      `External dependencies exceed the ${MAX_T123_DEPENDENCIES}-URL limit.`,
    );
  }
  seen.add(candidate.url);
  dependencies.push(Object.freeze(candidate));
}

function htmlDependencies(code: string, output: T123ExternalDependency[], seen: Set<string>): void {
  const lower = asciiLower(code);
  let cursor = 0;
  while (cursor < code.length) {
    const open = code.indexOf("<", cursor);
    if (open < 0) break;
    if (code.startsWith("<!--", open)) {
      const commentEnd = code.indexOf("-->", open + 4);
      cursor = commentEnd < 0 ? code.length : commentEnd + 3;
      continue;
    }
    let index = open + 1;
    if (code[index] === "/" || code[index] === "!" || code[index] === "?") {
      cursor = open + 1;
      continue;
    }
    const nameStart = index;
    while (isNameCharacter(code[index])) index += 1;
    if (index === nameStart) {
      cursor = open + 1;
      continue;
    }
    const tag = lower.slice(nameStart, index);
    const end = findTagEnd(code, index);
    if (end < 0) break;
    while (index < end) {
      while (index < end && (isSpace(code[index]) || code[index] === "/")) index += 1;
      const attributeStart = index;
      while (index < end && isNameCharacter(code[index])) index += 1;
      if (index === attributeStart) {
        index += 1;
        continue;
      }
      const attribute = lower.slice(attributeStart, index);
      while (index < end && isSpace(code[index])) index += 1;
      if (code[index] !== "=") continue;
      index += 1;
      while (index < end && isSpace(code[index])) index += 1;
      const quote = code[index] === "\"" || code[index] === "'" ? code[index] : null;
      if (quote !== null) index += 1;
      const valueStart = index;
      if (quote === null) {
        while (index < end && !isSpace(code[index]) && code[index] !== ">") index += 1;
      } else {
        while (index < end && code[index] !== quote) index += 1;
      }
      const value = code.slice(valueStart, index);
      if (quote !== null && code[index] === quote) index += 1;
      const kind = dependencyKind(tag, attribute);
      if (kind !== null) pushDependency(output, seen, { url: value, kind, offset: valueStart });
    }
    cursor = end + 1;
  }
}

function cssDependencies(code: string, output: T123ExternalDependency[], seen: Set<string>): void {
  const lower = asciiLower(code);
  let cursor = 0;
  while (cursor < code.length) {
    const start = lower.indexOf("url(", cursor);
    if (start < 0) break;
    let index = start + 4;
    while (isSpace(code[index])) index += 1;
    const quote = code[index] === "\"" || code[index] === "'" ? code[index] : null;
    if (quote !== null) index += 1;
    const valueStart = index;
    if (quote === null) {
      while (index < code.length && code[index] !== ")" && !isSpace(code[index])) index += 1;
    } else {
      while (index < code.length && code[index] !== quote) index += 1;
    }
    const value = code.slice(valueStart, index);
    if (!value.includes("\\")) {
      pushDependency(output, seen, { url: value, kind: "css-url", offset: valueStart });
    }
    const close = code.indexOf(")", index);
    cursor = close < 0 ? index + 1 : close + 1;
  }
}

export function extractT123ExternalDependencies(
  value: string,
): readonly T123ExternalDependency[] {
  const code = assertBoundedText(value, "T123 code");
  const dependencies: T123ExternalDependency[] = [];
  const seen = new Set<string>();
  htmlDependencies(code, dependencies, seen);
  cssDependencies(code, dependencies, seen);
  return Object.freeze(
    dependencies
      .sort((left, right) => left.offset - right.offset || left.url.localeCompare(right.url)),
  );
}

function plan(
  currentValue: string,
  kind: T123CodeEditRequest["kind"],
  code: string,
  spans: readonly InternalSpan[],
): T123CodeEditPlan {
  const current = assertBoundedText(currentValue, "Current T123 code");
  const intended = assertBoundedText(code, "Planned T123 code");
  if (current === intended) {
    throw new T123CodeHelperError("NO_CHANGE", "T123 edit must change the exact current text.");
  }
  assertSafeStructure(intended);
  return Object.freeze({
    kind,
    beforeHash: sha256(current),
    afterHash: sha256(intended),
    beforeBytes: bytes(current),
    afterBytes: bytes(intended),
    replacementCount: spans.length,
    spans: Object.freeze(spans.map((span) => Object.freeze({
      start: span.start,
      end: span.end,
      replacementLength: span.replacement.length,
    }))),
    code: intended,
    structureIssues: Object.freeze([]) as readonly [],
    externalDependencies: extractT123ExternalDependencies(intended),
  });
}

export function planT123FullReplace(current: string, code: string): T123CodeEditPlan {
  return plan(current, "full_replace", code, [{
    start: 0,
    end: assertBoundedText(current, "Current T123 code").length,
    replacement: code,
  }]);
}

export function planT123SingleLiteralReplace(
  currentValue: string,
  matchValue: string,
  replacementValue: string,
): T123CodeEditPlan {
  const current = assertBoundedText(currentValue, "Current T123 code");
  const rules = [{
    match: matchValue,
    replacement: replacementValue,
    expectedMatches: 1,
  }] as const;
  const spans = literalSpans(current, rules);
  return plan(current, "replace_once", applySpans(current, spans), spans);
}

export function planT123BulkLiteralReplacements(
  currentValue: string,
  replacements: readonly T123LiteralReplacement[],
): T123CodeEditPlan {
  const current = assertBoundedText(currentValue, "Current T123 code");
  const spans = literalSpans(current, replacements);
  return plan(current, "replace_literals", applySpans(current, spans), spans);
}

export function planT123CodeEdit(
  current: string,
  request: T123CodeEditRequest,
): T123CodeEditPlan {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new T123CodeHelperError("INVALID_INPUT", "T123 edit request must be an object.");
  }
  if (request.kind === "full_replace") return planT123FullReplace(current, request.code);
  if (request.kind === "replace_once") {
    return planT123SingleLiteralReplace(current, request.match, request.replacement);
  }
  if (request.kind === "replace_literals") {
    return planT123BulkLiteralReplacements(current, request.replacements);
  }
  throw new T123CodeHelperError("INVALID_INPUT", "T123 edit request kind is unsupported.");
}
