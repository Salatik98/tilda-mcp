import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SanitizationError,
  redactValue,
  sanitizeBody,
  sanitizeForPersistence,
  sanitizeHeaders,
  sanitizeUrl,
} from "../../src/research/security/sanitize.js";

describe("redactValue", () => {
  it("uses a deterministic sha256_8 and UTF-8 length placeholder", () => {
    const source = "unit-test-credential";
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 8);
    const expected = `[REDACTED:sha256_8=${digest}:length=${Buffer.byteLength(source)}]`;

    expect(redactValue(source)).toBe(expected);
    expect(redactValue(source)).toBe(redactValue(source));
    expect(redactValue(source)).not.toContain(source);
    expect(redactValue(expected)).not.toBe(expected);
  });
});

describe("sanitizeHeaders", () => {
  it("drops cookie, auth, CSRF, and XSRF headers without mutating input", () => {
    const headers = Object.freeze({
      Accept: "application/json",
      Authorization: "Bearer header-credential",
      COOKIE: "browser-session-value",
      "Set-Cookie": "response-session-value",
      "X-CSRF-Token": "csrf-value",
      "x-xsrf-token": "xsrf-value",
      Referer: "https://example.test/editor?token=referer-token&view=wide",
    });

    const sanitized = sanitizeHeaders(headers);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toEqual({
      Accept: "application/json",
      Referer: expect.stringContaining("view=wide"),
    });
    expect(serialized).not.toContain("header-credential");
    expect(serialized).not.toContain("browser-session-value");
    expect(serialized).not.toContain("response-session-value");
    expect(serialized).not.toContain("csrf-value");
    expect(serialized).not.toContain("xsrf-value");
    expect(serialized).not.toContain("referer-token");
    expect(headers.Authorization).toBe("Bearer header-credential");
  });

  it("supports tuple and flat-array header representations", () => {
    const tuples = [
      ["Cookie", "tuple-session"],
      ["Content-Type", "application/json"],
    ] as const;
    const flat = ["Authorization", "flat-auth", "Accept", "text/plain"];

    expect(sanitizeHeaders(tuples)).toEqual([
      ["Content-Type", "application/json"],
    ]);
    expect(sanitizeHeaders(flat)).toEqual(["Accept", "text/plain"]);
    expect(JSON.stringify(sanitizeHeaders(tuples))).not.toContain("tuple-session");
    expect(JSON.stringify(sanitizeHeaders(flat))).not.toContain("flat-auth");
  });
});

