import { createHash, randomBytes } from "node:crypto";
import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { TrustedBrowserSession } from "../browser-session.js";
import {
  TRUSTED_PROBE_HASHES,
  type IdentityProbe,
  type ProjectPagesProbe,
  type ProjectsRootProbe,
} from "../probes.js";

export const EXTENSION_STDIO_PROTOCOL_VERSION = 1 as const;
export const EXTENSION_STDIO_MAX_FRAME_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 12_000;
const CANONICAL_ID = /^[1-9][0-9]*$/;

export class ExtensionStdioTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtensionStdioTransportError";
    this.code = code;
  }
}

export interface ExtensionStdioChannelStreams {
  readonly readable: Readable;
  readonly writable: Writable;
}

export interface ExtensionStdioRequest {
  readonly version: 1;
  readonly sequence: number;
  readonly operation:
    | "bind.hello"
    | "bind.root"
    | "bind.identity"
    | "bind.project"
    | "bind.restore"
    | "bind.close";
  readonly challenge?: string;
  readonly probeHashes?: typeof TRUSTED_PROBE_HASHES;
  readonly projectId?: string;
  readonly timeoutMs?: number;
}

export interface ExtensionStdioResponse {
  readonly version: 1;
  readonly sequence: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export function encodeExtensionStdioFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > EXTENSION_STDIO_MAX_FRAME_BYTES) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_FRAME_SIZE_REJECTED",
      "Extension stdio frame is empty or exceeds the maximum size.",
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class ExtensionStdioFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (this.#buffer.byteLength + chunk.byteLength > EXTENSION_STDIO_MAX_FRAME_BYTES + 4) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_FRAME_SIZE_REJECTED",
        "Extension stdio buffered input exceeds one bounded protocol frame.",
      );
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      if (frames.length > 0) {
        throw new ExtensionStdioTransportError(
          "EXTENSION_FRAME_BURST_REJECTED",
          "Extension stdio accepts only one outstanding protocol frame.",
        );
      }
      const size = this.#buffer.readUInt32BE(0);
      if (size < 1 || size > EXTENSION_STDIO_MAX_FRAME_BYTES) {
        throw new ExtensionStdioTransportError(
          "EXTENSION_FRAME_SIZE_REJECTED",
          "Extension stdio frame declares an invalid size.",
        );
      }
      if (this.#buffer.byteLength < 4 + size) break;
      const payload = this.#buffer.subarray(4, 4 + size);
      this.#buffer = this.#buffer.subarray(4 + size);
      try {
        frames.push(JSON.parse(payload.toString("utf8")) as unknown);
      } catch {
        throw new ExtensionStdioTransportError(
          "EXTENSION_FRAME_JSON_REJECTED",
          "Extension stdio frame is not valid JSON.",
        );
      }
    }
    return frames;
  }

  assertComplete(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_FRAME_TRUNCATED",
        "Extension stdio channel ended with an incomplete frame.",
      );
    }
  }
}

export class ExtensionStdioJsonChannel {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #decoder = new ExtensionStdioFrameDecoder();
  readonly #queue: unknown[] = [];
  readonly #waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  }> = [];
  #terminalError: unknown = null;
  #closed = false;

