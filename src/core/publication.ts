import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import type { AdapterSessionFactory, BoundAdapterSession, PublicationData } from "../adapters/session.js";
import type { PageTarget, PublicationJournalRecord } from "./contracts.js";
import { TildaEngineError } from "./contracts.js";
import { ChangeSetStore } from "./store.js";

export type PublicationAction = "publish" | "unpublish";

export interface PublicationActionResult {
  readonly action: PublicationAction;
  readonly target: PageTarget;
  readonly before: PublicationData;
  readonly after: PublicationData;
  readonly stateChanged: boolean;
  readonly dryRun: boolean;
}

export interface PublicationReconciliationOptions {
  /**
   * Delays between bounded post-dispatch editor rereads. The first reread is
   * immediate; these waits are the only reconciliation time budget and no
   * write is ever retried.
   */
  readonly delaysMs?: readonly number[];
  /** Injectable for focused tests; production uses a real timer. */
  readonly delay?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_RECONCILIATION_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 1_500]);
const MAX_RECONCILIATION_BUDGET_MS = 8_000;

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertReconciliationDelays(delays: readonly number[]): readonly number[] {
  if (
    delays.some((milliseconds) => !Number.isSafeInteger(milliseconds) || milliseconds < 0) ||
    delays.reduce((total, milliseconds) => total + milliseconds, 0) > MAX_RECONCILIATION_BUDGET_MS
  ) {
    throw new TildaEngineError(
      "INVALID_PUBLICATION_RECONCILIATION_BUDGET",
      `Publication reconciliation delays must be non-negative integers with a total budget of at most ${MAX_RECONCILIATION_BUDGET_MS}ms.`,
    );
  }
  return [...delays];
}

export interface PublicVerificationResult {
  readonly ok: boolean;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly responseBytes: number;
  readonly responseHash: string;
  readonly title: string | null;
  readonly canonicalUrl: string | null;
  readonly recordIds: readonly string[];
  readonly cacheBusted: true;
}

function publicationIntentHash(action: PublicationAction, target: PageTarget): string {
  return createHash("sha256")
    .update(`tilda-publication-v1\0${action}\0${target.projectId}\0${target.pageId}`)
    .digest("hex");
}

function changedHash(value: string): string {
  return createHash("sha256")
    .update(`tilda-publication-changed-v1\0${value}`)
    .digest("hex");
}

function isPublished(value: PublicationData): boolean {
  return value.published !== "";
}

function isDesired(action: PublicationAction, value: PublicationData): boolean {
  return action === "publish" ? isPublished(value) : !isPublished(value);
}

function terminalPublication(
  record: PublicationJournalRecord,
  state: Exclude<PublicationJournalRecord["state"], "CLAIMED">,
  fields: Pick<PublicationJournalRecord, "failureCode" | "reconciliationCode"> = {},
): PublicationJournalRecord {
  return {
    ...record,
    state,
    updatedAt: new Date().toISOString(),
    ...fields,
  };
}

