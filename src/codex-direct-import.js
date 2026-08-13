import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { appSupportDir, codexCookiePaths } from "./paths.js";

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const CODEX_RUNNING_ERROR = "ChatGPT Codex is open. Quit it completely, then click Sync now again.";
const MAX_BACKUPS = 14;
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
  const output = processList ?? spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;
  return String(output).split("\n").some((command) =>
    /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/.test(command.trim()),
  );
}

export function directImportToCodex({
  cookies,
  history = [],
  sourceProfilePath,
  siteStorage = false,
  sourceCookieSkipped = 0,
  home = os.homedir(),
  codexRunning = isCodexRunning(),
  now = new Date(),
} = {}) {
  if (!Array.isArray(cookies) || !Array.isArray(history)) {
    throw new TypeError("cookies and history must be arrays");
  }
  if (codexRunning) throw new Error(CODEX_RUNNING_ERROR);

  const cookiePath = codexCookiePaths(home).find((candidate) => fs.existsSync(candidate));
  if (!cookiePath) {
    throw new Error("Codex browser storage was not found. Open the Codex browser once, quit Codex, then try again.");
  }
  const historyPath = path.join(path.dirname(cookiePath), "History");
  const codexProfilePath = codexProfileRoot(cookiePath);
  const backupRoot = path.join(appSupportDir(home), "backups", "codex");
  const backupPath = path.join(backupRoot, backupDirectoryName(now));
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });

  const cookieBackup = path.join(backupPath, "Cookies");
  try {
    snapshotDatabase(cookiePath, cookieBackup);
  } catch (error) {
    fs.rmSync(backupPath, { recursive: true, force: true });
    if (/locked|busy/i.test(error.message)) {
      throw new Error("Codex is still releasing its browser database. Wait a few seconds after quitting Codex, then try again.");
    }
    throw error;
  }
  const cookieWorking = temporarySibling(cookiePath);
  fs.copyFileSync(cookieBackup, cookieWorking);
  fs.chmodSync(cookieWorking, 0o600);

  let historyBackup = null;
  let historyWorking = null;
  if (history.length > 0) {
    if (!fs.existsSync(historyPath)) {
      fs.rmSync(cookieWorking, { force: true });
      throw new Error("Codex history storage was not found. Open the Codex browser once, quit Codex, then try again.");
    }
    historyBackup = path.join(backupPath, "History");
    try {
      snapshotDatabase(historyPath, historyBackup);
    } catch (error) {
      fs.rmSync(cookieWorking, { force: true });
      if (/locked|busy/i.test(error.message)) {
        throw new Error("Codex is still releasing its history database. Wait a few seconds after quitting Codex, then try again.");
      }
      throw error;
    }
    historyWorking = temporarySibling(historyPath);
    fs.copyFileSync(historyBackup, historyWorking);
    fs.chmodSync(historyWorking, 0o600);
  }

  let siteStoragePlan = [];
  if (siteStorage) {
    try {
      if (!sourceProfilePath || !fs.existsSync(sourceProfilePath)) {
        throw new Error("The selected source profile was not found for full site-data import.");
      }
      siteStoragePlan = prepareSiteStorageTransfer({ sourceProfilePath, codexProfilePath, backupPath });
    } catch (error) {
      fs.rmSync(cookieWorking, { force: true });
      if (historyWorking) fs.rmSync(historyWorking, { force: true });
      throw error;
    }
  }

  let cookieResult;
  let historyResult = { imported: 0, skipped: 0, failed: 0 };
  try {
    cookieResult = mergeCookies(cookieWorking, cookies, now);
    if (historyWorking) historyResult = mergeHistory(historyWorking, history, now);
    replaceDatabase(cookieWorking, cookiePath);
    cookieResult.replaced = true;
    if (historyWorking) {
      replaceDatabase(historyWorking, historyPath);
      historyResult.replaced = true;
    }
    commitSiteStorageTransfer(siteStoragePlan);
  } catch (error) {
    restoreDatabase(cookieBackup, cookiePath);
    if (historyBackup) restoreDatabase(historyBackup, historyPath);
    restoreSiteStorageTransfer(siteStoragePlan);
    throw new Error(`Codex data was restored from backup after the sync failed: ${error.message}`);
  } finally {
    fs.rmSync(cookieWorking, { force: true });
    if (historyWorking) fs.rmSync(historyWorking, { force: true });
    cleanupSiteStorageTransfer(siteStoragePlan);
  }

  pruneBackups(backupRoot, MAX_BACKUPS);
  return {
    imported: cookieResult.imported,
    skipped: cookieResult.skipped,
    failed: cookieResult.failed,
    historyImported: historyResult.imported,
    historySkipped: historyResult.skipped,
    historyFailed: historyResult.failed,
    backupPath,
    targetPath: cookiePath,
    directCodexImport: true,
    siteStorageImported: siteStoragePlan.filter((item) => item.committed).length,
    siteStorageNames: siteStoragePlan.filter((item) => item.committed).map((item) => item.name),
    sourceCookieSkipped: Number.isInteger(sourceCookieSkipped) && sourceCookieSkipped > 0 ? sourceCookieSkipped : 0,
  };
}

function codexProfileRoot(cookiePath) {
  const parent = path.dirname(cookiePath);
  return path.basename(parent) === "Network" ? path.dirname(parent) : parent;
}

function prepareSiteStorageTransfer({ sourceProfilePath, codexProfilePath, backupPath }) {
  const plan = [];
  try {
    fs.mkdirSync(codexProfilePath, { recursive: true, mode: 0o700 });
    for (const name of SITE_STORAGE_DIRECTORIES) {
      const source = path.join(sourceProfilePath, name);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(codexProfilePath, name);
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

function mergeCookies(databasePath, cookies, now) {
  const database = new DatabaseSync(databasePath);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  try {
    assertIntegrity(database);
    assertTableColumns(database, "cookies", [
      "creation_utc", "host_key", "top_frame_site_key", "name", "value",
      "encrypted_value", "path", "expires_utc", "is_secure", "is_httponly",
      "last_access_utc", "has_expires", "is_persistent", "priority", "samesite",
      "source_scheme", "source_port", "last_update_utc", "source_type",
      "has_cross_site_ancestor",
    ]);
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
      try {
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
      } catch {
        failed += 1;
      }
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

function mergeHistory(databasePath, history, now) {
  const database = new DatabaseSync(databasePath);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  try {
    assertIntegrity(database);
    assertTableColumns(database, "urls", ["id", "url", "visit_count", "last_visit_time"]);
    assertTableColumns(database, "visits", ["url", "visit_time", "transition"]);
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
      try {
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
      } catch {
        failed += 1;
      }
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
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
  fs.renameSync(source, target);
  fs.chmodSync(target, 0o600);
}

function restoreDatabase(backup, target) {
  if (!fs.existsSync(backup)) return;
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
  fs.copyFileSync(backup, target);
  fs.chmodSync(target, 0o600);
}

function assertIntegrity(database) {
  const row = database.prepare("PRAGMA quick_check").get();
  if (Object.values(row ?? {})[0] !== "ok") throw new Error("SQLite integrity check failed");
}

function assertTableColumns(database, table, required) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) throw new Error(`Unsupported Codex ${table} schema; missing ${missing.join(", ")}`);
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

function pruneBackups(root, keep) {
  if (!fs.existsSync(root)) return;
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of directories.slice(keep)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
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

export { CODEX_RUNNING_ERROR };