  constructor(streams: ExtensionStdioChannelStreams) {
    this.#readable = streams.readable;
    this.#writable = streams.writable;
    this.#readable.on("data", (chunk: Buffer | string) => {
      if (this.#terminalError !== null) return;
      try {
        for (const frame of this.#decoder.push(
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
        )) {
          const waiter = this.#waiters.shift();
          if (waiter === undefined) {
            if (this.#queue.length > 0) {
              throw new ExtensionStdioTransportError(
                "EXTENSION_FRAME_BURST_REJECTED",
                "Extension stdio accepts only one outstanding protocol frame.",
              );
            }
            this.#queue.push(frame);
          }
          else {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        }
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#readable.once("error", (error) => this.#fail(error));
    this.#readable.once("end", () => {
      try {
        this.#decoder.assertComplete();
        this.#fail(
          new ExtensionStdioTransportError(
            "EXTENSION_CHANNEL_EOF",
            "Extension stdio parent closed the private channel.",
          ),
        );
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#readable.once("close", () => {
      this.#fail(
        new ExtensionStdioTransportError(
          "EXTENSION_CHANNEL_EOF",
          "Extension stdio peer closed the private channel.",
        ),
      );
    });
    this.#writable.once("error", (error) => this.#fail(error));
  }

  async send(value: unknown): Promise<void> {
    if (this.#closed || this.#terminalError !== null) {
      throw this.#terminalError ?? new ExtensionStdioTransportError(
        "EXTENSION_CHANNEL_CLOSED",
        "Extension stdio channel is closed.",
      );
    }
    const frame = encodeExtensionStdioFrame(value);
    await new Promise<void>((resolve, reject) => {
      this.#writable.write(frame, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  async receive(timeoutMs = MAX_TIMEOUT_MS): Promise<unknown> {
    if (this.#terminalError !== null) throw this.#terminalError;
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_TIMEOUT_REJECTED",
        "Extension stdio receive timeout is invalid.",
      );
    }
    if (this.#waiters.length > 0) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_CONCURRENT_RECEIVE_REJECTED",
        "Extension stdio permits only one outstanding receive.",
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(
          new ExtensionStdioTransportError(
            "EXTENSION_CHANNEL_TIMEOUT",
            "Extension stdio parent did not answer within the bounded deadline.",
          ),
        );
      }, timeoutMs);
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(
      new ExtensionStdioTransportError(
        "EXTENSION_CHANNEL_CLOSED",
        "Extension stdio channel is closed.",
      ),
    );
    this.#writable.destroy();
    this.#readable.destroy();
  }

  abort(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(error);
    this.#writable.destroy();
    this.#readable.destroy();
  }

  #fail(error: unknown): void {
    if (this.#terminalError !== null) return;
    this.#terminalError = error;
    this.#queue.splice(0);
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertResponse(value: unknown, sequence: number): ExtensionStdioResponse {
  if (!isObject(value)) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_RESPONSE_REJECTED",
      "Extension stdio response is not an object.",
    );
  }
  if (
    value.version !== EXTENSION_STDIO_PROTOCOL_VERSION ||
    value.sequence !== sequence ||
    typeof value.ok !== "boolean"
  ) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_RESPONSE_REJECTED",
      "Extension stdio response version or sequence does not match.",
    );
  }
  if (value.ok === false) {
    const error = isObject(value.error) ? value.error : null;
    throw new ExtensionStdioTransportError(
      typeof error?.code === "string" ? error.code : "EXTENSION_BROKER_REJECTED",
      typeof error?.message === "string"
        ? error.message
        : "Extension tab broker rejected the named operation.",
    );
  }
  return value as unknown as ExtensionStdioResponse;
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_TIMEOUT_REJECTED",
      "Named probe timeout must be a positive integer.",
    );
  }
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

export class ExtensionStdioTrustedBrowserSession implements TrustedBrowserSession {
  readonly transport = "extension_stdio" as const;
  readonly sessionId: string;
  readonly #channel: ExtensionStdioJsonChannel;
  #sequence = 0;
  #closed = false;

  private constructor(channel: ExtensionStdioJsonChannel, challenge: string) {
    this.#channel = channel;
    this.sessionId = `extension-stdio:${createHash("sha256")
      .update(challenge, "utf8")
      .digest("hex")}`;
  }

