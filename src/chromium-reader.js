import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

const BROWSERS = {
  brave: {
    root: ["BraveSoftware", "Brave-Browser"],
    safeStorageService: "Brave Safe Storage",
    safeStorageAccount: "Brave",
  },
  chrome: {
    root: ["Google", "Chrome"],
    safeStorageService: "Chrome Safe Storage",
    safeStorageAccount: "Chrome",
  },
  edge: {
    root: ["Microsoft Edge"],
    safeStorageService: "Microsoft Edge Safe Storage",
    safeStorageAccount: "Microsoft Edge",
  },
  arc: {
    root: ["Arc", "User Data"],
    safeStorageService: "Arc Safe Storage",
    safeStorageAccount: "Arc",
  },
  vivaldi: {
    root: ["Vivaldi"],
    safeStorageService: "Vivaldi Safe Storage",
    safeStorageAccount: "Vivaldi",
  },
  opera: {
    root: ["com.operasoftware.Opera"],
    directProfile: true,
    safeStorageService: "Opera Safe Storage",
    safeStorageAccount: "Opera",
  },
  comet: {
    root: ["Comet"],
    safeStorageService: "Comet Safe Storage",
    safeStorageAccount: "Comet",
  },
};

export function readChromiumProfile({
  browser,
  imports = { cookies: true, history: false },
  home = os.homedir(),
  password,
} = {}) {
  const definition = BROWSERS[browser];
  if (!definition) throw new Error(`Unsupported Chromium source: ${browser}`);
  const root = path.join(home, "Library", "Application Support", ...definition.root);
  const profileName = definition.directProfile ? "Default" : activeProfileName(root);
  const profilePath = definition.directProfile ? root : path.join(root, profileName);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`${browserDisplayName(browser)} profile not found at ${profilePath}`);
  }

  const cookies = imports.cookies
    ? readCookies({
        databasePath: firstExisting([
          path.join(profilePath, "Network", "Cookies"),
          path.join(profilePath, "Cookies"),
        ]),
        password: password ?? readSafeStoragePassword(definition, browser),
      })
    : [];
  const history = imports.history
    ? readHistory(path.join(profilePath, "History"))
    : [];

  return { cookies, history, profileName, profilePath };
}

export function decryptChromiumCookieValue({ domain, encryptedValue, password }) {
  const encoded = Buffer.from(encryptedValue);
  if (encoded.length < 4 || (encoded.subarray(0, 3).toString() !== "v10" && encoded.subarray(0, 3).toString() !== "v11")) {
    throw new Error("Unsupported Chromium cookie encryption format");
  }
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([decipher.update(encoded.subarray(3)), decipher.final()]);
  if (plaintext.length < 32) throw new Error("Invalid Chromium cookie payload");
  const expected = crypto.createHash("sha256").update(domain).digest();
  if (!crypto.timingSafeEqual(plaintext.subarray(0, 32), expected)) {
    throw new Error("Chromium cookie host verification failed");
  }
  return plaintext.subarray(32).toString();
}

function readCookies({ databasePath, password }) {
  if (databasePath === null) throw new Error("Cookie database was not found");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT host_key, top_frame_site_key, name, value, encrypted_value, path,
             CAST(expires_utc AS TEXT) AS expires_utc,
             is_secure, is_httponly, has_expires, is_persistent, samesite,
             has_cross_site_ancestor
      FROM cookies
    `).all();
    const cookies = [];
    for (const row of rows) {
      try {
        const value = row.value || decryptChromiumCookieValue({
          domain: row.host_key,
          encryptedValue: row.encrypted_value,
          password,
        });
        const persistent = Boolean(row.has_expires && row.is_persistent && row.expires_utc > 0);
        cookies.push({
          name: row.name,
          value,
          domain: row.host_key,
          hostOnly: !row.host_key.startsWith("."),
          path: row.path,
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          sameSite: ({ "-1": "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" })[row.samesite] || "unspecified",
          session: !persistent,
          ...(persistent ? { expirationDate: chromiumToUnixSeconds(row.expires_utc) } : {}),
          ...(row.top_frame_site_key ? {
            partitionKey: {
              topLevelSite: row.top_frame_site_key,
              hasCrossSiteAncestor: Boolean(row.has_cross_site_ancestor),
            },
          } : {}),
        });
      } catch {
        // An individual malformed or obsolete cookie must not block the rest of the profile.
      }
    }
    return cookies;
  } finally {
    database.close();
  }
}

function readHistory(databasePath) {
  if (!fs.existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT url FROM urls WHERE url LIKE 'http://%' OR url LIKE 'https://%'")
      .all()
      .flatMap((row) => typeof row.url === "string" ? [{ url: row.url }] : []);
  } finally {
    database.close();
  }
}

function readSafeStoragePassword(definition, browser) {
  const args = ["find-generic-password", "-w", "-s", definition.safeStorageService];
  if (definition.safeStorageAccount) args.push("-a", definition.safeStorageAccount);
  const result = spawnSync("/usr/bin/security", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${browserDisplayName(browser)} Safe Storage is unavailable. Open ${browserDisplayName(browser)} once, then try again.`,
    );
  }
  return result.stdout.trimEnd();
}

function activeProfileName(root) {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8"));
    const lastUsed = localState.profile?.last_used;
    if (typeof lastUsed === "string" && lastUsed && fs.existsSync(path.join(root, lastUsed))) return lastUsed;
  } catch {}
  if (fs.existsSync(path.join(root, "Default"))) return "Default";
  const candidate = fs.readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && /^Profile \d+$/.test(entry.name));
  return candidate?.name || "Default";
}

function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function chromiumToUnixSeconds(value) {
  return Number(value) / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS;
}

function browserDisplayName(browser) {
  return ({ brave: "Brave", chrome: "Chrome", edge: "Edge", arc: "Arc", vivaldi: "Vivaldi", opera: "Opera", comet: "Comet" })[browser] || browser;
}
