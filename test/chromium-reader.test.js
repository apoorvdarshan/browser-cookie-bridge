import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  isChromiumBrowserRunning,
  isLockError,
  isPermissionError,
  probeCookieDatabaseAccess,
  readChromiumProfile,
  readCookieRows,
  resolveSourceSnapshot,
} from "../src/chromium-reader.js";
import { describeSourceCookieAccess } from "../src/cli.js";

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

test("permission errors are distinguished from SQLite lock errors", () => {
  const eperm = Object.assign(
    new Error("EPERM: operation not permitted, copyfile '/Users/me/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies' -> '/var/folders/x/bcb-cookie-snapshot-abc/Cookies'"),
    { code: "EPERM", errno: -1, syscall: "copyfile" },
  );
  assert.equal(isPermissionError(eperm), true);
  assert.equal(isPermissionError(Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" })), true);
  assert.equal(isPermissionError(new Error("operation not permitted")), true);
  assert.equal(isPermissionError(new Error("database is locked")), false);
  assert.equal(isLockError(new Error("database is locked")), true);
  assert.equal(isLockError(new Error("SQLITE_BUSY: database is locked")), true);
  assert.equal(isLockError(eperm), false);
});

test("an EPERM snapshot failure is reported as a Full Disk Access problem, not a locked database", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-reader-eperm-"));
  let holder;
  try {
    const databasePath = createCookieDatabase(home, [[".tcc.test", "plain", "visible-value"]]);
    // Chromium's exclusive lock makes the direct open fail, which is what routes the reader to the snapshot copy.
    holder = new DatabaseSync(databasePath);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; UPDATE cookies SET path = '/' WHERE 0;");

    const snapshot = () => {
      throw Object.assign(
        new Error(`EPERM: operation not permitted, copyfile '${databasePath}' -> '/var/folders/x/bcb-cookie-snapshot-abc/Cookies'`),
        { code: "EPERM", syscall: "copyfile" },
      );
    };
    assert.throws(
      () => readCookieRows(databasePath, { snapshot, browser: "brave" }),
      (error) => {
        assert.equal(error.code, "BCB_FULL_DISK_ACCESS");
        assert.match(error.message, /macOS denied access to the Brave Cookies database \(EPERM: operation not permitted\)/);
        assert.match(error.message, /Full Disk Access/);
        assert.match(error.message, /System Settings › Privacy & Security › Full Disk Access/);
        assert.match(error.message, /quit and reopen the app/);
        assert.match(error.message, /Quitting Brave does not fix this/);
        assert.doesNotMatch(error.message, /locked/i);
        assert.doesNotMatch(error.message, /Close the source browser/);
        assert.equal(error.message.includes("\n"), false, "the app shows only the last output line");
        return true;
      },
    );
  } finally {
    try { holder?.close(); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a genuine lock with a failing snapshot still tells the user to close the browser", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-reader-lock-"));
  let holder;
  try {
    const databasePath = createCookieDatabase(home, [[".lock.test", "plain", "visible-value"]]);
    holder = new DatabaseSync(databasePath);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; UPDATE cookies SET path = '/' WHERE 0;");
    const snapshot = () => { throw new Error("SQLITE_BUSY: database is locked"); };
    assert.throws(
      () => readCookieRows(databasePath, { snapshot, browser: "brave" }),
      /Cookie database is locked by the browser .* Close the source browser and try again\./,
    );
  } finally {
    try { holder?.close(); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable cookie file fails with the Full Disk Access message end to end", { skip: runningAsRoot && "chmod cannot block root" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-reader-denied-"));
  try {
    const databasePath = createCookieDatabase(home, [[".denied.test", "plain", "visible-value"]]);
    fs.chmodSync(databasePath, 0o000);
    assert.throws(
      () => readChromiumProfile({ browser: "brave", home, password: "x", imports: { cookies: true, history: false } }),
      (error) => {
        assert.equal(error.code, "BCB_FULL_DISK_ACCESS");
        assert.match(error.message, /Full Disk Access/);
        assert.doesNotMatch(error.message, /locked/i);
        return true;
      },
    );
    assert.equal(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("bcb-cookie-snapshot-")).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an app-provided snapshot directory is read instead of the live profile, even while the browser holds its lock", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-reader-app-snapshot-"));
  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bcb-app-snapshot-"));
  let holder;
  try {
    const livePath = createCookieDatabase(home, [[".live.test", "plain", "live-value"]]);
    // The macOS app copies Cookies plus sidecars with its own Full Disk Access; mimic that with a modified copy
    // so the assertion proves the reader never opened the live file.
    fs.copyFileSync(livePath, path.join(snapshotDirectory, "Cookies"));
    const copy = new DatabaseSync(path.join(snapshotDirectory, "Cookies"));
    copy.exec("UPDATE cookies SET value = 'snapshot-value'");
    copy.close();
    holder = new DatabaseSync(livePath);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; UPDATE cookies SET path = '/' WHERE 0;");

    const result = readChromiumProfile({
      browser: "brave",
      home,
      password: "unused",
      imports: { cookies: true, history: false },
      snapshotDirectory,
    });
    assert.equal(result.cookies.length, 1);
    assert.equal(result.cookies[0].value, "snapshot-value");
    assert.deepEqual(result.snapshot, { cookies: true, history: false });
    assert.equal(result.profileName, "Default");
    assert.equal(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("bcb-cookie-snapshot-")).length, 0);

    // An empty or stale snapshot directory must fall back to the live profile rather than fail.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bcb-app-snapshot-empty-"));
    try {
      holder.close();
      holder = undefined;
      const live = readChromiumProfile({ browser: "brave", home, password: "unused", snapshotDirectory: empty });
      assert.equal(live.cookies[0].value, "live-value");
      assert.deepEqual(live.snapshot, { cookies: false, history: false });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    try { holder?.close(); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  }
});

test("the snapshot directory is taken from BCB_SOURCE_SNAPSHOT_DIR by default", () => {
  const previous = process.env.BCB_SOURCE_SNAPSHOT_DIR;
  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bcb-app-snapshot-env-"));
  try {
    fs.writeFileSync(path.join(snapshotDirectory, "Cookies"), "");
    process.env.BCB_SOURCE_SNAPSHOT_DIR = snapshotDirectory;
    assert.deepEqual(resolveSourceSnapshot(), {
      directory: snapshotDirectory,
      cookies: path.join(snapshotDirectory, "Cookies"),
      history: null,
    });
    delete process.env.BCB_SOURCE_SNAPSHOT_DIR;
    assert.deepEqual(resolveSourceSnapshot(), { directory: null, cookies: null, history: null });
  } finally {
    if (previous === undefined) delete process.env.BCB_SOURCE_SNAPSHOT_DIR;
    else process.env.BCB_SOURCE_SNAPSHOT_DIR = previous;
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  }
});

test("probeCookieDatabaseAccess reports readable, denied, and missing cookie stores without opening SQLite", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-probe-"));
  try {
    assert.deepEqual(
      probeCookieDatabaseAccess({ browser: "brave", home }),
      { browser: "brave", databasePath: null, exists: false, readable: false, permissionDenied: false, reason: "not found" },
    );
    assert.equal(describeSourceCookieAccess("brave", home), "not found");

    const databasePath = createCookieDatabase(home, []);
    const readable = probeCookieDatabaseAccess({ browser: "brave", home });
    assert.equal(readable.databasePath, databasePath);
    assert.equal(readable.readable, true);
    assert.equal(readable.permissionDenied, false);
    assert.match(describeSourceCookieAccess("brave", home), /^readable \(/);

    const denied = describeSourceCookieAccess("brave", home, () => ({
      browser: "brave", databasePath, exists: true, readable: false, permissionDenied: true, reason: "EPERM",
    }));
    assert.match(denied, /^denied by macOS \(EPERM\) — grant Full Disk Access/);

    if (!runningAsRoot) {
      fs.chmodSync(databasePath, 0o000);
      const probe = probeCookieDatabaseAccess({ browser: "brave", home });
      assert.equal(probe.readable, false);
      assert.equal(probe.permissionDenied, true);
      assert.equal(probe.reason, "EACCES");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function createCookieDatabase(home, rows) {
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
  const insert = database.prepare("INSERT INTO cookies VALUES (?, '', ?, ?, X'', '/', 0, 1, 1, 0, 0, 1, 1)");
  for (const [host, name, value] of rows) insert.run(host, name, value);
  database.close();
  return databasePath;
}

function deriveChromeEncryptionKey(password) {
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function encryptChromeCookieValue({ domain, value, encryptionKey }) {
  const hostDigest = crypto.createHash("sha256").update(domain).digest();
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([hostDigest, Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), encrypted]);
}
