import { runTildaMcpStdio } from "./server.js";
import { createDefaultTildaMcpService } from "./engine-service.js";

runTildaMcpStdio(createDefaultTildaMcpService()).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`tilda-agent-os MCP failed to start: ${message}\n`);
  process.exitCode = 1;
});
