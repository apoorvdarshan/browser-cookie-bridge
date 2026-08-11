import { pathToFileURL } from "node:url";

const [, , cliPath, ...argumentsWithoutToken] = process.argv;
const token = process.env.BROWSERLESS_TOKEN?.trim();
if (!cliPath) throw new Error("Browserless CLI path is missing.");
if (!token) throw new Error("Browserless API token is missing.");

// Read the Keychain-supplied token once, then remove it before the official CLI
// launches a temporary browser. Mutating process.argv does not alter the OS
// command line that started this process, so the token is not exposed by `ps`.
delete process.env.BROWSERLESS_TOKEN;
process.argv = [process.execPath, cliPath, ...argumentsWithoutToken, "--token", token];
await import(pathToFileURL(cliPath).href);
