import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CODEX_RUNNING_ERROR,
  directImportToCodex,
  isCodexRunning,
} from "../src/codex-direct-import.js";
import { codexCookiePaths } from "../src/paths.js";

test("direct Codex import refuses to write while Codex is running", () => {
  assert.equal(isCodexRunning({ processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n" }), true);
  assert.equal(isCodexRunning({ processList: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n" }), false);
  assert.throws(
    () => directImportToCodex({ cookies: [], codexRunning: true }),
    new RegExp(CODEX_RUNNING_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
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
      codexRunning: false,
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
