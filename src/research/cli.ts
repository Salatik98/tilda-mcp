#!/usr/bin/env node
import { loadConfig, persistLocalBinding } from "./config.js";
import {
  captureTrustedLiveBinding,
  captureTrustedLiveBindingFromExtensionStdio,
  inventoryProjects,
  type TrustedCaptureProgress,
} from "./inventory.js";
import { ExtensionStdioTransportError } from "./transports/extension-stdio.js";
import { buildSafetyStatus, getTildaStatus } from "./status.js";
import { launchTildaBrowser } from "../control/browser-launch.js";

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const config = loadConfig();

  switch (command) {
    case "browser": {
      print(await launchTildaBrowser(config.cdpUrl));
      return;
    }
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
    case "bind": {
      const persist = process.argv.includes("--persist");
      const diagnosticProgress = process.argv.includes("--diagnostic-progress");
      const transportArgument = process.argv.find((argument) => argument.startsWith("--transport="));
      const transport = transportArgument?.slice("--transport=".length) ?? "loopback-cdp";
      if (transport !== "loopback-cdp" && transport !== "extension-stdio") {
        throw new Error("Unknown bind transport; only loopback-cdp and extension-stdio are allowed.");
      }
      if (transport === "extension-stdio" && persist) {
        throw new ExtensionStdioTransportError(
          "EXTENSION_PERSIST_REQUIRES_SEPARATE_REVIEW",
          "The extension-tab broker is dry-bind only; persistence requires a separately reviewed second-run capability.",
        );
      }
      const captureOptions = diagnosticProgress
        ? {
            createBindingKey: true,
            onProgress: (event: TrustedCaptureProgress): void => {
              process.stderr.write(`[trusted-bind] ${JSON.stringify(event)}\n`);
            },
          }
        : { createBindingKey: true };
      const capture =
        transport === "extension-stdio"
          ? await captureTrustedLiveBindingFromExtensionStdio(
              config,
              process.argv.includes("--extension-private-stdio=v1"),
              captureOptions,
            )
          : await captureTrustedLiveBinding(
              config,
              captureOptions,
            );
      if (capture.status === "BLOCKED") {
        print({ ok: false, persisted: false, binding: capture });
        process.exitCode = 2;
        return;
      }

      const prospectiveConfig = {
        ...config,
        accountFingerprint: capture.accountFingerprint,
        inventoryHash: capture.inventoryHash,
      };
      const prospectiveSafety = buildSafetyStatus(
        prospectiveConfig,
        capture,
      );
      if (
        !prospectiveSafety.writePreflightWouldPass ||
        !prospectiveSafety.pageWritePreflightWouldPass
      ) {
        print({
          ok: false,
          persisted: false,
          binding: {
            status: "BLOCKED",
            code: "ALLOWLIST_CLASSIFICATION_MISMATCH",
            message:
              "The captured account is not completely covered by the permanent source denylist, lab allowlist, and exact lab page tuples.",
          },
          prospectiveSafety,
        });
        process.exitCode = 2;
        return;
      }

      if (persist) {
        await persistLocalBinding(config, {
          accountFingerprint: capture.accountFingerprint,
          inventoryHash: capture.inventoryHash,
        });
      }
      print({
        ok: true,
        persisted: persist,
        binding: capture,
        prospectiveSafety,
      });
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