export class PublicationController {
  readonly #reconciliationDelaysMs: readonly number[];
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(
    readonly sessions: AdapterSessionFactory,
    readonly store = new ChangeSetStore(),
    options: PublicationReconciliationOptions = {},
  ) {
    this.#reconciliationDelaysMs = assertReconciliationDelays(
      options.delaysMs ?? DEFAULT_RECONCILIATION_DELAYS_MS,
    );
    this.#delay = options.delay ?? defaultDelay;
  }

  async #readAfterDispatch(
    session: BoundAdapterSession,
    target: PageTarget,
    action: PublicationAction,
    beforePublished: boolean,
    beforeChangedHash: string,
  ): Promise<{ readonly state: "DESIRED" | "UNCHANGED" | "AMBIGUOUS"; readonly value: PublicationData | null }> {
    let latest: PublicationData | null = null;
    const classify = (value: PublicationData | null) => {
      latest = value;
      if (value === null) return "AMBIGUOUS" as const;
      const desired = isDesired(action, value);
      const changed = changedHash(value.changed) === beforeChangedHash;
      if (desired && changed) return "DESIRED" as const;
      if (isPublished(value) === beforePublished && changed) {
        return "UNCHANGED" as const;
      }
      return "AMBIGUOUS" as const;
    };

    const read = async (): Promise<"DESIRED" | "UNCHANGED" | "AMBIGUOUS"> => {
      try {
        return classify(await session.readPublication(target));
      } catch {
        return classify(null);
      }
    };

    let state = await read();
    if (state !== "UNCHANGED") return { state, value: latest };
    for (const milliseconds of this.#reconciliationDelaysMs) {
      await this.#delay(milliseconds);
      state = await read();
      if (state !== "UNCHANGED") return { state, value: latest };
    }
    return { state, value: latest };
  }

  async execute(
    action: PublicationAction,
    target: PageTarget,
    options: { dryRun?: boolean; idempotencyKey?: string } = {},
  ): Promise<PublicationActionResult> {
    const dryRun = options.dryRun !== false;
    if (!dryRun && options.idempotencyKey === undefined) {
      throw new TildaEngineError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Publication writes require an explicit idempotency key.",
      );
    }

    if (dryRun) {
      return this.sessions.withSession(async (session) => {
        const before = await session.readPublication(target);
        return { action, target, before, after: before, stateChanged: false, dryRun: true };
      });
    }

    const key = options.idempotencyKey!;
    const intentHash = publicationIntentHash(action, target);
    return this.store.withMutationLock(async () =>
      this.sessions.withSession(async (session) => {
        const before = await session.readPublication(target);
        const claimed = this.store.claimPublicationAction(key, {
          intentHash,
          action,
          target,
          beforePublished: isPublished(before),
          beforeChangedHash: changedHash(before.changed),
        });

        if (claimed.claim === "REPLAY") {
          return this.#reconcileReplay(key, claimed.record, before);
        }

        if (isDesired(action, before)) {
          const completed = terminalPublication(claimed.record, "NOOP");
          this.store.appendPublicationAction(key, completed);
          return { action, target, before, after: before, stateChanged: false, dryRun: false };
        }

        let dispatchFailed = false;
        let acknowledgementMissing = false;
        try {
          const receipt =
            action === "publish" ? await session.publish(target) : await session.unpublish(target);
          acknowledgementMissing =
            !receipt.requestDispatched || receipt.acknowledgement !== "acknowledged";
        } catch {
          dispatchFailed = true;
        }

        const reconciled = await this.#readAfterDispatch(
          session,
          target,
          action,
          claimed.record.beforePublished,
          claimed.record.beforeChangedHash,
        );
        const after = reconciled.value;

        if (reconciled.state === "DESIRED" && after !== null) {
          const reconciliationCode = dispatchFailed
            ? "PUBLICATION_ERROR_RECONCILED"
            : acknowledgementMissing
              ? "PUBLICATION_ACK_RECONCILED"
              : undefined;
          const completed = terminalPublication(
            claimed.record,
            "SUCCEEDED",
            reconciliationCode === undefined ? {} : { reconciliationCode },
          );
          this.store.appendPublicationAction(key, completed);
          return { action, target, before, after, stateChanged: true, dryRun: false };
        }

        if (
          after !== null &&
          isPublished(after) === claimed.record.beforePublished &&
          changedHash(after.changed) === claimed.record.beforeChangedHash
        ) {
          const failed = terminalPublication(claimed.record, "FAILED", {
            failureCode: "PUBLICATION_FAILED_UNCHANGED",
          });
          this.store.appendPublicationAction(key, failed);
          throw new TildaEngineError(
            "PUBLICATION_FAILED_UNCHANGED",
            "Publication dispatch did not change the exact editor state; it was not retried.",
          );
        }

        const ambiguous = terminalPublication(claimed.record, "AMBIGUOUS", {
          failureCode: "PUBLICATION_AMBIGUOUS",
        });
        this.store.appendPublicationAction(key, ambiguous);
        throw new TildaEngineError(
          "PUBLICATION_AMBIGUOUS",
          "Publication could not be reconciled by one editor reread; no retry is allowed.",
        );
      }),
    );
  }

  #reconcileReplay(
    key: string,
    record: PublicationJournalRecord,
    current: PublicationData,
  ): PublicationActionResult {
    if (record.state === "SUCCEEDED" || record.state === "NOOP") {
      if (
        !isDesired(record.action, current) ||
        changedHash(current.changed) !== record.beforeChangedHash
      ) {
        throw new TildaEngineError(
          "PUBLICATION_REPLAY_DRIFT",
          "Published state drifted after the terminal idempotent action; it was not replayed.",
        );
      }
      return {
        action: record.action,
        target: record.target,
        before: current,
        after: current,
        stateChanged: false,
        dryRun: false,
      };
    }
    if (record.state === "FAILED" || record.state === "AMBIGUOUS") {
      throw new TildaEngineError(
        "RECOVERY_REQUIRED",
        "The publication key has a terminal non-success outcome; no retry is allowed.",
      );
    }

    const currentChangedHash = changedHash(current.changed);
    if (
      isDesired(record.action, current) &&
      currentChangedHash === record.beforeChangedHash
    ) {
      const wasAlreadyDesired =
        record.action === "publish" ? record.beforePublished : !record.beforePublished;
      const completed = terminalPublication(
        record,
        wasAlreadyDesired ? "NOOP" : "SUCCEEDED",
        { reconciliationCode: "PUBLICATION_REPLAY_RECONCILED" },
      );
      this.store.appendPublicationAction(key, completed);
      return {
        action: record.action,
        target: record.target,
        before: current,
        after: current,
        stateChanged: false,
        dryRun: false,
      };
    }
    if (
      isPublished(current) === record.beforePublished &&
      currentChangedHash === record.beforeChangedHash
    ) {
      const failed = terminalPublication(record, "FAILED", {
        failureCode: "PUBLICATION_PREVIOUS_ATTEMPT_UNCHANGED",
      });
      this.store.appendPublicationAction(key, failed);
      throw new TildaEngineError(
        "RECOVERY_REQUIRED",
        "A prior publication attempt was claimed but the state is unchanged; it was not retried.",
      );
    }
    const ambiguous = terminalPublication(record, "AMBIGUOUS", {
      failureCode: "PUBLICATION_AMBIGUOUS",
    });
    this.store.appendPublicationAction(key, ambiguous);
    throw new TildaEngineError(
      "PUBLICATION_AMBIGUOUS",
      "A prior publication attempt left an unexpected state; no retry is allowed.",
    );
  }
}

