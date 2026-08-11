import fs from "node:fs";
import os from "node:os";
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
  runner = runBrowserlessCLI,
  signal,
  timeoutMs = 15 * 60 * 1000,
  onProgress = () => {},
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
  onProgress({ phase: "validating", fraction: 0.10, detail: "Checking the destination profile…" });
  const shown = await runner(
    cliPath,
    ["profile", "show", profileName.trim(), ...client],
    environment,
    runnerPath,
    { signal, timeoutMs: Math.min(timeoutMs, 60_000) },
  );
  throwForInterruptedRun(shown, timeoutMs);
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
  const parseProgress = progressParser(onProgress);
  const result = await runner(cliPath, capture, environment, runnerPath, {
    signal,
    timeoutMs,
    onOutput: parseProgress,
  });
  parseProgress("\n");
  throwForInterruptedRun(result, timeoutMs);
  if (result.status !== 0) throw new Error(actionableFailure(result.output));

  onProgress({ phase: "verifying", fraction: 0.97, detail: "Verifying the cloud profile…" });
  const verified = await runner(
    cliPath,
    ["profile", "show", profileName.trim(), ...client],
    environment,
    runnerPath,
    { signal, timeoutMs: Math.min(timeoutMs, 60_000) },
  );
  throwForInterruptedRun(verified, timeoutMs);
  if (verified.status !== 0) {
    throw new Error(`The upload finished, but Browserless could not verify the cloud profile: ${lastLine(verified.output) || "profile lookup failed"}`);
  }

  const details = parseJSON(result.output);
  const cookies = details?.cookieCount;
  const origins = details?.originCount;
  const counts = Number.isInteger(cookies) && Number.isInteger(origins)
    ? ` (${cookies} cookies, ${origins} origins)`
    : "";
  return {
    operation,
    verified: true,
    profileName: details?.name || profileName.trim(),
    cookieCount: cookies,
    originCount: origins,
    droppedOriginCount: droppedOrigins(result.output),
    failedOriginCount: failedOrigins(result.output),
    summary: uploadSummary({ operation, details, fallbackName: profileName.trim(), counts, output: result.output }),
  };
}

export function runBrowserlessCLI(cliPath, args, environment, runnerPath, {
  signal,
  timeoutMs = 15 * 60 * 1000,
  onOutput = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-browserless-"));
    fs.chmodSync(temporaryRoot, 0o700);
    const child = spawn(process.execPath, [runnerPath, cliPath, ...args], {
      env: { ...environment, TMPDIR: temporaryRoot },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let interruption = null;
    let settled = false;
    const append = (target, chunk) => {
      const text = String(chunk);
      if (target === "stdout") stdout += text;
      else stderr += text;
      onOutput(text);
    };
    const terminate = (reason) => {
      if (settled || interruption) return;
      interruption = reason;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 2_000).unref();
    };
    const abort = () => terminate("canceled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => terminate("timedOut"), timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      reject(error);
    });
    child.on("close", (status) => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      resolve({
        status: interruption === "canceled" ? 130 : interruption === "timedOut" ? 124 : (status ?? 1),
        output: `${stderr}${stdout}`,
        canceled: interruption === "canceled",
        timedOut: interruption === "timedOut",
      });
    });
  });
}

export function progressParser(onProgress) {
  let pending = "";
  let lastPhase = "";
  return (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r\n|\n|\r/);
    pending = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      let progress = null;
      if (/copying profile data/i.test(line)) {
        progress = { phase: "copying", fraction: 0.18, detail: "Copying profile data into an isolated workspace…" };
      } else if (/launching headless browser/i.test(line)) {
        progress = { phase: "launching", fraction: 0.30, detail: "Launching the temporary browser…" };
      } else if (/waiting for browser to be ready/i.test(line)) {
        progress = { phase: "waiting", fraction: 0.38, detail: "Waiting for the temporary browser…" };
      } else if (/capturing per-origin storage/i.test(line)) {
        progress = { phase: "capturing", fraction: 0.42, detail: "Capturing cookies, local storage, and IndexedDB…" };
      } else if (/^\d+\/\d+\s+/.test(line)) {
        const match = line.match(/^(\d+)\/(\d+)\s+(.+)$/);
        if (match) {
          const current = Number(match[1]);
          const total = Number(match[2]);
          progress = {
            phase: "capturing",
            fraction: total > 0 ? 0.42 + 0.42 * Math.min(current / total, 1) : 0.42,
            current,
            total,
            detail: `Capturing ${match[3]}`,
          };
        }
      } else if (/uploading to browserless/i.test(line)) {
        progress = { phase: "uploading", fraction: 0.90, detail: "Uploading the fitted authenticated profile…" };
      }
      if (!progress) continue;
      const identity = `${progress.phase}:${progress.current ?? ""}:${progress.total ?? ""}:${progress.detail}`;
      if (identity === lastPhase) continue;
      lastPhase = identity;
      onProgress(progress);
    }
  };
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

function throwForInterruptedRun(result, timeoutMs) {
  if (result?.canceled || result?.status === 130) {
    throw new Error("Browserless upload canceled. Temporary profile data was removed.");
  }
  if (result?.timedOut || result?.status === 124) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    throw new Error(`Browserless upload timed out after ${minutes} minute${minutes === 1 ? "" : "s"}. Check the connection, close the source browser, and try again with a smaller domain allowlist.`);
  }
}

function droppedOrigins(output) {
  return Number(output.match(/--auto-fit:\s*dropped\s+(\d+)\s+origin/i)?.[1] || 0);
}

function failedOrigins(output) {
  return Number(output.match(/!\s+(\d+)\s+origin\(s\) failed to capture/i)?.[1] || 0);
}

function uploadSummary({ operation, details, fallbackName, counts, output }) {
  const dropped = droppedOrigins(output);
  const failed = failedOrigins(output);
  const warnings = [];
  if (dropped > 0) warnings.push(`${dropped} heavy origin${dropped === 1 ? "" : "s"} omitted to fit Browserless's 2 MB cap`);
  if (failed > 0) warnings.push(`${failed} origin${failed === 1 ? "" : "s"} could not be captured`);
  const warning = warnings.length > 0 ? `; ${warnings.join("; ")}` : "";
  return `Browserless profile ${operation === "refresh" ? "updated" : "created"} and verified: ${details?.name || fallbackName}${counts}${warning}`;
}

function actionableFailure(output) {
  const detail = lastLine(output) || "Browserless profile upload failed.";
  if (/(?:failed to reach|enotfound|econnreset|econnrefused|network|socket hang up|fetch failed)/i.test(output)) {
    return `Browserless could not be reached. Check your internet connection and region, then try again. ${detail}`;
  }
  if (/(?:profile busy|singletonlock|browser.*running|source browser must be closed)/i.test(output)) {
    return `The source browser is still using this profile. Quit it completely, wait a few seconds, and try again. ${detail}`;
  }
  if (/(?:2 MB|too large|artifact.*cap|payload.*large)/i.test(output)) {
    return `The captured state could not fit Browserless's 2 MB profile cap. Add a domain allowlist for the sites you need, then try again. ${detail}`;
  }
  return detail;
}
