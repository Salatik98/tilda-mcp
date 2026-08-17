import { canonicalHash } from "./hash.js";
import {
  CdpConnection,
  CdpUnavailableError,
  getCdpVersion,
  listCdpTargets,
  selectTildaTarget,
} from "./cdp-client.js";
import type { ResearchConfig } from "./config.js";
import {
  assertLabPageTarget,
  assertLabProjectTarget,
  isConfiguredLiveBindingMatch,
  isWriteAllowlistSyntacticallyValid,
} from "./config.js";
import {
  captureTrustedLiveBinding,
  isFreshTrustedBindingCapture,
  type TrustedBindingBlocked,
  type TrustedBindingCapture,
} from "./inventory.js";

export type AuthenticationState = "authenticated" | "authentication_required" | "unknown";

export function buildSafetyStatus(
  config: ResearchConfig,
  bindingCapture: TrustedBindingCapture | null = null,
): TildaStatus["safety"] {
  const liveInventory = isFreshTrustedBindingCapture(bindingCapture)
    ? bindingCapture.inventory
    : null;
  const syntacticallyValidProjectAllowlist = isWriteAllowlistSyntacticallyValid(config);
  const liveBindingMatched =
    liveInventory !== null && isConfiguredLiveBindingMatch(config, liveInventory);
  let writePreflightWouldPass = false;
  if (
    syntacticallyValidProjectAllowlist &&
    liveBindingMatched &&
    config.labProjectIds !== null &&
    config.labProjectIds.length > 0
  ) {
    try {
      for (const projectId of config.labProjectIds) {
        assertLabProjectTarget(config, { projectId }, liveInventory);
      }
      writePreflightWouldPass = true;
    } catch {
      writePreflightWouldPass = false;
    }
  }

  let pageWritePreflightWouldPass = false;
  if (
    writePreflightWouldPass &&
    liveInventory !== null &&
    config.labPageTargets !== null &&
    config.labPageTargets.length > 0
  ) {
    try {
      for (const target of config.labPageTargets) {
        assertLabPageTarget(config, target, liveInventory);
      }
      pageWritePreflightWouldPass = true;
    } catch {
      pageWritePreflightWouldPass = false;
    }
  }

  return {
    labAllowlistConfigured: config.labProjectIds !== null,
    liveInventoryCaptured: liveInventory !== null,
    allowlistBoundToInventory: liveBindingMatched,
    readOnlyCorpusProtected: config.readOnlyProjectIds !== null,
    labPageTargetsConfigured: config.labPageTargets !== null,
    projectAllowlistSyntacticallyValid: syntacticallyValidProjectAllowlist,
    // A serialized status result is never a write authorization. A future write
    // adapter must own the exact connection and repeat/consume its preflight
    // inside one transaction before it may expose an unblocked internal gate.
    writesBlocked: true,
    pageWritesBlocked: true,
    writePreflightWouldPass,
    pageWritePreflightWouldPass,
    requiresFreshWriteTimeCapture: true,
    writeAuthorizationReusable: false,
    officialApiConfigured: config.officialApiConfigured,
  };
}

