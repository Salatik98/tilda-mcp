import {
  notImplementedResult,
  type TildaMcpResult,
  type TildaMcpToolName,
  type TildaMcpTarget,
} from "./protocol.js";

/**
 * The semantic server depends only on this boundary. The Phase 2 control
 * engine supplies an implementation that owns target binding, snapshots,
 * adapters, verification, and rollback.
 */
export interface TildaMcpService {
  execute(
    tool: TildaMcpToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<TildaMcpResult>;
}

function targetFromInput(input: Readonly<Record<string, unknown>>): TildaMcpTarget | null {
  const request = input.request;
  const query = input.query;
  const value =
    input.target ??
    (request !== null && typeof request === "object" && !Array.isArray(request)
      ? (request as Record<string, unknown>).target
      : undefined) ??
    (query !== null && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>).target
      : undefined);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const target = value as Record<string, unknown>;
  const kind = target.kind;
  if (typeof kind !== "string" || typeof target.projectId !== "string") return null;
  if (kind === "project") return { kind, projectId: target.projectId };
  if (typeof target.pageId !== "string") return null;
  if (kind === "page") return { kind, projectId: target.projectId, pageId: target.pageId };
  if (typeof target.recordId !== "string") return null;
  if (kind === "record") {
    return {
      kind,
      projectId: target.projectId,
      pageId: target.pageId,
      recordId: target.recordId,
    };
  }
  if (kind !== "element" || typeof target.elementId !== "string") return null;
  return {
    kind,
    projectId: target.projectId,
    pageId: target.pageId,
    recordId: target.recordId,
    elementId: target.elementId,
  };
}

/** Fail-closed placeholder used until a real engine is injected at startup. */
export function createUnimplementedTildaMcpService(): TildaMcpService {
  return {
    async execute(tool, input) {
      return notImplementedResult(tool, targetFromInput(input));
    },
  };
}
