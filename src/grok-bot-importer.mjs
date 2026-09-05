#!/usr/bin/env node
/**
 * One-time Grok Bot cookie importer for Browser Cookie Bridge bundles.
 * Run on the Grok Bot cloud computer only. Never log cookie names or values.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

const CDP_PORTS = [9222, 9223, 9224, 9228, 9229, 9400];
const SAME_SITE = {
  unspecified: "Lax",
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
};

export async function main(argv = process.argv.slice(2)) {
  const bundlePath = path.resolve(argv[0] || "GrokBot-Import.bcbx");
  const bundleDir = path.dirname(bundlePath);
  const manifestPath = path.join(bundleDir, "manifest.json");
  const payloadPath = path.join(bundleDir, "payload.enc");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(payloadPath)) {
    throw new Error("Expected manifest.json and payload.enc next to the bundle. Unzip GrokBot-Import.bcbx first.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  const passphrase = await readPassphrase();
  const cookies = decryptPayload({
    manifest,
    encrypted: fs.readFileSync(payloadPath),
    passphrase,
  });
  const endpoint = await findDevToolsEndpoint();
  const imported = await injectCookies(endpoint.webSocketDebuggerUrl, cookies);
  reportSummary(imported, manifest.domains || []);
  cleanup(bundleDir, bundlePath);
}

export function validateManifest(manifest) {
  if (manifest?.format !== "browser-cookie-bridge-grok-bot" || manifest?.version !== 1) {
    throw new Error("Unsupported Browser Cookie Bridge Grok Bot bundle.");
  }
  for (const key of ["salt", "iv", "authTag"]) {
    if (typeof manifest[key] !== "string" || !manifest[key]) {
      throw new Error(`Bundle manifest is missing ${key}.`);
    }
  }
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

export async function findDevToolsEndpoint() {
  for (const port of CDP_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const body = await response.json();
      if (typeof body?.webSocketDebuggerUrl === "string") {
        return { port, webSocketDebuggerUrl: body.webSocketDebuggerUrl, browser: body.Browser || "Chrome" };
      }
    } catch {
      // Try the next port.
    }
  }
  throw new Error("No local Chrome DevTools endpoint responded. Run the safe probe first.");
}

export async function injectCookies(webSocketDebuggerUrl, cookies) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await waitForOpen(ws);
  let nextId = 1;
  const cdpCookies = cookies.map(toCdpCookie);
  const chunks = chunk(cdpCookies, 40);
  let imported = 0;
  for (const batch of chunks) {
    const id = nextId++;
    const response = await sendCommand(ws, { id, method: "Storage.setCookies", params: { cookies: batch } });
    if (response.error) throw new Error(`Cookie injection failed: ${response.error.message}`);
    imported += batch.length;
  }
  ws.close();
  return { imported, batches: chunks.length };
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
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (event) => reject(event.error || new Error("DevTools connection failed")), { once: true });
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
  for (const name of ["manifest.json", "payload.enc", "import.mjs", "PROMPT.txt"]) {
    fs.rmSync(path.join(bundleDir, name), { force: true });
  }
  fs.rmSync(bundlePath, { force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
