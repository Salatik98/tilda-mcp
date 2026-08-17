import { createHash } from "node:crypto";

const URL_SECRET_MARKERS = [
  "secretkey",
  "publickey",
  "apikey",
  "password",
  "session",
  "secret",
  "token",
  "csrf",
  "cookie",
  "xsrf",
] as const;

const BODY_PII_MARKERS = ["email", "phone", "name", "fio", "message"] as const;

const OPAQUE_BODY_KEYS = new Set([
  "body",
  "formdata",
  "payload",
  "postdata",
  "requestbody",
  "responsebody",
]);

const ENCODED_BODY_KEYS = new Set(["postdataentries"]);

const RAW_HEADER_KEYS = new Set([
  "headerstext",
  "requestheaderstext",
  "responseheaderstext",
]);

const AUTH_KEYS = new Set([
  "auth",
  "authentication",
  "authorization",
  "oauth",
]);

/**
 * A sanitizer error is deliberately generic: upstream code may log the error,
 * so neither the input value nor an attacker-controlled property name is
 * included in the message or on the error object.
 */
export class SanitizationError extends Error {
  readonly code = "SANITIZATION_FAILED" as const;

  constructor() {
    super("Sanitization failed; persistence must be aborted.");
    this.name = "SanitizationError";
  }
}

function failClosed(): never {
  throw new SanitizationError();
}

function guard<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof SanitizationError) {
      throw error;
    }
    return failClosed();
  }
}

function normalizedKey(key: string): string {
  let decoded = key;
  for (let pass = 0; pass < 8 && /%[a-f0-9]{2}/iu.test(decoded); pass += 1) {
    decoded = decodeURIComponent(decoded);
  }
  if (/%[a-f0-9]{2}/iu.test(decoded)) {
    return failClosed();
  }
  return decoded.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);

  if (AUTH_KEYS.has(normalized)) {
    return true;
  }

  if (
    normalized.startsWith("auth") &&
    /(?:code|id|key|session|token)$/u.test(normalized)
  ) {
    return true;
  }

  return URL_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

function isBodySensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    isSecretKey(key) ||
    BODY_PII_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = normalizedKey(name);
  return (
    normalized === "cookie" ||
    normalized === "cookie2" ||
    normalized === "setcookie" ||
    normalized.endsWith("authorization") ||
    isSecretKey(name)
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function ownEnumerableEntries(value: object): Array<[string, unknown]> {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return failClosed();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, unknown]> = [];

  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true) {
      continue;
    }
    if (!("value" in descriptor)) {
      return failClosed();
    }
    entries.push([key, descriptor.value]);
  }

  return entries;
}

function denseArrayValues(value: ReadonlyArray<unknown>): unknown[] {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return failClosed();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const propertyNames = Object.keys(descriptors);
  if (
    propertyNames.length !== value.length + 1 ||
    descriptors.length === undefined
  ) {
    return failClosed();
  }

  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return failClosed();
    }
    output.push(descriptor.value);
  }
  return output;
}

function defineSafeProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function withCycleGuard<T>(
  value: object,
  ancestors: WeakSet<object>,
  operation: () => T,
): T {
  if (ancestors.has(value)) {
    return failClosed();
  }

  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeSecret(
  value: unknown,
  ancestors: WeakSet<object>,
): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return failClosed();
    }
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "bigint") {
    return `${String(value)}n`;
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value !== "object"
  ) {
    return failClosed();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return failClosed();
    }
    return value.toISOString();
  }
  if (value instanceof URL) {
    return value.toString();
  }

  return withCycleGuard(value, ancestors, () => {
    if (Array.isArray(value)) {
      return `[${denseArrayValues(value)
        .map((item) => canonicalizeSecret(item, ancestors))
        .join(",")}]`;
    }
    if (!isPlainObject(value)) {
      return failClosed();
    }

    const entries = ownEnumerableEntries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalizeSecret(item, ancestors)}`,
      )
      .join(",")}}`;
  });
}

/** Return a stable, non-reversible marker without retaining the source value. */
export function redactValue(value: unknown): string {
  return guard(() => {
    const canonical = canonicalizeSecret(value, new WeakSet<object>());
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    const length = Buffer.byteLength(canonical, "utf8");
    return `[REDACTED:sha256_8=${digest.slice(0, 8)}:length=${length}]`;
  });
}

type ParsedUrl = {
  readonly original: string;
  readonly url: URL;
  readonly render: (url: URL) => string;
};

