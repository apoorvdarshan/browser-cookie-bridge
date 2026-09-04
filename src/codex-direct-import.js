import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { appSupportDir, codexCookiePaths, cursorCookiePaths } from "./paths.js";

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const CODEX_RUNNING_ERROR = "ChatGPT Codex is open. Quit it completely, then click Sync now again.";
const CURSOR_RUNNING_ERROR = "Cursor is open. Quit it completely, then click Sync now again.";
const MAX_BACKUPS = 14;
const DIRECT_TARGETS = {
  codex: {
    name: "Codex",
    applicationName: "ChatGPT Codex",
    storageName: "Codex browser",
    cookiePaths: codexCookiePaths,
    backupDirectory: "codex",
    processPattern: /^\/.*\.app\/Contents\/MacOS\/ChatGPT$/,
    runningError: CODEX_RUNNING_ERROR,
    historySupported: true,
    siteStorageSupported: true,
  },
  cursor: {
    name: "Cursor",
    applicationName: "Cursor",
    storageName: "Cursor browser",
    cookiePaths: cursorCookiePaths,
    backupDirectory: "cursor",
    processPattern: /^\/.*\.app\/Contents\/MacOS\/Cursor$/,
    runningError: CURSOR_RUNNING_ERROR,
    historySupported: false,
    siteStorageSupported: false,
    cookieSchemaVersion: "24",
    cookieIndex: {
      name: "cookies_unique_index",
      columns: ["host_key", "top_frame_site_key", "has_cross_site_ancestor", "name", "path", "source_scheme", "source_port"],
    },
  },
};
const SITE_STORAGE_DIRECTORIES = [
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "Service Worker",
  "File System",
  "WebStorage",
  "shared_proto_db",
  "Shared Dictionary",
];

export function isCodexRunning({ processList } = {}) {
  return isDirectTargetRunning({ target: "codex", processList });
}

export function isCursorRunning({ processList } = {}) {
  return isDirectTargetRunning({ target: "cursor", processList });
}

