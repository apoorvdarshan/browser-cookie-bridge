import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { isChromiumBrowserRunning, readChromiumProfile } from "../src/chromium-reader.js";

test("detects whether the selected Chromium source is running", () => {
  const processes = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --profile-directory=Default",
    "/Applications/Other.app/Contents/MacOS/Other",
  ].join("\n");
  assert.equal(isChromiumBrowserRunning({ browser: "brave", processList: processes }), true);
  assert.equal(isChromiumBrowserRunning({ browser: "chrome", processList: processes }), false);
});

test("native Chromium reader decrypts a version 24 cookie profile while the database is readable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-reader-"));
  const password = "brave-test-password";
  try {
    const root = path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
    const profile = path.join(root, "Default");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }));
    const database = new DatabaseSync(path.join(profile, "Cookies"));
    database.exec(`
      CREATE TABLE cookies(
        host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
        path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
        has_expires INTEGER, is_persistent INTEGER, samesite INTEGER,
        has_cross_site_ancestor INTEGER
      );
    `);
    const encrypted = encryptChromeCookieValue({
      domain: ".example.test",
      value: "native-reader-secret",
      encryptionKey: deriveChromeEncryptionKey(password),
    });
    database.prepare("INSERT INTO cookies VALUES (?, '', ?, '', ?, '/', 0, 1, 1, 0, 0, 1, 1)")
      .run(".example.test", "session", encrypted);
    database.close();

    const result = readChromiumProfile({
      browser: "brave",
      home,
      password,
      imports: { cookies: true, history: false },
    });
    assert.equal(result.profileName, "Default");
    assert.equal(result.cookies.length, 1);
    assert.deepEqual(result.cookieStats, { total: 1, imported: 1, skipped: 0 });
    assert.equal(result.cookies[0].value, "native-reader-secret");
    assert.equal(result.cookies[0].sameSite, "lax");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("native Chromium reader falls back to a temporary snapshot when the browser holds an exclusive lock", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-reader-locked-"));
  const password = "brave-test-password";
  let holder;
  try {
    const root = path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
    const profile = path.join(root, "Default");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }));
    const databasePath = path.join(profile, "Cookies");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE cookies(
        host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
        path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
        has_expires INTEGER, is_persistent INTEGER, samesite INTEGER,
        has_cross_site_ancestor INTEGER
      );
    `);
    database.prepare("INSERT INTO cookies VALUES (?, '', ?, ?, X'', '/', 0, 1, 1, 0, 0, 1, 1)")
      .run(".locked.test", "plain", "visible-value");
    database.close();

    // Mimic Chromium: in EXCLUSIVE locking mode the first committed write keeps the file lock until close.
    holder = new DatabaseSync(databasePath);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; UPDATE cookies SET path = '/' WHERE 0;");
    assert.throws(
      () => new DatabaseSync(databasePath, { readOnly: true }).prepare("SELECT count(*) AS n FROM cookies").get(),
      /locked|busy/i,
      "precondition: the direct read must be blocked by the exclusive lock",
    );

    const result = readChromiumProfile({
      browser: "brave",
      home,
      password,
      imports: { cookies: true, history: false },
    });
    assert.equal(result.cookies.length, 1);
    assert.equal(result.cookies[0].value, "visible-value");
    assert.equal(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("bcb-cookie-snapshot-")).length, 0);
  } finally {
    try { holder?.close(); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function deriveChromeEncryptionKey(password) {
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function encryptChromeCookieValue({ domain, value, encryptionKey }) {
  const hostDigest = crypto.createHash("sha256").update(domain).digest();
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([hostDigest, Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), encrypted]);
}
