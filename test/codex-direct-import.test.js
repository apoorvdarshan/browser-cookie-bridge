import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CODEX_RUNNING_ERROR,
  CURSOR_RUNNING_ERROR,
  directImportToCodex,
  directImportToCursor,
  isCodexRunning,
  isCursorRunning,
} from "../src/codex-direct-import.js";
import { codexCookiePaths, cursorCookiePaths } from "../src/paths.js";

test("direct Codex import refuses to write while Codex is running", () => {
  assert.equal(isCodexRunning({ processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n" }), true);
  assert.equal(isCodexRunning({ processList: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n" }), false);
  assert.throws(
    () => directImportToCodex({ cookies: [], runningCheck: () => true }),
    new RegExp(CODEX_RUNNING_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("direct Cursor import detects the app and writes only to its browser partition", () => {
  assert.equal(isCursorRunning({ processList: "/Applications/Cursor.app/Contents/MacOS/Cursor\n" }), true);
  assert.equal(isCursorRunning({ processList: "/Applications/Cursor Beta.app/Contents/MacOS/Cursor\n" }), true);
  assert.equal(isCursorRunning({ processList: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper\n" }), false);
  assert.equal(isCursorRunning({ processList: "/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler\n" }), false);
  assert.throws(
    () => directImportToCursor({ cookies: [], runningCheck: () => true }),
    new RegExp(CURSOR_RUNNING_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    const rootCookiePath = path.join(home, "Library", "Application Support", "Cursor", "Cookies");
    createCookieDatabase(cookiePath);
    fs.mkdirSync(path.dirname(rootCookiePath), { recursive: true });
    fs.writeFileSync(rootCookiePath, "main-cursor-store-must-not-change");
    for (const suffix of ["-journal", "-wal", "-shm"]) fs.writeFileSync(`${cookiePath}${suffix}`, "");
    const result = directImportToCursor({
      home,
      runningCheck: () => false,
      now: new Date("2026-09-04T04:00:00.000Z"),
      cookies: [{
        name: "session",
        value: "cursor-session-secret",
        domain: ".example.test",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        session: false,
        expirationDate: 2_000_000_000,
      }],
    });

    assert.equal(result.targetID, "cursor");
    assert.equal(result.targetName, "Cursor");
    assert.equal(result.directEmbeddedBrowserImport, true);
    assert.equal(result.directCodexImport, false);
    assert.equal(result.imported, 1);
    assert.match(result.backupPath, /backups\/cursor/);
    assert.equal(fs.existsSync(path.join(result.backupPath, "Cookies")), true);

    const cookies = new DatabaseSync(cookiePath, { readOnly: true });
    const row = cookies.prepare("SELECT value FROM cookies WHERE host_key = '.example.test' AND name = 'session'").get();
    assert.equal(row.value, "cursor-session-secret");
    cookies.close();
    assert.equal(fs.readFileSync(rootCookiePath, "utf8"), "main-cursor-store-must-not-change");
    for (const suffix of ["-journal", "-wal", "-shm"]) assert.equal(fs.existsSync(`${cookiePath}${suffix}`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import rejects history before changing its browser database", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-history-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    assert.throws(
      () => directImportToCursor({
        home,
        runningCheck: () => false,
        cookies: [],
        history: [{ url: "https://example.test" }],
      }),
      /does not expose a compatible history store/,
    );
    assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "BraveCodexCookieSync", "backups", "cursor")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import rejects full site data before creating a backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-site-data-"));
  try {
    createCookieDatabase(cursorCookiePaths(home)[0]);
    assert.throws(
      () => directImportToCursor({ home, runningCheck: () => false, cookies: [], siteStorage: true }),
      /full site-data import is not supported yet/,
    );
    assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "BraveCodexCookieSync", "backups", "cursor")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import fails closed when Cursor opens after the backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-reopen-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    const before = fs.readFileSync(cookiePath);
    let checks = 0;
    assert.throws(
      () => directImportToCursor({
        home,
        cookies: [{ name: "session", value: "must-not-land", domain: ".example.test", path: "/" }],
        runningCheck: () => checks++ > 0,
      }),
      new RegExp(CURSOR_RUNNING_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert(checks >= 2);
    assert.deepEqual(fs.readFileSync(cookiePath), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import refuses an unknown cookie schema without touching the target", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-schema-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    const database = new DatabaseSync(cookiePath);
    database.prepare("UPDATE meta SET value = '25' WHERE key = 'version'").run();
    database.close();
    const before = fs.readFileSync(cookiePath);
    assert.throws(
      () => directImportToCursor({
        home,
        runningCheck: () => false,
        cookies: [{ name: "session", value: "schema-check", domain: ".example.test", path: "/" }],
      }),
      /Unsupported Cursor cookies schema version: 25/,
    );
    assert.deepEqual(fs.readFileSync(cookiePath), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import rejects an unknown partial uniqueness index", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-index-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    const database = new DatabaseSync(cookiePath);
    database.exec(`
      DROP INDEX cookies_unique_index;
      CREATE UNIQUE INDEX cookies_unique_index
        ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port)
        WHERE host_key <> '';
    `);
    database.close();
    assert.throws(
      () => directImportToCursor({
        home,
        runningCheck: () => false,
        cookies: [{ name: "session", value: "index-check", domain: ".example.test", path: "/" }],
      }),
      /Unsupported Cursor cookies uniqueness schema/,
    );
    const inspected = new DatabaseSync(cookiePath, { readOnly: true });
    assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM cookies").get().count, 0);
    inspected.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import aborts a database write error without replacing the target", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-write-error-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    const database = new DatabaseSync(cookiePath);
    database.exec("CREATE TRIGGER reject_cookie BEFORE INSERT ON cookies BEGIN SELECT RAISE(ABORT, 'blocked test write'); END");
    database.close();
    assert.throws(
      () => directImportToCursor({
        home,
        runningCheck: () => false,
        cookies: [{ name: "session", value: "must-not-land", domain: ".example.test", path: "/" }],
      }),
      /blocked test write/,
    );
    const inspected = new DatabaseSync(cookiePath, { readOnly: true });
    assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM cookies").get().count, 0);
    inspected.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import restores the backup after replacement starts and fails", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-rollback-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    assert.throws(
      () => directImportToCursor({
        home,
        runningCheck: () => false,
        cookies: [{ name: "session", value: "must-be-rolled-back", domain: ".example.test", path: "/" }],
        databaseReplacer(source, target) {
          fs.renameSync(source, target);
          throw new Error("simulated replacement failure");
        },
      }),
      /data was restored from backup after the sync failed: simulated replacement failure/,
    );
    const inspected = new DatabaseSync(cookiePath, { readOnly: true });
    assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM cookies").get().count, 0);
    inspected.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Cursor import does not replace the database when every source cookie is invalid", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-cursor-empty-"));
  try {
    const cookiePath = cursorCookiePaths(home)[0];
    createCookieDatabase(cookiePath);
    assert.throws(
      () => directImportToCursor({ home, runningCheck: () => false, cookies: [{}] }),
      /No valid cookies were available/,
    );
    const inspected = new DatabaseSync(cookiePath, { readOnly: true });
    assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM cookies").get().count, 0);
    inspected.close();
    const backupRoot = path.join(home, "Library", "Application Support", "BraveCodexCookieSync", "backups", "cursor");
    assert.equal(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).length : 0, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Codex import backs up, merges, and validates cookies and history", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-direct-"));
  try {
    const cookiePath = codexCookiePaths(home)[0];
    const historyPath = path.join(path.dirname(cookiePath), "History");
    createCookieDatabase(cookiePath);
    createHistoryDatabase(historyPath);
    const secret = "direct-session-secret";
    const result = directImportToCodex({
      home,
      runningCheck: () => false,
      now: new Date("2026-08-10T04:00:00.000Z"),
      cookies: [{
        name: "session",
        value: secret,
        domain: ".example.test",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        session: false,
        expirationDate: 2_000_000_000,
      }],
      history: [{ url: "https://example.test/account" }],
    });

    assert.equal(result.imported, 1);
    assert.equal(result.historyImported, 1);
    assert.equal(result.directCodexImport, true);
    assert.equal(fs.existsSync(path.join(result.backupPath, "Cookies")), true);
    assert.equal(fs.existsSync(path.join(result.backupPath, "History")), true);

    const cookies = new DatabaseSync(cookiePath, { readOnly: true });
    const row = cookies.prepare("SELECT value, encrypted_value FROM cookies WHERE host_key = '.example.test' AND name = 'session'").get();
    assert.equal(row.value, secret);
    assert.equal(Buffer.from(row.encrypted_value).length, 0);
    assert.equal(Object.values(cookies.prepare("PRAGMA quick_check").get())[0], "ok");
    cookies.close();

    const history = new DatabaseSync(historyPath, { readOnly: true });
    assert.equal(history.prepare("SELECT COUNT(*) AS count FROM urls WHERE url = 'https://example.test/account'").get().count, 1);
    assert.equal(history.prepare("SELECT COUNT(*) AS count FROM visits").get().count, 1);
    history.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("direct Codex import replaces and backs up full site data", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-site-data-"));
  try {
    const cookiePath = codexCookiePaths(home)[0];
    const codexProfile = path.dirname(path.dirname(cookiePath));
    const sourceProfile = path.join(home, "source-profile");
    createCookieDatabase(cookiePath);
    fs.mkdirSync(path.join(codexProfile, "Local Storage", "leveldb"), { recursive: true });
    fs.writeFileSync(path.join(codexProfile, "Local Storage", "leveldb", "old.log"), "codex-old");
    fs.mkdirSync(path.join(sourceProfile, "Local Storage", "leveldb"), { recursive: true });
    fs.writeFileSync(path.join(sourceProfile, "Local Storage", "leveldb", "new.log"), "source-new");
    fs.mkdirSync(path.join(sourceProfile, "IndexedDB", "https_example.test_0.indexeddb.leveldb"), { recursive: true });
    fs.writeFileSync(path.join(sourceProfile, "IndexedDB", "https_example.test_0.indexeddb.leveldb", "CURRENT"), "MANIFEST-000001");

    const result = directImportToCodex({
      home,
      runningCheck: () => false,
      now: new Date("2026-08-14T04:00:00.000Z"),
      cookies: [],
      sourceProfilePath: sourceProfile,
      siteStorage: true,
    });

    assert.equal(result.siteStorageImported, 2);
    assert.deepEqual(result.siteStorageNames, ["Local Storage", "IndexedDB"]);
    assert.equal(fs.readFileSync(path.join(codexProfile, "Local Storage", "leveldb", "new.log"), "utf8"), "source-new");
    assert.equal(fs.existsSync(path.join(codexProfile, "Local Storage", "leveldb", "old.log")), false);
    assert.equal(fs.readFileSync(path.join(result.backupPath, "Site Storage", "Local Storage", "leveldb", "old.log"), "utf8"), "codex-old");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function createCookieDatabase(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const database = new DatabaseSync(target);
  database.exec(`
    CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL,
      last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX cookies_unique_index
      ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);
    INSERT INTO meta(key, value) VALUES ('last_compatible_version', '24'), ('version', '24');
  `);
  database.close();
}

function createHistoryDatabase(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const database = new DatabaseSync(target);
  database.exec(`
    CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    CREATE TABLE urls(
      id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
      last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL
    );
    CREATE INDEX urls_url_index ON urls(url);
    CREATE TABLE visits(
      id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
      from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL,
      visit_duration INTEGER DEFAULT 0 NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('last_compatible_version', '70'), ('version', '70');
  `);
  database.close();
}
