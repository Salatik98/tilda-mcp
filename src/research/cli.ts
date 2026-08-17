#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { inventoryProjects } from "./inventory.js";
import { getTildaStatus } from "./status.js";

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const config = loadConfig();

  switch (command) {
    case "status": {
      const status = await getTildaStatus(config);
      print(status);
      process.exitCode = status.ok ? 0 : 2;
      return;
    }
    case "inventory": {
      const inventory = await inventoryProjects(config);
      print(inventory);
      return;
    }
    case "canary": {
      const modeIndex = process.argv.indexOf("--mode");
      const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "safe";
      if (mode !== "safe") {
        throw new Error("Only the read-only safe canary mode is implemented before lab allowlisting.");
      }
      const status = await getTildaStatus(config);
      print({
        mode,
        passed: status.ok && status.tilda.authentication === "authenticated",
        checks: {
          C00: {
            passed: status.cdp.reachable && status.tilda.authentication === "authenticated",
            summary: "CDP connection and authenticated Tilda session",
          },
          C01: {
            passed: status.editorFingerprint !== null,
            summary: "Editor fingerprint captured",
          },
        },
        status,
      });
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  print({
    ok: false,
    error: {
      code: error instanceof Error && "code" in error ? String(error.code) : "CLI_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
