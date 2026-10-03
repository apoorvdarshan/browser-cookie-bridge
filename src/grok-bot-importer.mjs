#!/usr/bin/env node
// Compatibility entry point for existing Grok Bot callers.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cloud-transfer-importer.mjs";
export * from "./cloud-transfer-importer.mjs";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message || String(error)); process.exitCode = 1; });
}
