import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readChromiumProfile } from "./chromium-reader.js";
import { createZipArchive, readZipArchive } from "./zip-store.js";

export const BUNDLE_EXTENSION = "bcbx";
export const CLOUD_TRANSFER_TARGETS = {
  "grok-bot": { name: "Grok Bot", bundleName: "GrokBot-Import.bcbx", configKey: "grokBot", resultPrefix: "BCB_GROK_RESULT" },
  dots: { name: "Dots", bundleName: "Dots-Import.bcbx", configKey: "dots", resultPrefix: "BCB_DOTS_RESULT" },
};

export function cloudTransferTarget(target = "grok-bot") {
  const destination = Object.hasOwn(CLOUD_TRANSFER_TARGETS, target) && CLOUD_TRANSFER_TARGETS[target];
  if (!destination) throw new Error(`Unsupported cloud transfer destination: ${target}`);
  return destination;
}

export function cloudTransferPrompt(target = "grok-bot") {
  const { bundleName } = cloudTransferTarget(target);
  if (target === "grok-bot") return GROK_BOT_PROMPT;
  return `On your Dots cloud computer only — do not access my local Mac and do not print cookie names, values, or keys.

1. Save the attached ${bundleName} to your cloud computer, then unzip it into a new private folder: umask 077; unzip ${bundleName} -d dots-bcb-import
2. Use your existing managed cloud browser, the same one shown under Open computer. Do not launch a separate browser or change its launch settings.
3. Run: cd dots-bcb-import && node import.mjs --bundle ../${bundleName}
4. The importer needs Node.js 22+ and a local Chrome DevTools endpoint. If discovery fails, find the existing managed browser's endpoint and pass --cdp-url http://127.0.0.1:PORT (or its loopback browser WebSocket URL). If that endpoint is unavailable, stop and report that import is unsupported in this environment.
5. If the importer reports separate browser contexts, identify the context of your managed browser and pass --browser-context-id with that ID (use default only for the default context). Stop if you cannot identify it.
6. Report only the imported cookie count. After success, the importer deletes its extracted files and the supplied bundle copy; remove any other copies. Never paste decrypted cookies into chat.`;
}
export const BUNDLE_FORMAT_VERSION = 2;
export const EMBEDDED_KEY_FILENAME = "decryption.key";

export const GROK_BOT_PROMPT = `On your Grok Bot cloud computer only — do not access my local Mac and do not print cookie values.

1. Save the attached GrokBot-Import.bcbx to the cloud computer.
2. Unzip it: unzip -o GrokBot-Import.bcbx -d bcb-import && cd bcb-import
3. Run: node import.mjs
4. Report only how many cookies were imported per domain, then delete the bcb-import folder and any copies of the bundle.`;

const KDF = { name: "scrypt", N: 16384, r: 8, p: 1, keyLength: 32 };
const SAME_SITE = {
  unspecified: "unspecified",
  no_restriction: "no_restriction",
  lax: "lax",
  strict: "strict",
};

export function buildCloudTransferBundle({
  target = "grok-bot",
  cookies,
  sourceBrowser,
  onlyDomains = [],
  passphrase = generatePassphrase(),
  now = new Date(),
  importerSource = defaultImporterSource(),
} = {}) {
  const destination = cloudTransferTarget(target);
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
    format: `browser-cookie-bridge-${target}`,
    version: BUNDLE_FORMAT_VERSION,
    keyDelivery: "embedded",
    keyFile: EMBEDDED_KEY_FILENAME,
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
    { name: EMBEDDED_KEY_FILENAME, data: Buffer.from(`${passphrase}\n`, "utf8") },
    { name: "import.mjs", data: Buffer.from(importerSource, "utf8") },
    { name: "PROMPT.txt", data: Buffer.from(`${cloudTransferPrompt(target)}\n`, "utf8") },
  ]);

  return {
    archive,
    manifest,
    passphrase,
    cookieCount: exportCookies.length,
    domainCount: domains.length,
    domains,
    sourceBrowser,
    bundleName: destination.bundleName,
  };
}

export function writeCloudTransferBundle({
  target = "grok-bot",
  outputPath,
  cookies,
  sourceBrowser,
  onlyDomains = [],
  passphrase,
} = {}) {
  const destination = cloudTransferTarget(target);
  const resolved = path.resolve(outputPath || destination.bundleName);
  if (!resolved.endsWith(`.${BUNDLE_EXTENSION}`)) {
    throw new Error(`${destination.name} bundles must use the .${BUNDLE_EXTENSION} extension.`);
  }
  const bundle = buildCloudTransferBundle({ target, cookies, sourceBrowser, onlyDomains, passphrase });
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // Write to a sibling temp file and rename so a Replace either fully succeeds or leaves the previous bundle intact.
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bundle.archive, { mode: 0o600 });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.chmodSync(resolved, 0o600);
  return {
    outputPath: resolved,
    passphrase: bundle.passphrase,
    cookieCount: bundle.cookieCount,
    domainCount: bundle.domainCount,
    domains: bundle.domains,
    sourceBrowser: bundle.sourceBrowser,
    prompt: cloudTransferPrompt(target),
  };
}

export function exportCloudTransferBundleFromProfile({
  target = "grok-bot",
  browser,
  onlyDomains = [],
  outputPath,
  passphrase,
} = {}) {
  const payload = readChromiumProfile({
    browser,
    imports: { cookies: true, history: false },
  });
  const result = writeCloudTransferBundle({
    target,
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

export function parseCloudTransferBundle(buffer) {
  const entries = readZipArchive(buffer);
  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  return {
    manifest,
    payload: entries.get("payload.enc"),
    embeddedKey: entries.get(EMBEDDED_KEY_FILENAME)?.toString("utf8").trim() || "",
    importer: entries.get("import.mjs")?.toString("utf8") || "",
    prompt: entries.get("PROMPT.txt")?.toString("utf8") || "",
  };
}

export function cloudTransferSummary(result, target = "grok-bot") {
  const { name } = cloudTransferTarget(target);
  const domainNote = result.domainCount === 1 ? "1 domain" : `${result.domainCount} domains`;
  const skipped = result.sourceCookieSkipped
    ? ` ${result.sourceCookieSkipped} source cookie${result.sourceCookieSkipped === 1 ? " was" : "s were"} unreadable or unsupported.`
    : "";
  return `${name} transfer file created: ${result.cookieCount} cookies across ${domainNote} from ${result.sourceBrowser}.${skipped} Attach ${path.basename(result.outputPath)} to ${target === "dots" ? "your dot" : "any Grok Bot"} and paste the prompt. The bundle includes the decryption key—treat the file as credentials and do not share it.`;
}

/** Machine-readable sync result for the macOS app (keep small — no domain lists). */
export function formatCloudTransferResultLine({ outputPath, prompt }, target = "grok-bot") {
  return `${cloudTransferTarget(target).resultPrefix} ${JSON.stringify({ outputPath, prompt })}`;
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
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cloud-transfer-importer.mjs"), "utf8");
}
