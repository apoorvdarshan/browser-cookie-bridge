import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const PROFILE_DIRECTORY_NAME = "Browser Cookie Bridge";
const PROFILE_DISPLAY_NAME = "Browser Cookie Bridge";

export function chromeStagingProfilePath(home = os.homedir()) {
  return path.join(home, "Library", "Application Support", "Google", "Chrome", PROFILE_DIRECTORY_NAME);
}

export function stageCodexImport({ cookies, history = [], home = os.homedir(), password } = {}) {
  if (!Array.isArray(cookies) || !Array.isArray(history)) {
    throw new TypeError("cookies and history must be arrays");
  }

  const chromeRoot = path.dirname(chromeStagingProfilePath(home));
  const profilePath = chromeStagingProfilePath(home);
  fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });

  const safeStoragePassword = password ?? readChromeSafeStoragePassword();
  const encryptionKey = deriveChromeEncryptionKey(safeStoragePassword);
  const cookiesResult = writeCookiesDatabase({ cookies, encryptionKey, profilePath });
  const historyResult = writeHistoryDatabase({ history, profilePath });
  writeProfileMetadata({ chromeRoot, profilePath });

  return {
    profilePath,
    imported: 0,
    failed: cookiesResult.failed,
    skipped: cookiesResult.skipped,
    historyImported: 0,
    historyFailed: historyResult.failed,
    historySkipped: historyResult.skipped,
    stagedCookies: cookiesResult.staged,
    stagedHistory: historyResult.staged,
    requiresCodexImport: true,
  };
}

export function openCodexBrowserImport() {
  const result = spawnSync("/usr/bin/open", ["codex://settings/browser-use"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not open ChatGPT Codex browser settings");
  }
}

export function deriveChromeEncryptionKey(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Chrome Safe Storage returned an empty password");
  }
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

export function encryptChromeCookieValue({ domain, value, encryptionKey }) {
  if (typeof domain !== "string" || typeof value !== "string" || !Buffer.isBuffer(encryptionKey)) {
    throw new TypeError("domain, value, and encryptionKey are required");
  }
  const hostDigest = crypto.createHash("sha256").update(domain).digest();
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([hostDigest, Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), encrypted]);
}

function readChromeSafeStoragePassword() {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      "Chrome Safe Storage is unavailable. Open Google Chrome once, quit it, then run the sync again.",
    );
  }
  return result.stdout.trimEnd();
}

