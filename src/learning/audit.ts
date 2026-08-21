import type { ExactTarget } from "../core/contracts.js";
import {
  AUDIT_CHECKS,
  type AuditCheck,
  type AuditFinding,
  type AuditReport,
  type AuditRequest,
  type TildaAuditProvider,
} from "./contracts.js";

const ID = /^[1-9][0-9]*$/;
const TOKEN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const HASH = /^sha256:[0-9a-f]{64}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const CHECKS = new Set<string>(AUDIT_CHECKS);

export class AuditValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuditValidationError";
    this.code = code;
  }
}

function assertTarget(target: ExactTarget): void {
  if (!ID.test(target.projectId)) {
    throw new AuditValidationError("AUDIT_TARGET_INVALID", "Audit target has an invalid project ID.");
  }
  if (target.kind === "project") return;
  if (!ID.test(target.pageId)) {
    throw new AuditValidationError("AUDIT_TARGET_INVALID", "Audit target has an invalid page ID.");
  }
  if (target.kind === "page") return;
  if (!ID.test(target.recordId)) {
    throw new AuditValidationError("AUDIT_TARGET_INVALID", "Audit target has an invalid record ID.");
  }
  if (target.kind === "record") return;
  if (target.elementId.length === 0 || target.elementId.length > 160) {
    throw new AuditValidationError("AUDIT_TARGET_INVALID", "Audit target has an invalid element ID.");
  }
}

export function validateAuditRequest(request: AuditRequest): void {
  assertTarget(request.target);
  if (request.checks.length < 1 || request.checks.length > AUDIT_CHECKS.length) {
    throw new AuditValidationError("AUDIT_CHECKS_INVALID", "At least one bounded audit check is required.");
  }
  const seen = new Set<AuditCheck>();
  for (const check of request.checks) {
    if (!CHECKS.has(check) || seen.has(check)) {
      throw new AuditValidationError("AUDIT_CHECKS_INVALID", "Audit checks must be known and unique.");
    }
    seen.add(check);
  }
}

function validateFinding(finding: AuditFinding): void {
  if (!TOKEN.test(finding.code) || finding.code.length > 96) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit finding code is not a safe token.");
  }
  if (finding.summary.length === 0 || finding.summary.length > 512 || /[\u0000-\u001f]/.test(finding.summary)) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit finding summary is not sanitized.");
  }
  if (finding.evidenceHash !== undefined && !HASH.test(finding.evidenceHash)) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit evidence hash is invalid.");
  }
}

export function validateAuditReport(report: AuditReport, request: AuditRequest): void {
  assertTarget(report.target);
  if (JSON.stringify(report.target) !== JSON.stringify(request.target)) {
    throw new AuditValidationError("AUDIT_REPORT_TARGET_MISMATCH", "Audit report target differs from the request.");
  }
  if (report.format !== "tilda-audit-v1") {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit report format is unsupported.");
  }
  if (!ISO.test(report.observedAt)) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit report timestamp is invalid.");
  }
  if (report.adapter !== null && (!TOKEN.test(report.adapter) || report.adapter.length > 96)) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit adapter ID is not a safe token.");
  }
  if (report.findings.length > 64) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit report contains too many findings.");
  }
  if (
    report.checks.length !== request.checks.length ||
    report.checks.some((check, index) => check !== request.checks[index])
  ) {
    throw new AuditValidationError("AUDIT_REPORT_INVALID", "Audit report checks differ from the request.");
  }
  for (const finding of report.findings) validateFinding(finding);
}

export interface AuditOutcome {
  readonly ok: boolean;
  readonly code: string;
  readonly summary: string;
  readonly report?: AuditReport;
  readonly blockedReasons?: readonly string[];
}

/**
 * Runs only a typed, read-only audit provider. A missing provider is a normal
 * blocked state; this class never guesses an endpoint or falls back to clicks.
 */
export class TypedAuditRunner {
  constructor(readonly provider: TildaAuditProvider | null) {}

  async run(request: AuditRequest): Promise<AuditOutcome> {
    try {
      validateAuditRequest(request);
    } catch (error) {
      const code = error instanceof AuditValidationError ? error.code : "AUDIT_REQUEST_INVALID";
      return {
        ok: false,
        code,
        summary: error instanceof Error ? error.message : "Audit request is invalid.",
        blockedReasons: [code],
      };
    }
    if (this.provider === null) {
      return {
        ok: false,
        code: "AUDIT_PROVIDER_UNAVAILABLE",
        summary: "No typed read-only audit provider is connected; no Tilda operation was attempted.",
        blockedReasons: ["AUDIT_PROVIDER_UNAVAILABLE"],
      };
    }
    try {
      const report = await this.provider.audit(request);
      validateAuditReport(report, request);
      return {
        ok: report.status !== "BLOCKED",
        code: report.status === "PASS" ? "AUDIT_OK" : report.status === "WARN" ? "AUDIT_WARN" : "AUDIT_BLOCKED",
        summary:
          report.status === "PASS"
            ? "Typed target audit passed without writes."
            : report.status === "WARN"
              ? "Typed target audit completed with warnings and no writes."
              : "Typed target audit blocked the target; no writes were attempted.",
        report,
      };
    } catch (error) {
      const code = error instanceof AuditValidationError ? error.code : "AUDIT_PROVIDER_FAILED";
      return {
        ok: false,
        code,
        summary:
          error instanceof AuditValidationError
            ? error.message
            : "The typed audit provider failed; no audit result is trusted.",
        blockedReasons: [code],
      };
    }
  }
}
