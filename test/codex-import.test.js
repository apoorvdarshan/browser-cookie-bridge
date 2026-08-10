import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  chromeStagingProfilePath,
  deriveChromeEncryptionKey,
  stageCodexImport,
} from "../src/codex-import.js";

test("Codex staging writes an encrypted Chrome profile without plaintext cookie values", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-"));
  try {
    const secret = "cookie-secret-that-must-not-be-plaintext";
    const password = "test-safe-storage-password";
    const result = stageCodexImport({
      home,
      password,
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

    assert.equal(result.stagedCookies, 1);
    assert.equal(result.stagedHistory, 1);
    assert.equal(result.requiresCodexImport, true);
    assert.equal(result.profilePath, chromeStagingProfilePath(home));

    const cookieDatabasePath = path.join(result.profilePath, "Cookies");
    const rawDatabase = fs.readFileSync(cookieDatabasePath);
    assert.equal(rawDatabase.includes(Buffer.from(secret)), false);

    const database = new DatabaseSync(cookieDatabasePath, { readOnly: true });
    const row = database.prepare("SELECT host_key, value, encrypted_value FROM cookies WHERE name = 'session'").get();
    database.close();
    assert.equal(row.host_key, ".example.test");
    assert.equal(row.value, "");
    assert.equal(Buffer.from(row.encrypted_value).subarray(0, 3).toString(), "v10");

    const key = deriveChromeEncryptionKey(password);
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_value).subarray(3)),
      decipher.final(),
    ]);
    assert.deepEqual(plaintext.subarray(0, 32), crypto.createHash("sha256").update(row.host_key).digest());
    assert.equal(plaintext.subarray(32).toString(), secret);

    const localState = JSON.parse(fs.readFileSync(path.join(path.dirname(result.profilePath), "Local State"), "utf8"));
    assert.equal(localState.profile.info_cache["Browser Cookie Bridge"].name, "Browser Cookie Bridge");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
