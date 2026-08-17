export interface CdpVersion {
  Browser: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

export class CdpUnavailableError extends Error {
  readonly code = "CDP_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CdpUnavailableError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

export function normalizeLoopbackCdpBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CdpUnavailableError("CDP URL is invalid.");
  }
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new CdpUnavailableError(
      "CDP must be an unauthenticated loopback HTTP endpoint (127.0.0.1, localhost, or ::1).",
    );
  }
  return parsed.origin;
}

export function isLoopbackCdpWebSocketUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "ws:" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function endpoint(baseUrl: string, path: string): URL {
  const normalized = normalizeLoopbackCdpBaseUrl(baseUrl);
  return new URL(path, `${normalized}/`);
}

async function fetchJson<T>(url: URL, timeoutMs = 3_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`CDP endpoint returned HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  } catch (error) {
    throw new CdpUnavailableError(`Unable to reach CDP at ${url.origin}.`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCdpVersion(baseUrl: string): Promise<CdpVersion> {
  return fetchJson<CdpVersion>(endpoint(baseUrl, "/json/version"));
}

export async function listCdpTargets(baseUrl: string): Promise<readonly CdpTarget[]> {
  return fetchJson<readonly CdpTarget[]>(endpoint(baseUrl, "/json/list"));
}

export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  #sequence = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("CDP connection closed."));
      }
      this.#pending.clear();
    });
  }

  static async connect(webSocketUrl: string, timeoutMs = 5_000): Promise<CdpConnection> {
    if (!isLoopbackCdpWebSocketUrl(webSocketUrl)) {
      throw new CdpUnavailableError("Refusing a non-loopback CDP WebSocket target.");
    }
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new CdpUnavailableError("Timed out opening CDP WebSocket."));
      }, timeoutMs);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new CdpUnavailableError("Failed to open CDP WebSocket."));
        },
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = ++this.#sequence;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command ${method} timed out.`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.#socket.send(JSON.stringify(payload));
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      result: { value?: T; description?: string; subtype?: string };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });

    if (response.exceptionDetails !== undefined) {
      throw new Error(`Runtime evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return response.result.value as T;
  }

  close(): void {
    this.#socket.close();
  }

  #handleMessage(raw: unknown): void {
    let parsed: CdpResponse | CdpEvent;
    try {
      parsed = JSON.parse(String(raw)) as CdpResponse | CdpEvent;
    } catch {
      return;
    }

    if ("id" in parsed) {
      const pending = this.#pending.get(parsed.id);
      if (pending === undefined) return;
      this.#pending.delete(parsed.id);
      if (parsed.error !== undefined) {
        pending.reject(new Error(`CDP ${parsed.error.code}: ${parsed.error.message}`));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    for (const listener of this.#listeners) listener(parsed);
  }
}

export function selectTildaTarget(targets: readonly CdpTarget[]): CdpTarget | null {
  const pages = targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl !== undefined &&
      isLoopbackCdpWebSocketUrl(target.webSocketDebuggerUrl),
  );
  return (
    pages.find((target) => {
      try {
        const host = new URL(target.url).hostname;
        return (
          host === "tilda.cc" ||
          host.endsWith(".tilda.cc") ||
          host === "tilda.ru" ||
          host.endsWith(".tilda.ru")
        );
      } catch {
        return false;
      }
    }) ?? null
  );
}

/**
 * Select only the top-level projects inventory route. A project detail or editor
 * tab is not sufficient evidence for a complete account inventory.
 */
export function selectTildaProjectsTarget(
  targets: readonly CdpTarget[],
): CdpTarget | null {
  return (
    targets.find((target) => {
      if (
        target.type !== "page" ||
        target.webSocketDebuggerUrl === undefined ||
        !isLoopbackCdpWebSocketUrl(target.webSocketDebuggerUrl)
      ) {
        return false;
      }
      try {
        const url = new URL(target.url);
        return (
          url.protocol === "https:" &&
          url.hostname === "tilda.ru" &&
          url.pathname === "/projects/" &&
          !url.searchParams.has("projectid") &&
          !url.searchParams.has("projectId")
        );
      } catch {
        return false;
      }
    }) ?? null
  );
}
