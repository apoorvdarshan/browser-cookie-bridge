import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readChromiumProfile } from "../src/chromium-reader.js";
import { deriveChromeEncryptionKey, encryptChromeCookieValue } from "../src/codex-import.js";

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
        has_expires INTEGER, is_persistent INTEGER, samesite INTEGER
      );
    `);
    const encrypted = encryptChromeCookieValue({
      domain: ".example.test",
      value: "native-reader-secret",
      encryptionKey: deriveChromeEncryptionKey(password),
    });
    database.prepare("INSERT INTO cookies VALUES (?, '', ?, '', ?, '/', 0, 1, 1, 0, 0, 1)")
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
    assert.equal(result.cookies[0].value, "native-reader-secret");
    assert.equal(result.cookies[0].sameSite, "lax");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
