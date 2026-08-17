import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REQUEST_TIMEOUT_MS = 45_000;

const REQUIRED_TOOLS = Object.freeze([
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
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structuredResult(response: unknown): Record<string, unknown> {
  if (!isObject(response) || !isObject(response.structuredContent)) {
    throw new Error("MCP response did not contain structured content.");
  }
  return response.structuredContent;
}

async function main(): Promise<void> {
  let childStderrObserved = false;
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["--silent", "mcp"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {
    childStderrObserved = true;
  });
  const client = new Client({ name: "tilda-agent-os-stdio-smoke", version: "0.2.0-prealpha" });

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    const server = client.getServerVersion();
    if (server?.name !== "tilda-agent-os" || typeof server.version !== "string") {
      throw new Error("Unexpected MCP server identity.");
    }

    const listed = await client.listTools({}, { timeout: REQUEST_TIMEOUT_MS });
    const toolNames = new Set(listed.tools.map((tool) => tool.name));
    const missingTools = REQUIRED_TOOLS.filter((toolName) => !toolNames.has(toolName));
    if (missingTools.length > 0) {
      throw new Error(`Required MCP tools are missing: ${missingTools.join(", ")}.`);
    }

    const capabilitiesResponse = await client.callTool(
      { name: "tilda_capabilities", arguments: {} },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const capabilities = structuredResult(capabilitiesResponse);
    if (capabilities.ok !== true || capabilities.code !== "CAPABILITIES_PARTIAL") {
      throw new Error("Capability report did not satisfy the read-only contract.");
    }

    // Status may be blocked when no local authenticated browser is configured;
    // that is expected for a public checkout and must not be treated as write
    // authority. The smoke only asserts that the result is structured.
    const statusResponse = await client.callTool(
      { name: "tilda_status", arguments: {} },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const status = structuredResult(statusResponse);
    if (typeof status.ok !== "boolean" || typeof status.code !== "string" || status.stateChanged !== false) {
      throw new Error("Status response did not satisfy the read-only contract.");
    }

    await client.close();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      server: { name: server.name, version: server.version },
      toolCount: listed.tools.length,
      requiredToolsPresent: true,
      capabilities: { ok: capabilities.ok, code: capabilities.code },
      status: { ok: status.ok, code: status.code, stateChanged: status.stateChanged },
      note: "No live target IDs or remote writes are used by this public smoke.",
      childStderrObserved,
    })}\n`);
  } catch (error) {
    await client.close().catch(() => transport.close().catch(() => undefined));
    process.stderr.write(`${JSON.stringify({
      ok: false,
      failure: error instanceof Error ? error.message : String(error),
      childStderrObserved,
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
