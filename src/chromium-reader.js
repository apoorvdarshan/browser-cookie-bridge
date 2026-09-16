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
    processPattern: /\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser(?:\s|$)/,
  },
  chrome: {
    root: ["Google", "Chrome"],
    safeStorageService: "Chrome Safe Storage",
    safeStorageAccount: "Chrome",
    processPattern: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)/,
  },
  edge: {
    root: ["Microsoft Edge"],
    safeStorageService: "Microsoft Edge Safe Storage",
    safeStorageAccount: "Microsoft Edge",
    processPattern: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge(?:\s|$)/,
  },
  arc: {
    root: ["Arc", "User Data"],
    safeStorageService: "Arc Safe Storage",
    safeStorageAccount: "Arc",
    processPattern: /\/Arc\.app\/Contents\/MacOS\/Arc(?:\s|$)/,
  },
  vivaldi: {
    root: ["Vivaldi"],
    safeStorageService: "Vivaldi Safe Storage",
    safeStorageAccount: "Vivaldi",
    processPattern: /\/Vivaldi\.app\/Contents\/MacOS\/Vivaldi(?:\s|$)/,
  },
  opera: {
    root: ["com.operasoftware.Opera"],
    directProfile: true,
    safeStorageService: "Opera Safe Storage",
    safeStorageAccount: "Opera",
    processPattern: /\/Opera\.app\/Contents\/MacOS\/Opera(?:\s|$)/,
  },
  comet: {
    root: ["Comet"],
    safeStorageService: "Comet Safe Storage",
    safeStorageAccount: "Comet",
    processPattern: /\/Comet\.app\/Contents\/MacOS\/Comet(?:\s|$)/,
  },
};

export function isChromiumBrowserRunning({ browser, processList } = {}) {
  const definition = BROWSERS[browser];
  if (!definition) throw new Error(`Unsupported Chromium source: ${browser}`);
  const output = processList ?? spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;
  return String(output).split("\n").some((command) => definition.processPattern.test(command.trim()));
}

/**
 * Directory of pre-copied source databases (`Cookies`, optionally `History`, plus SQLite sidecars) provided by
 * the macOS app. The app process holds Full Disk Access; the Node binary from config.nodePath (for example a
 * Homebrew install) is a separate TCC client and gets EPERM when it opens or copies another app's Cookies file
 * itself. When this is set the reader never touches the live profile databases.
 */
export const SOURCE_SNAPSHOT_ENV = "BCB_SOURCE_SNAPSHOT_DIR";

export function resolveSourceSnapshot(directory = process.env[SOURCE_SNAPSHOT_ENV]) {
  if (!directory) return { directory: null, cookies: null, history: null };
  const cookies = path.join(directory, "Cookies");
  const history = path.join(directory, "History");
  return {
    directory,
    cookies: fs.existsSync(cookies) ? cookies : null,
    history: fs.existsSync(history) ? history : null,
  };
}