  static async connect(
    streams: ExtensionStdioChannelStreams,
  ): Promise<ExtensionStdioTrustedBrowserSession> {
    const channel = new ExtensionStdioJsonChannel(streams);
    const challenge = randomBytes(32).toString("hex");
    const session = new ExtensionStdioTrustedBrowserSession(channel, challenge);
    const response = await session.#call({
      operation: "bind.hello",
      challenge,
      probeHashes: TRUSTED_PROBE_HASHES,
    });
    if (!isObject(response) || response.challenge !== challenge) {
      channel.close();
      throw new ExtensionStdioTransportError(
        "EXTENSION_HANDSHAKE_REJECTED",
        "Extension stdio parent did not echo the one-shot challenge.",
      );
    }
    return session;
  }

  async readRoot(timeoutMs: number): Promise<ProjectsRootProbe> {
    return this.#call({ operation: "bind.root", timeoutMs: normalizeTimeout(timeoutMs) }) as Promise<ProjectsRootProbe>;
  }

  async readIdentity(timeoutMs: number): Promise<IdentityProbe> {
    return this.#call({ operation: "bind.identity", timeoutMs: normalizeTimeout(timeoutMs) }) as Promise<IdentityProbe>;
  }

  async readProject(projectId: string, timeoutMs: number): Promise<ProjectPagesProbe> {
    if (!CANONICAL_ID.test(projectId)) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_PROJECT_ID_REJECTED",
        "Extension project probe requires a canonical ID captured from root.",
      );
    }
    return this.#call({
      operation: "bind.project",
      projectId,
      timeoutMs: normalizeTimeout(timeoutMs),
    }) as Promise<ProjectPagesProbe>;
  }

  async restoreRoot(timeoutMs: number): Promise<ProjectsRootProbe> {
    return this.#call({
      operation: "bind.restore",
      timeoutMs: normalizeTimeout(timeoutMs),
    }) as Promise<ProjectsRootProbe>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#call({ operation: "bind.close" }, true);
    } finally {
      this.#channel.close();
    }
  }

  async #call(
    fields: Omit<ExtensionStdioRequest, "version" | "sequence">,
    allowClosed = false,
  ): Promise<unknown> {
    if (this.#closed && !allowClosed) {
      throw new ExtensionStdioTransportError(
        "EXTENSION_CHANNEL_CLOSED",
        "Extension stdio session is closed.",
      );
    }
    const sequence = ++this.#sequence;
    const request: ExtensionStdioRequest = {
      version: EXTENSION_STDIO_PROTOCOL_VERSION,
      sequence,
      ...fields,
    };
    try {
      await this.#channel.send(request);
      const response = assertResponse(await this.#channel.receive(15_000), sequence);
      return response.result;
    } catch (error) {
      this.#closed = true;
      this.#channel.abort(error);
      throw error;
    }
  }
}

function assertPrivatePipe(fd: number, label: string): void {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 64) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_TRANSPORT_NOT_ATTACHED",
      `${label} is not a private inherited file descriptor.`,
    );
  }
  let metadata;
  try {
    metadata = fstatSync(fd);
  } catch {
    throw new ExtensionStdioTransportError(
      "EXTENSION_TRANSPORT_NOT_ATTACHED",
      `${label} is unavailable; extension-stdio must be spawned by the exact-tab broker.`,
    );
  }
  if (metadata.isFile() || metadata.isDirectory()) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_TRANSPORT_NOT_ATTACHED",
      `${label} must be an inherited pipe, not a filesystem object.`,
    );
  }
}

export interface ExtensionStdioChildConnectionOptions {
  /**
   * Set only when the fixed private marker was present in the bind child's
   * argv. Pipe possession and the challenge handshake remain authoritative.
   */
  readonly attachedByExactTabBroker: boolean;
}

export async function connectExtensionStdioTrustedBrowserSession(
  options: ExtensionStdioChildConnectionOptions,
): Promise<TrustedBrowserSession> {
  if (!options.attachedByExactTabBroker) {
    throw new ExtensionStdioTransportError(
      "EXTENSION_TRANSPORT_NOT_ATTACHED",
      "--transport=extension-stdio must be spawned by the exact claimed-tab browser broker.",
    );
  }
  const requestFd = 3;
  const responseFd = 4;
  assertPrivatePipe(requestFd, "Extension request pipe");
  assertPrivatePipe(responseFd, "Extension response pipe");
  const readable = new Socket({ fd: responseFd, readable: true, writable: false });
  const writable = new Socket({ fd: requestFd, readable: false, writable: true });
  let session: ExtensionStdioTrustedBrowserSession;
  try {
    session = await ExtensionStdioTrustedBrowserSession.connect({ readable, writable });
  } catch (error) {
    writable.destroy();
    readable.destroy();
    throw error;
  }
  let closed = false;
  return {
    transport: session.transport,
    sessionId: session.sessionId,
    readRoot: (timeoutMs) => session.readRoot(timeoutMs),
    readIdentity: (timeoutMs) => session.readIdentity(timeoutMs),
    readProject: (projectId, timeoutMs) => session.readProject(projectId, timeoutMs),
    restoreRoot: (timeoutMs) => session.restoreRoot(timeoutMs),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await session.close();
      } finally {
        writable.destroy();
        readable.destroy();
      }
    },
  };
}