function writeCookiesDatabase({ cookies, encryptionKey, profilePath }) {
  const databasePath = path.join(profilePath, "Cookies");
  const temporaryPath = `${databasePath}.${process.pid}.tmp`;
  fs.rmSync(temporaryPath, { force: true });

  const database = new DatabaseSync(temporaryPath);
  let staged = 0;
  let skipped = 0;
  let failed = 0;
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies(
        creation_utc INTEGER NOT NULL,
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        last_access_utc INTEGER NOT NULL,
        has_expires INTEGER NOT NULL,
        is_persistent INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        samesite INTEGER NOT NULL,
        source_scheme INTEGER NOT NULL,
        source_port INTEGER NOT NULL,
        last_update_utc INTEGER NOT NULL,
        source_type INTEGER NOT NULL,
        has_cross_site_ancestor INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX cookies_unique_index
        ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);
      INSERT INTO meta(key, value) VALUES ('last_compatible_version', '24'), ('version', '24');
    `);
    const insert = database.prepare(`
      INSERT OR REPLACE INTO cookies(
        creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path,
        expires_utc, is_secure, is_httponly, last_access_utc, has_expires,
        is_persistent, priority, samesite, source_scheme, source_port, last_update_utc,
        source_type, has_cross_site_ancestor
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 2, 443, ?, 1, ?)
    `);
    const now = chromiumTime(Date.now() / 1000);
    database.exec("BEGIN IMMEDIATE");
    for (const cookie of cookies) {
      try {
        const normalized = normalizeCookie(cookie);
        if (normalized === null) {
          skipped += 1;
          continue;
        }
        insert.run(
          now,
          normalized.domain,
          normalized.topFrameSiteKey,
          normalized.name,
          encryptChromeCookieValue({
            domain: normalized.domain,
            value: normalized.value,
            encryptionKey,
          }),
          normalized.path,
          normalized.expiresUtc,
          normalized.secure ? 1 : 0,
          normalized.httpOnly ? 1 : 0,
          now,
          normalized.persistent ? 1 : 0,
          normalized.persistent ? 1 : 0,
          normalized.sameSite,
          now,
          normalized.topFrameSiteKey === "" ? 1 : 0,
        );
        staged += 1;
      } catch {
        failed += 1;
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }

  replacePrivateFile(temporaryPath, databasePath);
  return { staged, skipped, failed };
}

function writeHistoryDatabase({ history, profilePath }) {
  const databasePath = path.join(profilePath, "History");
  const temporaryPath = `${databasePath}.${process.pid}.tmp`;
  fs.rmSync(temporaryPath, { force: true });
  const database = new DatabaseSync(temporaryPath);
  let staged = 0;
  let skipped = 0;
  let failed = 0;
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE urls(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url LONGVARCHAR,
        title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0 NOT NULL,
        typed_count INTEGER DEFAULT 0 NOT NULL,
        last_visit_time INTEGER NOT NULL,
        hidden INTEGER DEFAULT 0 NOT NULL
      );
      CREATE UNIQUE INDEX urls_url_index ON urls(url);
      INSERT INTO meta(key, value) VALUES ('last_compatible_version', '70'), ('version', '70');
    `);
    const insert = database.prepare(
      "INSERT OR IGNORE INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, '', 1, 0, ?, 0)",
    );
    const now = chromiumTime(Date.now() / 1000);
    database.exec("BEGIN IMMEDIATE");
    for (const item of history) {
      try {
        if (!item || typeof item.url !== "string" || !/^https?:\/\//.test(item.url)) {
          skipped += 1;
          continue;
        }
        const result = insert.run(item.url, now);
        if (result.changes > 0) staged += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
  replacePrivateFile(temporaryPath, databasePath);
  return { staged, skipped, failed };
}

function writeProfileMetadata({ chromeRoot, profilePath }) {
  const localStatePath = path.join(chromeRoot, "Local State");
  const localState = readJsonOr(localStatePath, {});
  localState.profile = localState.profile && typeof localState.profile === "object" ? localState.profile : {};
  localState.profile.info_cache = localState.profile.info_cache && typeof localState.profile.info_cache === "object"
    ? localState.profile.info_cache
    : {};
  localState.profile.info_cache[PROFILE_DIRECTORY_NAME] = {
    ...(localState.profile.info_cache[PROFILE_DIRECTORY_NAME] || {}),
    avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_26",
    background_apps: false,
    force_signin_profile_locked: false,
    gaia_given_name: "",
    gaia_id: "",
    gaia_name: "",
    hosted_domain: "",
    is_consented_primary_account: false,
    is_ephemeral: false,
    is_using_default_avatar: true,
    is_using_default_name: false,
    managed_user_id: "",
    name: PROFILE_DISPLAY_NAME,
    user_name: "",
  };
  localState.profile.profiles_order = Array.from(new Set([
    ...(Array.isArray(localState.profile.profiles_order) ? localState.profile.profiles_order : []),
    PROFILE_DIRECTORY_NAME,
  ]));
  writePrivateJson(localStatePath, localState);

  const preferencesPath = path.join(profilePath, "Preferences");
  const preferences = readJsonOr(preferencesPath, {});
  preferences.profile = {
    ...(preferences.profile && typeof preferences.profile === "object" ? preferences.profile : {}),
    name: PROFILE_DISPLAY_NAME,
  };
  writePrivateJson(preferencesPath, preferences);
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") return null;
  if (typeof cookie.domain !== "string") return null;
  const cleanHost = cookie.domain.replace(/^\./, "").trim().toLowerCase();
  if (!cleanHost || cleanHost.includes("/") || cleanHost.includes(":")) return null;
  const domain = cookie.hostOnly ? cleanHost : `.${cleanHost}`;
  const persistent = !cookie.session && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0;
  const topFrameSiteKey = typeof cookie.partitionKey?.topLevelSite === "string"
    ? cookie.partitionKey.topLevelSite
    : "";
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    topFrameSiteKey,
    path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    persistent,
    expiresUtc: persistent ? chromiumTime(cookie.expirationDate) : 0,
    sameSite: ({ unspecified: -1, no_restriction: 0, lax: 1, strict: 2 })[cookie.sameSite] ?? -1,
  };
}

function chromiumTime(unixSeconds) {
  return Math.trunc((unixSeconds + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000);
}

function readJsonOr(target, fallback) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return fallback;
  }
}

function writePrivateJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function replacePrivateFile(source, target) {
  fs.rmSync(target, { force: true });
  fs.renameSync(source, target);
  fs.chmodSync(target, 0o600);
}
