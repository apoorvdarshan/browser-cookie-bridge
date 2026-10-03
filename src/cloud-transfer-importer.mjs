#!/usr/bin/env node
/**
 * One-time cloud-browser cookie importer for Browser Cookie Bridge bundles.
 * Run on the selected destination cloud computer only. Never log cookie names or values.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

const CDP_PORTS = [9222, 9223, 9224, 9228, 9229, 9400];
const EMBEDDED_KEY_FILENAME = "decryption.key";
const SAME_SITE = {
  unspecified: "Lax",
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
};

export async function main(argv = process.argv.slice(2)) {
  const { bundlePath: suppliedBundlePath, cdpUrl, browserContextId } = parseArguments(argv);
  // Preserve legacy positional bundle paths; --bundle refers to the archive outside the extracted folder.
  const bundleDir = suppliedBundlePath && argv[0] === suppliedBundlePath
    ? path.dirname(path.resolve(suppliedBundlePath)) : process.cwd();
  const manifestPath = path.join(bundleDir, "manifest.json");
  const payloadPath = path.join(bundleDir, "payload.enc");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(payloadPath)) {
    throw new Error("Expected manifest.json and payload.enc in the current directory. Unzip the .bcbx file into a private folder first.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  if (manifest.format === "browser-cookie-bridge-dots" && process.platform !== "linux") {
    throw new Error("Run this importer on your dot's Linux cloud computer, not your local Mac.");
  }
  const bundlePath = path.resolve(suppliedBundlePath
    || (manifest.format === "browser-cookie-bridge-dots" ? "Dots-Import.bcbx" : "GrokBot-Import.bcbx"));
  const passphrase = await resolveDecryptionKey({ manifest, bundleDir });
  const cookies = decryptPayload({
    manifest,
    encrypted: fs.readFileSync(payloadPath),
    passphrase,
  });
  const endpoint = await findDevToolsEndpoint({ cdpUrl });
  const imported = await injectCookies(endpoint.webSocketDebuggerUrl, cookies, {
    browserContextId, requireContextSelection: manifest.format === "browser-cookie-bridge-dots",
  });
  reportSummary(imported, manifest.domains || []);
  cleanup(bundleDir, bundlePath);
}

export function validateManifest(manifest) {
  if (!["browser-cookie-bridge-grok-bot", "browser-cookie-bridge-dots"].includes(manifest?.format)) {
    throw new Error("Unsupported Browser Cookie Bridge cloud transfer bundle.");
  }
  if (manifest?.version !== 1 && manifest?.version !== 2) {
    throw new Error("Unsupported Browser Cookie Bridge cloud transfer bundle version.");
  }
  for (const key of ["salt", "iv", "authTag"]) {
    if (typeof manifest[key] !== "string" || !manifest[key]) {
      throw new Error(`Bundle manifest is missing ${key}.`);
    }
  }
}

export async function resolveDecryptionKey({ manifest, bundleDir }) {
  if (manifest.version === 2) {
    if (manifest.keyDelivery !== "embedded") {
      throw new Error("Unsupported cloud transfer bundle key delivery method.");
    }
    const keyFile = typeof manifest.keyFile === "string" && manifest.keyFile
      ? manifest.keyFile
      : EMBEDDED_KEY_FILENAME;
    const keyPath = path.join(bundleDir, keyFile);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Embedded decryption key file is missing: ${keyFile}`);
    }
    const key = fs.readFileSync(keyPath, "utf8").trim();
    if (!key) throw new Error("Embedded decryption key file is empty.");
    return key;
  }

  return readPassphrase();
}

export function decryptPayload({ manifest, encrypted, passphrase }) {
  const key = crypto.scryptSync(
    passphrase,
    Buffer.from(manifest.salt, "base64url"),
    32,
    { N: manifest.kdf?.N ?? 16384, r: manifest.kdf?.r ?? 8, p: manifest.kdf?.p ?? 1 },
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(manifest.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(manifest.authTag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const payload = JSON.parse(plaintext.toString("utf8"));
  if (!Array.isArray(payload.cookies)) throw new Error("Decrypted bundle did not contain cookies.");
  return payload.cookies;
}

export function parseArguments(argv) {
  let bundlePath;
  let cdpUrl;
  let browserContextId;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (["--bundle", "--cdp-url", "--browser-context-id"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
      if (argument === "--bundle") bundlePath = value;
      else if (argument === "--cdp-url") cdpUrl = value;
      else browserContextId = value;
    } else if (!argument.startsWith("--") && !bundlePath) {
      bundlePath = argument;
    } else {
      throw new Error("Usage: node import.mjs [--bundle ../Transfer.bcbx] [--cdp-url LOOPBACK_URL] [--browser-context-id ID_OR_default]");
    }
  }
  return { bundlePath, cdpUrl, browserContextId };
}

export function validateDevToolsUrl(value) {
  const url = new URL(value);
  if (!["http:", "ws:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password) {
    throw new Error("The DevTools endpoint must be a local loopback HTTP or WebSocket URL.");
  }
  if (url.protocol === "ws:" && !url.pathname.startsWith("/devtools/browser/")) {
    throw new Error("Use the managed browser's DevTools browser endpoint, not a page endpoint.");
  }
  return url;
}

export async function findDevToolsEndpoint({ cdpUrl, ports = CDP_PORTS } = {}) {
  if (cdpUrl) {
    const url = validateDevToolsUrl(cdpUrl);
    if (url.protocol === "ws:") return { webSocketDebuggerUrl: url.href };
    return readDevToolsEndpoint(url.origin);
  }
  const endpoints = [];
  for (const port of ports) {
    try {
      endpoints.push(await readDevToolsEndpoint(`http://127.0.0.1:${port}`));
    } catch {
      // Try the next port.
    }
  }
  if (endpoints.length === 1) return endpoints[0];
  if (endpoints.length > 1) throw new Error("Multiple browsers expose DevTools. Pass --cdp-url for your existing managed cloud browser.");
  throw new Error("No local Chrome DevTools endpoint responded. Pass --cdp-url for your existing managed cloud browser; if unavailable, stop. Do not launch a separate browser.");
}

async function readDevToolsEndpoint(origin) {
  const response = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1500), redirect: "error" });
  if (!response.ok) throw new Error("The managed browser's DevTools endpoint did not respond.");
  const body = await response.json();
  const url = validateDevToolsUrl(body.webSocketDebuggerUrl);
  if (url.protocol !== "ws:") throw new Error("DevTools did not return a browser WebSocket endpoint.");
  return { webSocketDebuggerUrl: url.href };
}

export async function injectCookies(webSocketDebuggerUrl, cookies, { browserContextId, requireContextSelection = false } = {}) {
  const url = validateDevToolsUrl(webSocketDebuggerUrl);
  if (url.protocol !== "ws:") throw new Error("Cookie injection requires a loopback browser WebSocket endpoint.");
  const ws = new WebSocket(url.href);
  try {
    await waitForOpen(ws);
    let nextId = 1;
    if (requireContextSelection || browserContextId) {
      const response = await sendCommand(ws, { id: nextId++, method: "Target.getBrowserContexts" });
      const contexts = response.result?.browserContextIds;
      if (response.error || !Array.isArray(contexts)) throw new Error("Could not identify the managed browser context. Transfer files were kept for retry.");
      if (!browserContextId && contexts.length) {
        throw new Error("The browser has separate contexts. Identify your dot's managed browser context and pass --browser-context-id (use default only for the default context).");
      }
      if (browserContextId && browserContextId !== "default"
          && ![...contexts, response.result.defaultBrowserContextId].includes(browserContextId)) {
        throw new Error("The selected browser context is unavailable. Transfer files were kept for retry.");
      }
    }
    const cdpCookies = cookies.map(toCdpCookie);
    const chunks = chunk(cdpCookies, 40);
    let imported = 0;
    for (const batch of chunks) {
      const id = nextId++;
      const response = await sendCommand(ws, {
        id, method: "Storage.setCookies", params: {
          cookies: batch,
          ...(browserContextId && browserContextId !== "default" ? { browserContextId } : {}),
        },
      });
      // Browser errors may echo cookie parameters; keep credentials out of diagnostics.
      if (response.error) throw new Error("Cookie injection failed in the managed cloud browser. Transfer files were kept for retry.");
      imported += batch.length;
    }
    return { imported, batches: chunks.length };
  } finally {
    ws.close();
  }
}

function toCdpCookie(cookie) {
  const entry = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: SAME_SITE[cookie.sameSite] || cookie.sameSite || "Lax",
  };
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) entry.expires = cookie.expires;
  return entry;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

async function readPassphrase() {
  if (process.env.BCB_IMPORT_KEY?.trim()) return process.env.BCB_IMPORT_KEY.trim();
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question("One-time decryption key: ")).trim();
  } finally {
    rl.close();
  }
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("DevTools connection timed out")), 15000);
    ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("DevTools connection failed")); }, { once: true });
  });
}

function sendCommand(ws, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("DevTools command timed out")), 15000);
    const onMessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== message.id) return;
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      resolve(payload);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify(message));
  });
}

function reportSummary(result, domains) {
  const domainNote = domains.length ? `${domains.length} selected domain${domains.length === 1 ? "" : "s"}` : "all exported domains";
  console.log(`Imported ${result.imported} cookies across ${domainNote} in ${result.batches} batch${result.batches === 1 ? "" : "es"}.`);
}

function cleanup(bundleDir, bundlePath) {
  for (const name of ["manifest.json", "payload.enc", EMBEDDED_KEY_FILENAME, "import.mjs", "PROMPT.txt"]) {
    fs.rmSync(path.join(bundleDir, name), { force: true });
  }
  if (bundlePath) fs.rmSync(bundlePath, { force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