export function readChromiumProfile({
  browser,
  imports = { cookies: true, history: false },
  home = os.homedir(),
  password,
  snapshotDirectory = process.env[SOURCE_SNAPSHOT_ENV],
} = {}) {
  const definition = BROWSERS[browser];
  if (!definition) throw new Error(`Unsupported Chromium source: ${browser}`);
  const root = path.join(home, "Library", "Application Support", ...definition.root);
  const profileName = definition.directProfile ? "Default" : activeProfileName(root);
  const profilePath = definition.directProfile ? root : path.join(root, profileName);
  const snapshot = resolveSourceSnapshot(snapshotDirectory);
  if (!fs.existsSync(profilePath) && !snapshot.cookies) {
    throw new Error(`${browserDisplayName(browser)} profile not found at ${profilePath}`);
  }

  const cookieResult = imports.cookies
    ? readCookies({
        databasePath: snapshot.cookies ?? firstExisting([
          path.join(profilePath, "Network", "Cookies"),
          path.join(profilePath, "Cookies"),
        ]),
        password: password ?? readSafeStoragePassword(definition, browser),
        browser,
      })
    : { cookies: [], total: 0, skipped: 0 };
  const history = imports.history
    ? readHistory(snapshot.history ?? path.join(profilePath, "History"), browser)
    : [];

  return {
    cookies: cookieResult.cookies,
    cookieStats: { total: cookieResult.total, imported: cookieResult.cookies.length, skipped: cookieResult.skipped },
    history,
    profileName,
    profilePath,
    snapshot: {
      cookies: Boolean(imports.cookies && snapshot.cookies),
      history: Boolean(imports.history && snapshot.history),
    },
  };
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

const COOKIE_QUERY = `
  SELECT host_key, top_frame_site_key, name, value, encrypted_value, path,
         CAST(expires_utc AS TEXT) AS expires_utc,
         is_secure, is_httponly, has_expires, is_persistent, samesite,
         has_cross_site_ancestor
  FROM cookies
`;

export function isLockError(error) {
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|locking protocol|unable to open database/i.test(String(error?.message || error));
}

/**
 * macOS TCC (Full Disk Access) denials surface as EPERM from open/copyfile, not as SQLite lock errors.
 * They must never be reported as "close the browser" because quitting the browser does not fix them.
 */
export function isPermissionError(error) {
  if (error?.code === "EPERM" || error?.code === "EACCES") return true;
  return /\bEPERM\b|\bEACCES\b|operation not permitted|permission denied|SQLITE_PERM|SQLITE_AUTH/i
    .test(String(error?.message || error));
}

export const FULL_DISK_ACCESS_HINT =
  "Browser Cookie Bridge needs Full Disk Access: open System Settings › Privacy & Security › Full Disk Access, turn on Browser Cookie Bridge, then quit and reopen the app and try again.";

function permissionDeniedError({ browser, filePath, cause }) {
  const name = browser ? browserDisplayName(browser) : "browser";
  const reason = cause?.code
    ? `${cause.code}: ${String(cause.message || "").replace(/^\w+:\s*/, "").split(",")[0]}`
    : String(cause?.message || cause || "operation not permitted").split("\n")[0];
  const error = new Error(
    `macOS denied access to the ${name} ${path.basename(filePath || "Cookies")} database (${reason}). ${FULL_DISK_ACCESS_HINT} Quitting ${name} does not fix this.`,
  );
  error.code = "BCB_FULL_DISK_ACCESS";
  error.cause = cause;
  return error;
}

/**
 * Cheap read probe for the selected browser's cookie store: opens the file read-only without touching SQLite,
 * so it reports a TCC/Full Disk Access denial even when the browser is closed and the database is not locked.
 */
export function probeCookieDatabaseAccess({ browser, home = os.homedir() } = {}) {
  const definition = BROWSERS[browser];
  if (!definition) throw new Error(`Unsupported Chromium source: ${browser}`);
  const root = path.join(home, "Library", "Application Support", ...definition.root);
  const missing = { browser, databasePath: null, exists: false, readable: false, permissionDenied: false, reason: "not found" };
  if (!fs.existsSync(root)) return missing;
  const profilePath = definition.directProfile ? root : path.join(root, activeProfileName(root));
  const databasePath = firstExisting([
    path.join(profilePath, "Network", "Cookies"),
    path.join(profilePath, "Cookies"),
  ]);
  if (databasePath === null) return missing;
  try {
    fs.closeSync(fs.openSync(databasePath, "r"));
    return { browser, databasePath, exists: true, readable: true, permissionDenied: false, reason: null };
  } catch (error) {
    return {
      browser,
      databasePath,
      exists: true,
      readable: false,
      permissionDenied: isPermissionError(error),
      reason: error.code || error.message,
    };
  }
}

function queryCookieRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(COOKIE_QUERY).all();
  } finally {
    database.close();
  }
}

/**
 * Chromium holds its cookie store with exclusive SQLite locking while the browser runs, which makes a direct
 * read-only open fail with "database is locked". Copying the file (plus any WAL/journal sidecars) into a
 * private temporary directory sidesteps the advisory lock; the copy is removed immediately after reading.
 */
export function readCookieRowsFromSnapshot(databasePath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bcb-cookie-snapshot-"));
  fs.chmodSync(directory, 0o700);
  try {
    const target = path.join(directory, "Cookies");
    fs.copyFileSync(databasePath, target);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${target}${suffix}`);
    }
    return queryCookieRows(target);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function readCookieRows(databasePath, { snapshot = readCookieRowsFromSnapshot, browser } = {}) {
  try {
    return queryCookieRows(databasePath);
  } catch (error) {
    if (isPermissionError(error)) throw permissionDeniedError({ browser, filePath: databasePath, cause: error });
    if (!isLockError(error)) throw error;
    try {
      return snapshot(databasePath);
    } catch (snapshotError) {
      // SQLITE_CANTOPEN ("unable to open database") is ambiguous; the snapshot copy tells us whether the real
      // cause was a TCC denial (EPERM/EACCES on copyfile) rather than the browser's exclusive lock.
      if (isPermissionError(snapshotError)) {
        throw permissionDeniedError({ browser, filePath: databasePath, cause: snapshotError });
      }
      throw new Error(
        `Cookie database is locked by the browser and a temporary snapshot could not be read (${snapshotError.message}). Close the source browser and try again.`,
      );
    }
  }
}

function readCookies({ databasePath, password, browser }) {
  if (databasePath === null) throw new Error("Cookie database was not found");
  const rows = readCookieRows(databasePath, { browser });
  const cookies = [];
  let skipped = 0;
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
      skipped += 1;
    }
  }
  return { cookies, total: rows.length, skipped };
}

function readHistory(databasePath, browser) {
  if (!fs.existsSync(databasePath)) return [];
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    if (isPermissionError(error)) throw permissionDeniedError({ browser, filePath: databasePath, cause: error });
    throw error;
  }
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
  const name = browserDisplayName(browser);
  if (result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "").trim().split("\n").pop();
    const detail = reason ? ` (security: ${reason})` : "";
    throw new Error(
      `${name} Safe Storage is unavailable${detail}. Open ${name} once, and if macOS asks whether "security" may use the "${definition.safeStorageService}" keychain item choose Always Allow, then try again.`,
    );
  }
  const password = result.stdout.trimEnd();
  if (!password) {
    throw new Error(`${name} Safe Storage returned an empty key. Open ${name} once, then try again.`);
  }
  return password;
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
