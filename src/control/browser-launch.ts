import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getCdpVersion, normalizeLoopbackCdpBaseUrl } from "../research/cdp-client.js";

export interface TildaBrowserLaunchResult {
  readonly launched: boolean;
  readonly alreadyRunning: boolean;
  readonly cdpUrl: string;
  readonly profileDirectory: string;
}

function candidateChromePaths(): readonly string[] {
  return [
    process.env.PROGRAMFILES === undefined
      ? ""
      : resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] === undefined
      ? ""
      : resolve(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA === undefined
      ? ""
      : resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  ].filter((value) => value !== "");
}

function findChromeExecutable(): string {
  const executable = candidateChromePaths().find((candidate) => existsSync(candidate));
  if (executable === undefined) {
    throw new Error("Google Chrome executable was not found in a standard Windows location.");
  }
  return executable;
}

export function buildTildaBrowserLaunchPlan(cdpUrl: string): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly profileDirectory: string;
} {
  const endpoint = new URL(normalizeLoopbackCdpBaseUrl(cdpUrl));
  const port = endpoint.port === "" ? "80" : endpoint.port;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new Error("LOCALAPPDATA is required for the dedicated Tilda browser profile.");
  }
  const profileDirectory = resolve(localAppData, "TildaAgentOS/ChromeProfile");
  return {
    executable: findChromeExecutable(),
    profileDirectory,
    args: [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "https://tilda.ru/projects/",
    ],
  };
}

export async function launchTildaBrowser(cdpUrl: string): Promise<TildaBrowserLaunchResult> {
  const normalized = normalizeLoopbackCdpBaseUrl(cdpUrl);
  try {
    await getCdpVersion(normalized);
    return {
      launched: false,
      alreadyRunning: true,
      cdpUrl: normalized,
      profileDirectory: buildTildaBrowserLaunchPlan(normalized).profileDirectory,
    };
  } catch {
    // A missing endpoint is the only reason to start the dedicated profile.
  }

  const plan = buildTildaBrowserLaunchPlan(normalized);
  mkdirSync(plan.profileDirectory, { recursive: true });
  const child = spawn(plan.executable, [...plan.args], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return {
    launched: true,
    alreadyRunning: false,
    cdpUrl: normalized,
    profileDirectory: plan.profileDirectory,
  };
}
