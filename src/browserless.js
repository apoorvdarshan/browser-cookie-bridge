import path from "node:path";
import { spawn } from "node:child_process";
import { projectRoot } from "./paths.js";

const SUPPORTED_SOURCES = new Set(["brave", "chrome", "edge", "arc", "vivaldi", "opera"]);
const REGIONS = new Set(["sfo", "lon", "ams"]);

export async function uploadBrowserlessProfile({
  browser,
  localProfile,
  profileName,
  region = "sfo",
  onlyDomains = [],
  token = process.env.BROWSERLESS_TOKEN,
  root = projectRoot(),
  runner = runCLI,
} = {}) {
  if (!SUPPORTED_SOURCES.has(browser)) {
    throw new Error(`${browser === "comet" ? "Comet" : browser} is not supported by Browserless profile capture yet.`);
  }
  if (!localProfile) throw new Error("The local browser profile could not be determined.");
  if (!profileName?.trim()) throw new Error("Choose a Browserless cloud profile name.");
  if (!REGIONS.has(region)) throw new Error("Browserless region must be sfo, lon, or ams.");
  if (!token?.trim()) throw new Error("Connect Browserless first. The API token is missing from macOS Keychain.");

  const cliPath = path.join(root, "node_modules", "@browserless.io", "cli", "build", "cli.js");
  const runnerPath = path.join(root, "src", "browserless-runner.js");
  const environment = {
    ...process.env,
    BROWSERLESS_TOKEN: token.trim(),
    BROWSERLESS_ACCEPT_TERMS: "1",
    BROWSERLESS_TELEMETRY_DISABLED: "1",
    BROWSERLESS_DISABLE_KEYCHAIN: "1",
    DO_NOT_TRACK: "1",
  };
  const client = ["--region", region, "--json"];
  const shown = await runner(cliPath, ["profile", "show", profileName.trim(), ...client], environment, runnerPath);
  const operation = shown.status === 0 ? "refresh" : isMissingProfile(shown.output) ? "upload" : null;
  if (!operation) throw new Error(lastLine(shown.output) || "Browserless could not validate the cloud profile.");

  const capture = [
    "profile", operation,
    "--browser", browser,
    "--profile", localProfile,
    "--name", profileName.trim(),
    ...client,
    "--accept-terms",
    "--auto-fit",
  ];
  for (const domain of onlyDomains) capture.push("--only-domain", domain);
  const result = await runner(cliPath, capture, environment, runnerPath);
  if (result.status !== 0) throw new Error(lastLine(result.output) || "Browserless profile upload failed.");

  const details = parseJSON(result.output);
  const cookies = details?.cookieCount;
  const origins = details?.originCount;
  const counts = Number.isInteger(cookies) && Number.isInteger(origins)
    ? ` (${cookies} cookies, ${origins} origins)`
    : "";
  return {
    operation,
    profileName: details?.name || profileName.trim(),
    cookieCount: cookies,
    originCount: origins,
    summary: `Browserless profile ${operation === "refresh" ? "updated" : "created"}: ${details?.name || profileName.trim()}${counts}`,
  };
}

function runCLI(cliPath, args, environment, runnerPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, cliPath, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, output: `${stderr}${stdout}` }));
  });
}

function isMissingProfile(output) {
  return /(?:not found|does not exist|404)/i.test(output);
}

function parseJSON(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  for (const line of output.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function lastLine(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1)?.replace(/^Error:\s*/, "");
}
