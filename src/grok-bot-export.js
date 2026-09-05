import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readChromiumProfile } from "./chromium-reader.js";
import { createZipArchive, readZipArchive } from "./zip-store.js";

export const BUNDLE_EXTENSION = "bcbx";
export const DEFAULT_BUNDLE_NAME = "GrokBot-Import.bcbx";
export const GROK_BOT_PROMPT = `On your Grok Bot cloud computer only — do not access my local Mac and do not print cookie values.

1. Save the attached GrokBot-Import.bcbx to the cloud computer.
2. Unzip it: unzip -o GrokBot-Import.bcbx -d bcb-import && cd bcb-import
3. Run: node import.mjs
4. When prompted, ask me to take over and type the one-time decryption key privately through Agent Computer.
5. Report only how many cookies were imported per domain, then delete the bcb-import folder and any copies of the bundle.`;

const KDF = { name: "scrypt", N: 16384, r: 8, p: 1, keyLength: 32 };
const SAME_SITE = {
  unspecified: "unspecified",
  no_restriction: "no_restriction",
  lax: "lax",
  strict: "strict",
};

export function buildGrokBotBundle({
  cookies,
  sourceBrowser,
  onlyDomains = [],
  passphrase = generatePassphrase(),
  now = new Date(),
  importerSource = defaultImporterSource(),
} = {}) {
  if (!Array.isArray(cookies)) throw new Error("Cookie export requires a cookie list.");
  const filtered = filterCookies(cookies, onlyDomains);
  const exportCookies = filtered.map(normalizeExportCookie).filter(Boolean);
  if (exportCookies.length === 0) {
    throw new Error(onlyDomains.length
      ? "No cookies matched the selected domains."
      : "No exportable cookies were found in the source browser.");
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p });
  const payload = Buffer.from(JSON.stringify({ cookies: exportCookies }), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);

  const domains = uniqueDomains(exportCookies);
  const manifest = {
    format: "browser-cookie-bridge-grok-bot",
    version: 1,
    createdAt: now.toISOString(),
    sourceBrowser,
    cookieCount: exportCookies.length,
    domainCount: domains.length,
    domains,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: encrypted.subarray(encrypted.length - 16).toString("base64url"),
    kdf: KDF,
  };
  const payloadBody = encrypted.subarray(0, encrypted.length - 16);

  const archive = createZipArchive([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    { name: "payload.enc", data: payloadBody },
    { name: "import.mjs", data: Buffer.from(importerSource, "utf8") },
    { name: "PROMPT.txt", data: Buffer.from(`${GROK_BOT_PROMPT}\n`, "utf8") },
  ]);

  return {
    archive,
    manifest,
    passphrase,
    cookieCount: exportCookies.length,
    domainCount: domains.length,
    domains,
    sourceBrowser,
    bundleName: DEFAULT_BUNDLE_NAME,
  };
}

export function writeGrokBotBundle({
  outputPath,
  cookies,
  sourceBrowser,
  onlyDomains = [],
  passphrase,
} = {}) {
  const resolved = path.resolve(outputPath || DEFAULT_BUNDLE_NAME);
  if (!resolved.endsWith(`.${BUNDLE_EXTENSION}`)) {
    throw new Error(`Grok Bot bundles must use the .${BUNDLE_EXTENSION} extension.`);
  }
  const bundle = buildGrokBotBundle({ cookies, sourceBrowser, onlyDomains, passphrase });
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, bundle.archive);
  fs.chmodSync(resolved, 0o600);
  return {
    outputPath: resolved,
    passphrase: bundle.passphrase,
    cookieCount: bundle.cookieCount,
    domainCount: bundle.domainCount,
    domains: bundle.domains,
    sourceBrowser: bundle.sourceBrowser,
    prompt: GROK_BOT_PROMPT,
  };
}

export function exportGrokBotBundleFromProfile({
  browser,
  onlyDomains = [],
  outputPath,
  passphrase,
} = {}) {
  const payload = readChromiumProfile({
    browser,
    imports: { cookies: true, history: false },
  });
  const result = writeGrokBotBundle({
    outputPath,
    cookies: payload.cookies,
    sourceBrowser: browser,
    onlyDomains,
    passphrase,
  });
  return {
    ...result,
    sourceCookieSkipped: payload.cookieStats.skipped,
    sourceCookieTotal: payload.cookieStats.total,
  };
}

export function parseGrokBotBundle(buffer) {
  const entries = readZipArchive(buffer);
  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  return {
    manifest,
    payload: entries.get("payload.enc"),
    importer: entries.get("import.mjs")?.toString("utf8") || "",
    prompt: entries.get("PROMPT.txt")?.toString("utf8") || "",
  };
}

export function grokBotSummary(result) {
  const domainNote = result.domainCount === 1 ? "1 domain" : `${result.domainCount} domains`;
  const skipped = result.sourceCookieSkipped
    ? ` ${result.sourceCookieSkipped} source cookie${result.sourceCookieSkipped === 1 ? " was" : "s were"} unreadable or unsupported.`
    : "";
  return `Grok Bot transfer file created: ${result.cookieCount} cookies across ${domainNote} from ${result.sourceBrowser}.${skipped} Attach ${path.basename(result.outputPath)} to any Grok Bot, paste the prompt, then enter the one-time key privately when asked.`;
}

export function filterCookies(cookies, onlyDomains = []) {
  const domains = normalizeDomainFilters(onlyDomains);
  if (!domains.length) return cookies;
  return cookies.filter((cookie) => cookieMatchesDomains(cookie, domains));
}

export function normalizeDomainFilters(onlyDomains) {
  const items = Array.isArray(onlyDomains) ? onlyDomains : String(onlyDomains || "").split(",");
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

export function cookieMatchesDomains(cookie, domains) {
  const host = String(cookie?.domain || "").replace(/^\./, "").toLowerCase();
  if (!host) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function normalizeExportCookie(cookie) {
  if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") return null;
  if (typeof cookie.domain !== "string") return null;
  const host = cookie.domain.replace(/^\./, "").trim().toLowerCase();
  if (!host || host.includes("/") || host.includes(":")) return null;
  const persistent = !cookie.session && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? host : `.${host}`,
    path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: SAME_SITE[cookie.sameSite] || "unspecified",
    ...(persistent ? { expires: Math.trunc(cookie.expirationDate) } : {}),
  };
}

function uniqueDomains(cookies) {
  return [...new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, "").toLowerCase()))].sort();
}

function generatePassphrase() {
  return crypto.randomBytes(18).toString("base64url");
}

function defaultImporterSource() {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "grok-bot-importer.mjs"), "utf8");
}