function parseUrl(input: string): ParsedUrl {
  const absolutePattern = /^[a-z][a-z0-9+.-]*:\/\//iu;

  if (absolutePattern.test(input)) {
    return {
      original: input,
      url: new URL(input),
      render: (url) => url.toString(),
    };
  }

  if (input.startsWith("//")) {
    return {
      original: input,
      url: new URL(`https:${input}`),
      render: (url) => url.toString().slice("https:".length),
    };
  }

  const base = "https://sanitizer.invalid/";
  const parsed = new URL(input, base);
  if (parsed.origin !== "https://sanitizer.invalid") {
    return failClosed();
  }

  if (input.startsWith("?")) {
    return {
      original: input,
      url: parsed,
      render: (url) => `${url.search}${url.hash}`,
    };
  }

  if (input.startsWith("#")) {
    return {
      original: input,
      url: parsed,
      render: (url) => url.hash,
    };
  }

  const startsWithSlash = input.startsWith("/");
  return {
    original: input,
    url: parsed,
    render: (url) => {
      const rendered = `${url.pathname}${url.search}${url.hash}`;
      return startsWithSlash ? rendered : rendered.replace(/^\//u, "");
    },
  };
}

function sanitizeUrlInternal(input: string): string {
  const parsed = parseUrl(input);
  let changed = false;

  // WHATWG treats a semicolon as query data rather than a separator. Legacy
  // servers sometimes do the opposite, so persisting such a URL is ambiguous.
  if (
    parsed.url.search.includes(";") ||
    decodeURIComponent(parsed.url.search).includes(";")
  ) {
    return failClosed();
  }

  if (
    parsed.url.hostname.toLowerCase().replace(/\.+$/u, "") ===
    "api.tildacdn.info"
  ) {
    if (parsed.url.search.length > 0) {
      parsed.url.search = "";
      changed = true;
    }
  } else {
    const nextQuery = new URLSearchParams();
    for (const [key, value] of parsed.url.searchParams.entries()) {
      if (isSecretKey(key)) {
        nextQuery.append(key, redactValue(value));
        changed = true;
      } else {
        nextQuery.append(key, value);
      }
    }

    if (changed) {
      parsed.url.search = nextQuery.toString();
    }
  }

  if (parsed.url.username.length > 0 || parsed.url.password.length > 0) {
    if (parsed.url.username.length > 0) {
      parsed.url.username = redactValue(decodeURIComponent(parsed.url.username));
    }
    if (parsed.url.password.length > 0) {
      parsed.url.password = redactValue(decodeURIComponent(parsed.url.password));
    }
    changed = true;
  }

  return changed ? parsed.render(parsed.url) : parsed.original;
}

/** Redact credentials in a URL and remove every query from Tilda's API host. */
export function sanitizeUrl(input: string): string {
  return guard(() => sanitizeUrlInternal(input));
}

function looksLikeUrl(value: string): boolean {
  return (
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(value) ||
    /^(?:\.{0,2}\/|\?)[^\s]*$/u.test(value) ||
    /^[^\s?#]+\?[^\s#]*$/u.test(value)
  );
}

function cloneGenericValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "undefined"
  ) {
    return typeof value === "string" && looksLikeUrl(value)
      ? sanitizeUrlInternal(value)
      : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : failClosed();
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value !== "object"
  ) {
    return failClosed();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return failClosed();
    }
    return new Date(value.getTime());
  }
  if (value instanceof URL) {
    return new URL(sanitizeUrlInternal(value.toString()));
  }

  return withCycleGuard(value, ancestors, () => {
    if (Array.isArray(value)) {
      return denseArrayValues(value).map((item) =>
        cloneGenericValue(item, ancestors),
      );
    }
    if (!isPlainObject(value)) {
      return failClosed();
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of ownEnumerableEntries(value)) {
      let sanitized: unknown;
      const normalized = normalizedKey(key);

      if (isSecretKey(key)) {
        sanitized = redactValue(item);
      } else if (normalized.endsWith("headers")) {
        sanitized = sanitizeHeadersInternal(item, ancestors);
      } else if (
        ENCODED_BODY_KEYS.has(normalized) ||
        RAW_HEADER_KEYS.has(normalized)
      ) {
        sanitized = redactValue(item);
      } else if (OPAQUE_BODY_KEYS.has(normalized)) {
        sanitized = sanitizeBodyInternal(item, ancestors);
      } else if (
        (normalized === "url" ||
          normalized === "href" ||
          normalized === "location" ||
          normalized.endsWith("url")) &&
        typeof item === "string"
      ) {
        sanitized = sanitizeUrlInternal(item);
      } else {
        sanitized = cloneGenericValue(item, ancestors);
      }

      defineSafeProperty(output, key, sanitized);
    }
    return output;
  });
}

function cloneHeaderValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return looksLikeUrl(value) ? sanitizeUrlInternal(value) : value;
  }
  if (Array.isArray(value)) {
    return withCycleGuard(value, ancestors, () =>
      denseArrayValues(value).map((item) =>
        cloneHeaderValue(item, ancestors),
      ),
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : failClosed();
  }
  return failClosed();
}