export function isDirectTargetRunning({ target, processList } = {}) {
  const definition = directTargetDefinition(target);
  let output = processList;
  if (output === undefined) {
    const result = spawnSync("/bin/ps", ["-axo", "comm="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not verify whether ${definition.applicationName} is running; refusing to modify its browser data.`);
    }
    output = result.stdout;
  }
  return String(output).split("\n").some((command) =>
    definition.processPattern.test(command.trim()),
  );
}

export function directImportToEmbeddedBrowser({
  target = "codex",
  cookies,
  history = [],
  sourceProfilePath,
  siteStorage = false,
  sourceCookieSkipped = 0,
  home = os.homedir(),
  runningCheck = () => isDirectTargetRunning({ target }),
  databaseReplacer = replaceDatabase,
  databaseRestorer = restoreDatabase,
  now = new Date(),
} = {}) {
  const definition = directTargetDefinition(target);
  const checkRunning = runningCheck;
  if (!Array.isArray(cookies) || !Array.isArray(history)) {
    throw new TypeError("cookies and history must be arrays");
  }
  if (checkRunning()) throw new Error(definition.runningError);
  if (!definition.historySupported && history.length > 0) {
    throw new Error(`${definition.storageName} does not expose a compatible history store. Turn off History URLs and try again.`);
  }
  if (!definition.siteStorageSupported && siteStorage) {
    throw new Error(`${definition.storageName} full site-data import is not supported yet. Turn off Full site data and try again.`);
  }
  if (target === "cursor" && cookies.length === 0) {
    throw new Error("No readable cookies were found to import into Cursor.");
  }

  const cookiePath = definition.cookiePaths(home).find((candidate) => fs.existsSync(candidate));
  if (!cookiePath) {
    throw new Error(`${definition.storageName} storage was not found. Open the browser in ${definition.applicationName} once, quit ${definition.applicationName}, then try again.`);
  }
  const historyPath = path.join(path.dirname(cookiePath), "History");
  const targetProfilePath = directTargetProfileRoot(cookiePath);
  const backupRoot = path.join(appSupportDir(home), "backups", definition.backupDirectory);
  const backupPath = path.join(backupRoot, backupDirectoryName(now));
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });

  const cookieBackup = path.join(backupPath, "Cookies");
  try {
    snapshotDatabase(cookiePath, cookieBackup);
  } catch (error) {
    fs.rmSync(backupPath, { recursive: true, force: true });
    if (/locked|busy/i.test(error.message)) {
      throw new Error(`${definition.applicationName} is still releasing its browser database. Wait a few seconds after quitting ${definition.applicationName}, then try again.`);
    }
    throw error;
  }
  const cookieWorking = temporarySibling(cookiePath);
  try {
    fs.copyFileSync(cookieBackup, cookieWorking);
    fs.chmodSync(cookieWorking, 0o600);
  } catch (error) {
    removeDatabaseArtifacts(cookieWorking);
    fs.rmSync(backupPath, { recursive: true, force: true });
    throw error;
  }

  let historyBackup = null;
  let historyWorking = null;
  if (history.length > 0) {
    if (!fs.existsSync(historyPath)) {
      removeDatabaseArtifacts(cookieWorking);
      fs.rmSync(backupPath, { recursive: true, force: true });
      throw new Error(`${definition.storageName} history storage was not found. Open the browser in ${definition.applicationName} once, quit ${definition.applicationName}, then try again.`);
    }
    historyBackup = path.join(backupPath, "History");
    try {
      snapshotDatabase(historyPath, historyBackup);
    } catch (error) {
      removeDatabaseArtifacts(cookieWorking);
      fs.rmSync(backupPath, { recursive: true, force: true });
      if (/locked|busy/i.test(error.message)) {
        throw new Error(`${definition.applicationName} is still releasing its history database. Wait a few seconds after quitting ${definition.applicationName}, then try again.`);
      }
      throw error;
    }
    historyWorking = temporarySibling(historyPath);
    try {
      fs.copyFileSync(historyBackup, historyWorking);
      fs.chmodSync(historyWorking, 0o600);
    } catch (error) {
      removeDatabaseArtifacts(cookieWorking);
      removeDatabaseArtifacts(historyWorking);
      fs.rmSync(backupPath, { recursive: true, force: true });
      throw error;
    }
  }

  let siteStoragePlan = [];
  if (siteStorage) {
    try {
      if (!sourceProfilePath || !fs.existsSync(sourceProfilePath)) {
        throw new Error("The selected source profile was not found for full site-data import.");
      }
      siteStoragePlan = prepareSiteStorageTransfer({ sourceProfilePath, targetProfilePath, backupPath });
    } catch (error) {
      removeDatabaseArtifacts(cookieWorking);
      if (historyWorking) removeDatabaseArtifacts(historyWorking);
      fs.rmSync(backupPath, { recursive: true, force: true });
      throw error;
    }
  }

  let cookieResult;
  let historyResult = { imported: 0, skipped: 0, failed: 0 };
  let cookieReplaced = false;
  let historyReplaced = false;
  try {
    cookieResult = mergeCookies(cookieWorking, cookies, now, definition);
    if (historyWorking) historyResult = mergeHistory(historyWorking, history, now, definition.name);
    if (target === "cursor" && cookieResult.imported === 0) {
      throw new Error("No valid cookies were available to import into Cursor.");
    }
    if (checkRunning()) throw new Error(definition.runningError);
    cookieReplaced = true;
    databaseReplacer(cookieWorking, cookiePath);
    cookieResult.replaced = true;
    if (historyWorking) {
      historyReplaced = true;
      databaseReplacer(historyWorking, historyPath);
      historyResult.replaced = true;
    }
    commitSiteStorageTransfer(siteStoragePlan);
  } catch (error) {
    const siteStorageTouched = siteStoragePlan.some((item) => item.touched);
    const restoreErrors = [];
    if (cookieReplaced) {
      try { databaseRestorer(cookieBackup, cookiePath); } catch (restoreError) { restoreErrors.push(`cookies: ${restoreError.message}`); }
    }
    if (historyReplaced) {
      try { databaseRestorer(historyBackup, historyPath); } catch (restoreError) { restoreErrors.push(`history: ${restoreError.message}`); }
    }
    if (siteStorageTouched) {
      try { restoreSiteStorageTransfer(siteStoragePlan); } catch (restoreError) { restoreErrors.push(`site storage: ${restoreError.message}`); }
    }
    if (restoreErrors.length > 0) {
      pruneBackupsSafely(backupRoot, MAX_BACKUPS, backupPath);
      throw new Error(`${definition.name} sync failed and recovery was incomplete (${restoreErrors.join("; ")}): ${error.message}`);
    }
    if (cookieReplaced || historyReplaced || siteStorageTouched) {
      pruneBackupsSafely(backupRoot, MAX_BACKUPS, backupPath);
      throw new Error(`${definition.name} data was restored from backup after the sync failed: ${error.message}`);
    }
    fs.rmSync(backupPath, { recursive: true, force: true });
    pruneBackupsSafely(backupRoot, MAX_BACKUPS);
    throw error;
  } finally {
    removeDatabaseArtifacts(cookieWorking);
    if (historyWorking) removeDatabaseArtifacts(historyWorking);
    cleanupSiteStorageTransfer(siteStoragePlan);
  }

  const backupCleanupWarning = pruneBackupsSafely(backupRoot, MAX_BACKUPS, backupPath);
  return {
    imported: cookieResult.imported,
    skipped: cookieResult.skipped,
    failed: cookieResult.failed,
    historyImported: historyResult.imported,
    historySkipped: historyResult.skipped,
    historyFailed: historyResult.failed,
    backupPath,
    targetPath: cookiePath,
    targetID: target,
    targetName: definition.name,
    directEmbeddedBrowserImport: true,
    directCodexImport: target === "codex",
    siteStorageImported: siteStoragePlan.filter((item) => item.committed).length,
    siteStorageNames: siteStoragePlan.filter((item) => item.committed).map((item) => item.name),
    sourceCookieSkipped: Number.isInteger(sourceCookieSkipped) && sourceCookieSkipped > 0 ? sourceCookieSkipped : 0,
    backupCleanupWarning,
  };
}

export function directImportToCodex(options = {}) {
  return directImportToEmbeddedBrowser({
    ...options,
    target: "codex",
  });
}

export function directImportToCursor(options = {}) {
  return directImportToEmbeddedBrowser({
    ...options,
    target: "cursor",
  });
}

function directTargetDefinition(target) {
  const definition = DIRECT_TARGETS[target];
  if (!definition) throw new Error(`Unsupported direct browser target: ${target}`);
  return definition;
}

function directTargetProfileRoot(cookiePath) {
  const parent = path.dirname(cookiePath);
  return path.basename(parent) === "Network" ? path.dirname(parent) : parent;
}

function prepareSiteStorageTransfer({ sourceProfilePath, targetProfilePath, backupPath }) {
  const plan = [];
  try {
    fs.mkdirSync(targetProfilePath, { recursive: true, mode: 0o700 });
    for (const name of SITE_STORAGE_DIRECTORIES) {
      const source = path.join(sourceProfilePath, name);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(targetProfilePath, name);
      const backup = path.join(backupPath, "Site Storage", name);
      const stage = `${destination}.browser-cookie-bridge-${process.pid}-${Date.now()}.stage`;
      const existed = fs.existsSync(destination);
      const item = { name, destination, backup, stage, existed, touched: false, committed: false };
      plan.push(item);
      if (existed) copyStorageTree(destination, backup);
      copyStorageTree(source, stage);
    }
    if (plan.length === 0) {
      throw new Error("No compatible Local Storage, IndexedDB, session, or service-worker data was found in the source profile.");
    }
    return plan;
  } catch (error) {
    cleanupSiteStorageTransfer(plan);
    throw error;
  }
}

function commitSiteStorageTransfer(plan) {
  for (const item of plan) {
    item.touched = true;
    fs.rmSync(item.destination, { recursive: true, force: true });
    fs.renameSync(item.stage, item.destination);
    item.committed = true;
  }
}

function restoreSiteStorageTransfer(plan) {
  for (const item of plan) {
    if (!item.touched) continue;
    fs.rmSync(item.destination, { recursive: true, force: true });
    if (item.existed && fs.existsSync(item.backup)) copyStorageTree(item.backup, item.destination);
    item.touched = false;
    item.committed = false;
  }
}

function cleanupSiteStorageTransfer(plan) {
  for (const item of plan) fs.rmSync(item.stage, { recursive: true, force: true });
}

function copyStorageTree(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter(candidate) {
      try { return !fs.lstatSync(candidate).isSymbolicLink(); } catch { return false; }
    },
  });
}

function mergeCookies(databasePath, cookies, now, definition) {
  const database = new DatabaseSync(databasePath);
  let imported = 0;
  let skipped = 0;
  const failed = 0;
  try {
    assertIntegrity(database);
    assertTableColumns(database, "cookies", [
      "creation_utc", "host_key", "top_frame_site_key", "name", "value",
      "encrypted_value", "path", "expires_utc", "is_secure", "is_httponly",
      "last_access_utc", "has_expires", "is_persistent", "priority", "samesite",
      "source_scheme", "source_port", "last_update_utc", "source_type",
      "has_cross_site_ancestor",
    ], definition.name);
    assertCookieSchema(database, definition);
    const insert = database.prepare(`
      INSERT OR REPLACE INTO cookies(
        creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
        path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires,
        is_persistent, priority, samesite, source_scheme, source_port,
        last_update_utc, source_type, has_cross_site_ancestor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?)
    `);
    const currentTime = chromiumTime(now.getTime() / 1000);
    database.exec("BEGIN IMMEDIATE");
    for (const cookie of cookies) {
      const normalized = normalizeCookie(cookie);
      if (!normalized) {
        skipped += 1;
        continue;
      }
      insert.run(
        currentTime,
        normalized.domain,
        normalized.topFrameSiteKey,
        normalized.name,
        normalized.value,
        Buffer.alloc(0),
        normalized.path,
        normalized.expiresUtc,
        normalized.secure ? 1 : 0,
        normalized.httpOnly ? 1 : 0,
        currentTime,
        normalized.persistent ? 1 : 0,
        normalized.persistent ? 1 : 0,
        normalized.sameSite,
        normalized.secure ? 2 : 1,
        normalized.secure ? 443 : 80,
        currentTime,
        normalized.hasCrossSiteAncestor ? 1 : 0,
      );
      imported += 1;
    }
    database.exec("COMMIT");
    assertIntegrity(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
  return { imported, skipped, failed };
}

function mergeHistory(databasePath, history, now, targetName) {
  const database = new DatabaseSync(databasePath);
  let imported = 0;
  let skipped = 0;
  const failed = 0;
  try {
    assertIntegrity(database);
    assertTableColumns(database, "urls", ["id", "url", "visit_count", "last_visit_time"], targetName);
    assertTableColumns(database, "visits", ["url", "visit_time", "transition"], targetName);
    const findURL = database.prepare("SELECT id FROM urls WHERE url = ? LIMIT 1");
    const insertURL = database.prepare(
      "INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, '', 1, 0, ?, 0)",
    );
    const updateURL = database.prepare(
      "UPDATE urls SET visit_count = visit_count + 1, last_visit_time = ? WHERE id = ?",
    );
    const insertVisit = database.prepare(
      "INSERT INTO visits(url, visit_time, from_visit, transition, visit_duration) VALUES (?, ?, 0, 805306368, 0)",
    );
    const currentTime = chromiumTime(now.getTime() / 1000);
    database.exec("BEGIN IMMEDIATE");
    for (const item of history) {
      if (!item || typeof item.url !== "string" || !/^https?:\/\//.test(item.url)) {
        skipped += 1;
        continue;
      }
      const existing = findURL.get(item.url);
      let urlID;
      if (existing) {
        urlID = existing.id;
        updateURL.run(currentTime, urlID);
      } else {
        urlID = insertURL.run(item.url, currentTime).lastInsertRowid;
      }
      insertVisit.run(urlID, currentTime);
      imported += 1;
    }
    database.exec("COMMIT");
    assertIntegrity(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
  return { imported, skipped, failed };
}

function snapshotDatabase(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    assertIntegrity(database);
    database.exec(`VACUUM INTO '${escapeSqlitePath(destination)}'`);
  } finally {
    database.close();
  }
  fs.chmodSync(destination, 0o600);
}

function replaceDatabase(source, target) {
  fs.chmodSync(source, 0o600);
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
  fs.rmSync(`${target}-journal`, { force: true });
  fs.renameSync(source, target);
}

function restoreDatabase(backup, target) {
  if (!fs.existsSync(backup)) return;
  const staged = temporarySibling(target);
  try {
    fs.copyFileSync(backup, staged);
    fs.chmodSync(staged, 0o600);
    fs.rmSync(`${target}-wal`, { force: true });
    fs.rmSync(`${target}-shm`, { force: true });
    fs.rmSync(`${target}-journal`, { force: true });
    fs.renameSync(staged, target);
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function assertIntegrity(database) {
  const row = database.prepare("PRAGMA quick_check").get();
  if (Object.values(row ?? {})[0] !== "ok") throw new Error("SQLite integrity check failed");
}

function assertTableColumns(database, table, required, targetName) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) throw new Error(`Unsupported ${targetName} ${table} schema; missing ${missing.join(", ")}`);
}

function assertCookieSchema(database, definition) {
  if (!definition.cookieSchemaVersion) return;
  const meta = Object.fromEntries(database.prepare("SELECT key, value FROM meta WHERE key IN ('version', 'last_compatible_version')").all().map((row) => [row.key, row.value]));
  if (String(meta.version) !== definition.cookieSchemaVersion || String(meta.last_compatible_version) !== definition.cookieSchemaVersion) {
    throw new Error(`Unsupported ${definition.name} cookies schema version: ${meta.version ?? "missing"}`);
  }
  const expected = definition.cookieIndex;
  const index = database.prepare("PRAGMA index_list(cookies)").all().find((row) => row.name === expected.name);
  const columns = index
    ? database.prepare(`PRAGMA index_info(${expected.name})`).all().map((row) => row.name)
    : [];
  if (!index || Number(index.unique) !== 1 || Number(index.partial) !== 0 || columns.join("\n") !== expected.columns.join("\n")) {
    throw new Error(`Unsupported ${definition.name} cookies uniqueness schema`);
  }
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") return null;
  if (typeof cookie.domain !== "string") return null;
  const cleanHost = cookie.domain.replace(/^\./, "").trim().toLowerCase();
  if (!cleanHost || cleanHost.includes("/") || cleanHost.includes(":")) return null;
  const persistent = !cookie.session && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? cleanHost : `.${cleanHost}`,
    topFrameSiteKey: typeof cookie.partitionKey?.topLevelSite === "string" ? cookie.partitionKey.topLevelSite : "",
    hasCrossSiteAncestor: cookie.partitionKey?.hasCrossSiteAncestor ?? !cookie.partitionKey,
    path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    persistent,
    expiresUtc: persistent ? chromiumTime(cookie.expirationDate) : 0,
    sameSite: ({ unspecified: -1, no_restriction: 0, lax: 1, strict: 2 })[cookie.sameSite] ?? -1,
  };
}

function pruneBackups(root, keep, protectedPath) {
  if (!fs.existsSync(root)) return;
  const protectedName = protectedPath ? path.basename(protectedPath) : null;
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removable = directories.filter((name) => name !== protectedName);
  const retainedOthers = protectedName && directories.includes(protectedName) ? Math.max(0, keep - 1) : keep;
  for (const name of removable.slice(retainedOthers)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function pruneBackupsSafely(root, keep, protectedPath) {
  try {
    pruneBackups(root, keep, protectedPath);
    return null;
  } catch (error) {
    return `The transfer succeeded, but old backups could not be pruned: ${error.message}`;
  }
}

function removeDatabaseArtifacts(target) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(`${target}${suffix}`, { force: true });
  }
}

function backupDirectoryName(now) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${process.pid}`;
}

function temporarySibling(target) {
  return `${target}.browser-cookie-bridge-${process.pid}-${Date.now()}.tmp`;
}

function chromiumTime(unixSeconds) {
  return Math.trunc((unixSeconds + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000);
}

function escapeSqlitePath(target) {
  return target.replaceAll("'", "''");
}

export { CODEX_RUNNING_ERROR, CURSOR_RUNNING_ERROR };