function textBetween(source: string, pattern: RegExp): string | null {
  const value = pattern.exec(source)?.[1];
  return value === undefined ? null : value.replace(/\s+/gu, " ").trim();
}

function canonicalFromHtml(html: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    if (rel === undefined || !rel.split(/\s+/u).some((value) => value.toLowerCase() === "canonical")) {
      continue;
    }
    return /\bhref\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1] ?? null;
  }
  return null;
}

async function boundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("response too large");
        throw new TildaEngineError(
          "PUBLIC_RESPONSE_TOO_LARGE",
          `Public response exceeded ${limit} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class PublicPageVerifier {
  readonly #allowedDomains: ReadonlySet<string>;

  constructor(domains: readonly string[]) {
    const normalized = domains.map((domain) => domain.trim().toLowerCase());
    if (
      (normalized.length > 0 && normalized.some(
        (domain) =>
          domain === "localhost" ||
          isIP(domain) !== 0 ||
          !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain),
      )) ||
      new Set(normalized).size !== normalized.length
    ) {
      throw new TildaEngineError(
        "INVALID_PUBLIC_DOMAIN_ALLOWLIST",
        "Public verification domains must be unique exact DNS hostnames.",
      );
    }
    this.#allowedDomains = new Set(normalized);
  }

  async verify(rawUrl: string): Promise<PublicVerificationResult> {
    const requested = new URL(rawUrl);
    if (
      requested.protocol !== "https:" ||
      requested.username !== "" ||
      requested.password !== "" ||
      requested.hash !== "" ||
      requested.search !== "" ||
      requested.port !== "" ||
      isIP(requested.hostname) !== 0 ||
      !this.#allowedDomains.has(requested.hostname.toLowerCase())
    ) {
      throw new TildaEngineError(
        "PUBLIC_DOMAIN_NOT_ALLOWLISTED",
        "Public verification accepts only an exact configured HTTPS hostname, default port, and query-free URL.",
      );
    }
    requested.searchParams.set("__tilda_mcp_verify", randomUUID());
    const response = await fetch(requested, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TildaEngineError(
        "PUBLIC_REDIRECT_REJECTED",
        "Public verification does not follow redirects.",
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      await response.body?.cancel();
      throw new TildaEngineError(
        "PUBLIC_CONTENT_TYPE_REJECTED",
        "Public verification requires an HTML response.",
      );
    }
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const declaredLength = Number(rawLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > 5_000_000) {
        await response.body?.cancel();
        throw new TildaEngineError(
          "PUBLIC_RESPONSE_TOO_LARGE",
          "Public response declared an invalid or excessive content length.",
        );
      }
    }
    const bytes = await boundedResponseBytes(response, 5_000_000);
    const html = new TextDecoder().decode(bytes);
    const recordIds = [...html.matchAll(/\bid=["'](?:rec|record)([1-9][0-9]*)["']/giu)]
      .map((match) => match[1]!)
      .filter((value, index, values) => values.indexOf(value) === index);
    return {
      ok: response.ok,
      url: `${requested.origin}${requested.pathname}`,
      status: response.status,
      contentType,
      responseBytes: bytes.byteLength,
      responseHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      title: textBetween(html, /<title[^>]*>([\s\S]*?)<\/title>/iu),
      canonicalUrl: canonicalFromHtml(html),
      recordIds,
      cacheBusted: true,
    };
  }
}
