import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// The runtime directory is ignored and intentionally contains no checked-in
// state. Unit tests create only their own temporary roots beneath it.
mkdirSync(resolve(process.cwd(), ".tilda-runtime"), { recursive: true });
