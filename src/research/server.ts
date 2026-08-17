#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { loadConfig } from "./config.js";

const MAX_BODY_BYTES = 64 * 1024;

interface LocalRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (size === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function normalizeRequest(request: IncomingMessage): Promise<LocalRequest> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return {
    method: request.method ?? "GET",
    pathname: url.pathname,
    body: request.method === "POST" ? await readJson(request) : null,
  };
}

export function startObservatoryServer(): void {
  const config = loadConfig();
  if (!isLoopback(config.observatoryHost)) {
    throw new Error("Observatory must bind to an explicit loopback address.");
  }

  const server = createServer(async (request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      writeJson(response, 403, { ok: false, error: { code: "LOOPBACK_ONLY" } });
      return;
    }

    try {
      const normalized = await normalizeRequest(request);
      if (normalized.method === "GET" && normalized.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          service: "tilda-agent-os-observatory",
          mode: "local_only",
          traceState: "not_connected",
          message: "Use the research CLI/browser harness to attach an exact tab before tracing.",
        });
        return;
      }

      if (
        normalized.method === "POST" &&
        (normalized.pathname === "/trace/start" || normalized.pathname === "/trace/stop")
      ) {
        writeJson(response, 409, {
          ok: false,
          error: {
            code: "TRACE_SOURCE_NOT_ATTACHED",
            message:
              "Standalone server has no implicit browser state. Attach an exact authorized tab through the research harness.",
          },
        });
        return;
      }

      writeJson(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
    } catch (error) {
      writeJson(response, 400, {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Invalid request.",
        },
      });
    }
  });

  server.listen(config.observatoryPort, config.observatoryHost, () => {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        listening: `http://${config.observatoryHost}:${config.observatoryPort}`,
        loopbackOnly: true,
        implicitBrowserState: false,
      })}\n`,
    );
  });
}

startObservatoryServer();
