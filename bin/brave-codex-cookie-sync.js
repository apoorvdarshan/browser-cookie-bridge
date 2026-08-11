#!/usr/bin/env node

import { main } from "../src/cli.js";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
}).finally(() => {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
});