describe("sanitizeUrl", () => {
  it("redacts every sensitive query-key family while preserving safe values", () => {
    const original =
      "https://example.test/path?secret=a&access_token=b&password=c&session=d&auth=e&api_key=f&publickey=g&secretkey=h&csrf=i&xsrf=j&safe=kept";
    const sanitized = sanitizeUrl(original);
    const parsed = new URL(sanitized);

    for (const key of [
      "secret",
      "access_token",
      "password",
      "session",
      "auth",
      "api_key",
      "publickey",
      "secretkey",
      "csrf",
      "xsrf",
    ]) {
      expect(parsed.searchParams.get(key)).toMatch(
        /^\[REDACTED:sha256_8=[a-f0-9]{8}:length=\d+\]$/u,
      );
    }
    expect(parsed.searchParams.get("safe")).toBe("kept");
    for (const sourceValue of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
      expect([...parsed.searchParams.values()]).not.toContain(sourceValue);
    }
    expect(original).toContain("access_token=b");
  });

  it("recognizes encoded key names", () => {
    const parsed = new URL(
      sanitizeUrl("https://example.test/?%73ecret=encoded-source&safe=yes"),
    );

    expect(parsed.searchParams.get("secret")).toMatch(/^\[REDACTED:/u);
    expect(parsed.toString()).not.toContain("encoded-source");

    const doubleEncoded = new URL(
      sanitizeUrl("https://example.test/?%2574oken=double-encoded-source"),
    );
    expect([...doubleEncoded.searchParams.values()][0]).toMatch(
      /^\[REDACTED:/u,
    );
    expect(doubleEncoded.toString()).not.toContain("double-encoded-source");
  });

  it("fails closed on semicolon-ambiguous queries", () => {
    expect(() =>
      sanitizeUrl(
        "https://example.test/?safe=1;token=semicolon-query-credential",
      ),
    ).toThrow(SanitizationError);
    expect(() =>
      sanitizeUrl(
        "https://example.test/?safe=1%3Btoken%3Dencoded-semicolon-credential",
      ),
    ).toThrow(SanitizationError);
  });

  it("removes the full query on api.tildacdn.info", () => {
    const sanitized = sanitizeUrl(
      "https://api.tildacdn.info/v1/getpage/?pageid=42&publickey=public-value&secretkey=secret-value#result",
    );
    const parsed = new URL(sanitized);

    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#result");
    expect(sanitized).not.toContain("public-value");
    expect(sanitized).not.toContain("secret-value");

    const trailingDot = sanitizeUrl(
      "https://api.tildacdn.info./v1/getpage/?pageid=99&safe=must-also-go",
    );
    expect(new URL(trailingDot).search).toBe("");
    expect(trailingDot).not.toContain("must-also-go");
  });
});

describe("sanitizeBody", () => {
  it("recursively redacts secret and PII keys and leaves input untouched", () => {
    const input = Object.freeze({
      event: "form-submit",
      customer: Object.freeze({
        email: "person@example.test",
        phone_number: "+10000000000",
        fullName: "Example Person",
        fio: "Example FIO",
        message: "Private note",
        customerEmailAddress: "middle-email@example.test",
        billingPhoneNumberValue: "+19999999999",
        formMessageText: "Middle private note",
        customerFioValue: "Middle FIO",
        nested: Object.freeze([
          Object.freeze({ accessToken: "body-token", safe: "visible" }),
        ]),
      }),
    });

    const sanitized = sanitizeBody(input);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).not.toBe(input);
    expect(sanitized.customer).not.toBe(input.customer);
    expect(sanitized.customer.nested[0]?.safe).toBe("visible");
    for (const original of [
      "person@example.test",
      "+10000000000",
      "Example Person",
      "Example FIO",
      "Private note",
      "body-token",
      "middle-email@example.test",
      "+19999999999",
      "Middle private note",
      "Middle FIO",
    ]) {
      expect(serialized).not.toContain(original);
    }
    expect(input.customer.email).toBe("person@example.test");
  });

  it("sanitizes JSON and form-encoded strings and redacts opaque strings", () => {
    const json = JSON.stringify({ email: "json@example.test", safe: "ok" });
    const form = "phone=%2B10000000000&safe=ok&message=private";
    const opaque = "unstructured private payload";
    const opaqueWithEquals = "Bearer opaque-auth=credential";
    const base64Like = "cGFkZGVkLWNyZWRlbnRpYWw=";

    const sanitizedJson = sanitizeBody(json);
    const sanitizedForm = sanitizeBody(form);
    const sanitizedOpaque = sanitizeBody(opaque);
    const sanitizedOpaqueWithEquals = sanitizeBody(opaqueWithEquals);
    const sanitizedBase64Like = sanitizeBody(base64Like);

    expect(JSON.parse(sanitizedJson)).toMatchObject({ safe: "ok" });
    expect(sanitizedJson).not.toContain("json@example.test");
    expect(sanitizedForm).toMatch(/^\[REDACTED:/u);
    expect(sanitizedForm).not.toContain(form);
    expect(sanitizedForm).not.toContain("10000000000");
    expect(sanitizedForm).not.toContain("private");
    expect(sanitizedOpaque).toMatch(/^\[REDACTED:/u);
    expect(sanitizedOpaque).not.toContain(opaque);
    expect(sanitizedOpaqueWithEquals).toMatch(/^\[REDACTED:/u);
    expect(sanitizedOpaqueWithEquals).not.toContain(opaqueWithEquals);
    expect(sanitizedBase64Like).toMatch(/^\[REDACTED:/u);
    expect(sanitizedBase64Like).not.toContain(base64Like);
  });

  it("redacts credentials in relative URL values", () => {
    const body = {
      returnUrl: "/submit?token=relative-body-credential&safe=yes",
      links: ["/next?session=array-body-credential"],
      location: "callback?api_key=location-body-credential",
    };
    const sanitized = sanitizeBody(body);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("relative-body-credential");
    expect(serialized).not.toContain("array-body-credential");
    expect(serialized).not.toContain("location-body-credential");
    expect(serialized).toContain("safe=yes");
  });
});

describe("sanitizeForPersistence", () => {
  it("sanitizes a nested request event as a detached clone", () => {
    const event = Object.freeze({
      method: "Network.requestWillBeSent",
      request: Object.freeze({
        url: "https://example.test/save?token=request-token&id=7",
        headers: Object.freeze({
          Cookie: "event-session",
          Accept: "application/json",
        }),
        body: Object.freeze({
          email: "event@example.test",
          safe: Object.freeze({ count: 1 }),
        }),
        postDataEntries: Object.freeze([
          Object.freeze({ bytes: "encoded-request-body" }),
        ]),
      }),
      headersText: "Set-Cookie: raw-cookie-value",
      sessionToken: "top-level-token",
    });

    const sanitized = sanitizeForPersistence(event);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).not.toBe(event);
    expect(sanitized.request).not.toBe(event.request);
    expect(sanitized.request.headers).toEqual({ Accept: "application/json" });
    expect(sanitized.request.body.safe).toEqual({ count: 1 });
    expect(serialized).not.toContain("request-token");
    expect(serialized).not.toContain("event-session");
    expect(serialized).not.toContain("event@example.test");
    expect(serialized).not.toContain("top-level-token");
    expect(serialized).not.toContain("encoded-request-body");
    expect(serialized).not.toContain("raw-cookie-value");
    expect(event.request.headers.Cookie).toBe("event-session");
  });

  it("sanitizes relative URL values in generic events and headers", () => {
    const input = {
      location: "/finish?token=generic-relative-credential",
      responseHeaders: {
        Location: "/callback?session=header-relative-credential",
      },
    };
    const serialized = JSON.stringify(sanitizeForPersistence(input));

    expect(serialized).not.toContain("generic-relative-credential");
    expect(serialized).not.toContain("header-relative-credential");
  });

  it("throws a typed error for circular or unsupported inputs", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => sanitizeForPersistence(circular)).toThrow(SanitizationError);
    expect(() => sanitizeForPersistence({ binary: new Uint8Array([1, 2]) })).toThrow(
      SanitizationError,
    );

    const accessorArray = ["safe"];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => "array-getter-credential",
    });
    expect(() => sanitizeForPersistence(accessorArray)).toThrow(
      SanitizationError,
    );
  });

  it("does not let a caller persist anything when sanitization fails", () => {
    let persisted = 0;
    const persist = (value: unknown): void => {
      sanitizeForPersistence(value);
      persisted += 1;
    };
    const dangerous = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(dangerous, "value", {
      enumerable: true,
      get: () => "getter-credential",
    });

    expect(() => persist(dangerous)).toThrowError(
      expect.objectContaining({
        code: "SANITIZATION_FAILED",
        message: "Sanitization failed; persistence must be aborted.",
      }),
    );
    expect(persisted).toBe(0);
  });
});
