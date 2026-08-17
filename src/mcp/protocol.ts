import type { ChangeSetState, ExactTarget } from "../core/contracts.js";

/** Stable, adapter-agnostic contract between the MCP transport and the control engine. */
export const TILDA_MCP_TOOL_NAMES = [
  "tilda_status",
  "tilda_capabilities",
  "tilda_query",
  "tilda_plan_changeset",
  "tilda_apply_changeset",
  "tilda_verify_changeset",
  "tilda_rollback_changeset",
  "tilda_publish",
  "tilda_unpublish",
  "tilda_verify_live",
  "tilda_page_lifecycle",
] as const;

export type TildaMcpToolName = (typeof TILDA_MCP_TOOL_NAMES)[number];

export type TildaMcpTarget = ExactTarget;

export interface TildaMcpResult extends Record<string, unknown> {
  readonly ok: boolean;
  readonly code: string;
  readonly summary: string;
  readonly stateChanged: boolean;
  readonly target: TildaMcpTarget | null;
  readonly capability: string | null;
  readonly adapter: string | null;
  readonly snapshotId: string | null;
  readonly changeSetId: string | null;
  readonly verification: Record<string, unknown> | null;
  readonly diagnosticsRef: string | null;
  /** Present only when the planned mutation exposes a stable plan digest. */
  readonly planHash?: string | undefined;
  /** Present for ChangeSet-oriented responses. */
  readonly operationState?: ChangeSetState | undefined;
  /** Present when the server can determine whether rollback material is available. */
  readonly rollbackAvailable?: boolean | undefined;
  /** Present only when one or more concrete gates block the requested operation. */
  readonly blockedReasons?: readonly string[] | undefined;
}

export function notImplementedResult(
  tool: TildaMcpToolName,
  target: TildaMcpTarget | null = null,
): TildaMcpResult {
  return {
    ok: false,
    code: "NOT_IMPLEMENTED",
    summary: `${tool} is wired to the MCP surface, but no Tilda control-engine adapter is installed yet.`,
    stateChanged: false,
    target,
    capability: null,
    adapter: null,
    snapshotId: null,
    changeSetId: null,
    verification: null,
    diagnosticsRef: "docs/MCP_USAGE.md#current-scope",
    blockedReasons: ["ENGINE_NOT_CONNECTED"],
  };
}

export function isTildaMcpToolName(value: string): value is TildaMcpToolName {
  return (TILDA_MCP_TOOL_NAMES as readonly string[]).includes(value);
}