function sanitizeHeaderTuples(
  headers: ReadonlyArray<unknown>,
  ancestors: WeakSet<object>,
): unknown[] {
  return withCycleGuard(headers, ancestors, () => {
    const output: unknown[] = [];
    for (const header of denseArrayValues(headers)) {
      if (!Array.isArray(header)) {
        return failClosed();
      }
      const headerItems = denseArrayValues(header);
      const name = headerItems[0];
      if (typeof name !== "string") {
        return failClosed();
      }
      if (isSensitiveHeaderName(name)) {
        continue;
      }
      output.push(
        headerItems.map((item, index) =>
          index === 0 ? item : cloneHeaderValue(item, ancestors),
        ),
      );
    }
    return output;
  });
}

function sanitizeFlatHeaders(
  headers: ReadonlyArray<unknown>,
  ancestors: WeakSet<object>,
): unknown[] {
  return withCycleGuard(headers, ancestors, () => {
    const items = denseArrayValues(headers);
    if (items.length % 2 !== 0) {
      return failClosed();
    }

    const output: unknown[] = [];
    for (let index = 0; index < items.length; index += 2) {
      const name = items[index];
      if (typeof name !== "string") {
        return failClosed();
      }
      if (isSensitiveHeaderName(name)) {
        continue;
      }
      output.push(name, cloneHeaderValue(items[index + 1], ancestors));
    }
    return output;
  });
}

function sanitizeHeadersInternal(
  headers: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (Array.isArray(headers)) {
    const items = denseArrayValues(headers);
    const tupleLike = items.every(
      (header) =>
        Array.isArray(header) &&
        typeof denseArrayValues(header)[0] === "string",
    );
    return tupleLike
      ? sanitizeHeaderTuples(headers, ancestors)
      : sanitizeFlatHeaders(headers, ancestors);
  }

  if (headers === null || typeof headers !== "object") {
    return failClosed();
  }
  if (!isPlainObject(headers)) {
    return failClosed();
  }

  return withCycleGuard(headers, ancestors, () => {
    const output: Record<string, unknown> = {};
    for (const [name, value] of ownEnumerableEntries(headers)) {
      if (!isSensitiveHeaderName(name)) {
        defineSafeProperty(
          output,
          name,
          cloneHeaderValue(value, ancestors),
        );
      }
    }
    return output;
  });
}

/** Drop authentication/session headers case-insensitively and clone the rest. */
export function sanitizeHeaders<T>(headers: T): T {
  return guard(
    () => sanitizeHeadersInternal(headers, new WeakSet<object>()) as T,
  );
}

function sanitizeBodyString(
  input: string,
  ancestors: WeakSet<object>,
): string {
  if (input.length === 0) {
    return input;
  }

  const trimmed = input.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      return failClosed();
    }
    return JSON.stringify(sanitizeBodyInternal(parsed, ancestors));
  }

  // Without a trusted content type, an arbitrary credential or base64 value
  // can look form-encoded. Redact every non-JSON body string as one value.
  return redactValue(input);
}

function sanitizeBodyInternal(
  body: unknown,
  ancestors: WeakSet<object>,
  redactOpaqueString = true,
): unknown {
  if (typeof body === "string") {
    if (redactOpaqueString) {
      return sanitizeBodyString(body, ancestors);
    }
    return looksLikeUrl(body) ? sanitizeUrlInternal(body) : body;
  }
  if (
    body === null ||
    typeof body === "boolean" ||
    typeof body === "undefined"
  ) {
    return body;
  }
  if (typeof body === "number") {
    return Number.isFinite(body) ? body : failClosed();
  }
  if (
    typeof body === "bigint" ||
    typeof body === "function" ||
    typeof body === "symbol" ||
    typeof body !== "object"
  ) {
    return failClosed();
  }

  return withCycleGuard(body, ancestors, () => {
    if (Array.isArray(body)) {
      return denseArrayValues(body).map((item) =>
        sanitizeBodyInternal(item, ancestors, false),
      );
    }
    if (!isPlainObject(body)) {
      return failClosed();
    }

    const output: Record<string, unknown> = {};
    for (const [key, value] of ownEnumerableEntries(body)) {
      const normalized = normalizedKey(key);
      defineSafeProperty(
        output,
        key,
        isBodySensitiveKey(key)
          ? redactValue(value)
          : (normalized === "url" ||
                normalized === "href" ||
                normalized === "location" ||
                normalized.endsWith("url")) &&
              typeof value === "string"
            ? sanitizeUrlInternal(value)
          : sanitizeBodyInternal(value, ancestors, false),
      );
    }
    return output;
  });
}

/** Recursively redact secrets and common customer PII from a request body. */
export function sanitizeBody<T>(body: T): T {
  return guard(() => sanitizeBodyInternal(body, new WeakSet<object>()) as T);
}

/**
 * Produce a detached, persistence-safe clone of a JSON-like event structure.
 * Any unsupported shape aborts with SanitizationError; callers must only write
 * the returned value after this function has completed successfully.
 */
export function sanitizeForPersistence<T>(input: T): T {
  return guard(() => cloneGenericValue(input, new WeakSet<object>()) as T);
}