export interface TildaStatus {
  ok: boolean;
  cdp: {
    reachable: boolean;
    browser: string | null;
    targetCount: number;
  };
  tilda: {
    targetFound: boolean;
    authentication: AuthenticationState;
    route: string | null;
    title: string | null;
  };
  safety: {
    labAllowlistConfigured: boolean;
    liveInventoryCaptured: boolean;
    allowlistBoundToInventory: boolean;
    readOnlyCorpusProtected: boolean;
    labPageTargetsConfigured: boolean;
    projectAllowlistSyntacticallyValid: boolean;
    writesBlocked: boolean;
    pageWritesBlocked: boolean;
    writePreflightWouldPass: boolean;
    pageWritePreflightWouldPass: boolean;
    requiresFreshWriteTimeCapture: true;
    writeAuthorizationReusable: false;
    officialApiConfigured: boolean;
  };
  binding: {
    capture: "BOUND" | "BLOCKED" | "NOT_ATTEMPTED";
    code: string | null;
    message: string | null;
    projectCount: number | null;
    pageCount: number | null;
  };
  editorFingerprint: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

interface PageProbe {
  host: string;
  pathname: string;
  searchKeys: string[];
  title: string;
  locale: string;
  loginSignals: boolean;
  authenticatedSignals: boolean;
  scriptPaths: string[];
  runtimeSymbols: Record<string, boolean>;
  domAnchors: Record<string, boolean>;
}

const PAGE_PROBE = String.raw`(() => {
  const url = new URL(location.href);
  const scriptPaths = Array.from(document.scripts)
    .map((script) => {
      try {
        const scriptUrl = new URL(script.src, location.href);
        return scriptUrl.pathname;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .sort();
  const loginSignals = Boolean(
    document.querySelector('input[type="password"], form[action*="login" i], [class*="login" i] input')
  ) || /\/login|\/signin/i.test(url.pathname);
  const authenticatedSignals = Boolean(
    document.querySelector('[data-project-id], a[href*="projectid=" i], a[href*="/project/" i], a[href*="logout" i]')
  ) || /\/projects|\/page\//i.test(url.pathname);

  return {
    host: url.hostname,
    pathname: url.pathname,
    searchKeys: Array.from(url.searchParams.keys()).sort(),
    title: document.title,
    locale: document.documentElement.lang || navigator.language || "unknown",
    loginSignals,
    authenticatedSignals,
    scriptPaths,
    runtimeSymbols: {
      ab__getDBSaveData: typeof window.ab__getDBSaveData === "function",
      tn__createFormData: typeof window.tn__createFormData === "function",
      tp__saveOnlyOneFieldInRecord: typeof window.tp__saveOnlyOneFieldInRecord === "function",
      tp__addRecord: typeof window.tp__addRecord === "function",
      tp__record__getRecordElement: Boolean(window.tp__record && typeof window.tp__record__getRecordElement === "function") || typeof window.tp__record__getRecordElement === "function"
    },
    domAnchors: {
      recordPrefix: Boolean(document.querySelector('[id^="record"]')),
      dataRecordType: Boolean(document.querySelector('[data-record-type]')),
      projectIdentity: Boolean(document.querySelector('[data-project-id], a[href*="projectid=" i]')),
      pageIdentity: Boolean(document.querySelector('[data-page-id], a[href*="pageid=" i]'))
    }
  };
})()`;

function authenticationFromProbe(probe: PageProbe): AuthenticationState {
  if (probe.loginSignals) return "authentication_required";
  if (probe.authenticatedSignals) return "authenticated";
  return "unknown";
}

export async function getTildaStatus(config: ResearchConfig): Promise<TildaStatus> {
  const baselineSafety = buildSafetyStatus(config);

  try {
    const [version, targets] = await Promise.all([
      getCdpVersion(config.cdpUrl),
      listCdpTargets(config.cdpUrl),
    ]);
    const target = selectTildaTarget(targets);
    if (target?.webSocketDebuggerUrl === undefined) {
      return {
        ok: false,
        cdp: { reachable: true, browser: version.Browser, targetCount: targets.length },
        tilda: {
          targetFound: false,
          authentication: "unknown",
          route: null,
          title: null,
        },
        safety: baselineSafety,
        binding: {
          capture: "NOT_ATTEMPTED",
          code: "TILDA_TARGET_NOT_FOUND",
          message: "No authenticated Tilda target was available for a trusted binding capture.",
          projectCount: null,
          pageCount: null,
        },
        editorFingerprint: null,
        error: { code: "TILDA_TARGET_NOT_FOUND", message: "No Tilda page is open in the CDP browser." },
      };
    }

    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    try {
      const probe = await connection.evaluate<PageProbe>(PAGE_PROBE);
      const editorFingerprint = {
        editorHost: probe.host,
        routeFamily: probe.pathname.split("/").filter(Boolean)[0] ?? "root",
        locale: probe.locale,
        scriptPathHash: canonicalHash(probe.scriptPaths),
        runtimeSymbols: probe.runtimeSymbols,
        domAnchors: probe.domAnchors,
      };

      let bindingCapture: TrustedBindingCapture;
      try {
        bindingCapture = await captureTrustedLiveBinding(config);
      } catch (error) {
        bindingCapture = {
          status: "BLOCKED",
          code: "CAPTURE_FAILED",
          message: error instanceof Error ? error.message : "Trusted binding capture failed.",
        } satisfies TrustedBindingBlocked;
      }
      const safety = buildSafetyStatus(config, bindingCapture);

      return {
        ok: true,
        cdp: { reachable: true, browser: version.Browser, targetCount: targets.length },
        tilda: {
          targetFound: true,
          authentication: authenticationFromProbe(probe),
          route: probe.pathname,
          title: probe.title,
        },
        safety,
        binding:
          bindingCapture.status === "BOUND"
            ? {
                capture: "BOUND",
                code: null,
                message: null,
                projectCount: bindingCapture.projectCount,
                pageCount: bindingCapture.pageCount,
              }
            : {
                capture: "BLOCKED",
                code: bindingCapture.code,
                message: bindingCapture.message,
                projectCount: null,
                pageCount: null,
              },
        editorFingerprint,
        error: null,
      };
    } finally {
      connection.close();
    }
  } catch (error) {
    const code = error instanceof CdpUnavailableError ? error.code : "STATUS_FAILED";
    return {
      ok: false,
      cdp: { reachable: false, browser: null, targetCount: 0 },
      tilda: {
        targetFound: false,
        authentication: "unknown",
        route: null,
        title: null,
      },
      safety: baselineSafety,
      binding: {
        capture: "NOT_ATTEMPTED",
        code,
        message: error instanceof Error ? error.message : String(error),
        projectCount: null,
        pageCount: null,
      },
      editorFingerprint: null,
      error: { code, message: error instanceof Error ? error.message : String(error) },
    };
  }
}
