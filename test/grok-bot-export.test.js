import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUNDLE_FORMAT_VERSION,
  buildGrokBotBundle,
  cookieMatchesDomains,
  filterCookies,
  grokBotSummary,
  parseGrokBotBundle,
  writeGrokBotBundle,
} from "../src/grok-bot-export.js";
import { decryptPayload, resolveDecryptionKey, validateManifest } from "../src/grok-bot-importer.mjs";

const SAMPLE_COOKIES = [
  {
    name: "session",
    value: "abc123",
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: false,
    expirationDate: 1_900_000_000,
  },
  {
    name: "other",
    value: "def456",
    domain: "app.other.test",
    hostOnly: true,
    path: "/app",
    secure: false,
    httpOnly: false,
    sameSite: "strict",
    session: true,
  },
];

test("Grok Bot bundle encrypts cookies and auto-decrypts with the embedded key", async () => {
  const bundle = buildGrokBotBundle({
    cookies: SAMPLE_COOKIES,
    sourceBrowser: "brave",
    onlyDomains: ["example.com"],
    importerSource: "// test importer\n",
  });
  const parsed = parseGrokBotBundle(bundle.archive);
  validateManifest(parsed.manifest);
  assert.equal(parsed.manifest.version, BUNDLE_FORMAT_VERSION);
  assert.equal(parsed.manifest.keyDelivery, "embedded");
  assert.equal(parsed.embeddedKey, bundle.passphrase);
  assert.match(parsed.importer, /test importer/);
  assert.match(parsed.prompt, /Grok Bot cloud computer only/);
  assert.doesNotMatch(parsed.prompt, /one-time decryption key/i);
  assert.ok(!parsed.importer.includes("abc123"));
  assert.ok(!Buffer.from(bundle.archive).includes(Buffer.from("abc123")));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bot-import-"));
  try {
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(parsed.manifest));
    fs.writeFileSync(path.join(directory, "payload.enc"), parsed.payload);
    fs.writeFileSync(path.join(directory, "decryption.key"), `${parsed.embeddedKey}\n`);

    const passphrase = await resolveDecryptionKey({ manifest: parsed.manifest, bundleDir: directory });
    assert.equal(passphrase, bundle.passphrase);

    const decrypted = decryptPayload({
      manifest: parsed.manifest,
      encrypted: parsed.payload,
      passphrase,
    });
    assert.equal(decrypted.length, 1);
    assert.equal(decrypted[0].name, "session");
    assert.equal(decrypted[0].domain, ".example.com");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Grok Bot bundle writer creates a private .bcbx file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bot-export-"));
  const outputPath = path.join(directory, "GrokBot-Import.bcbx");
  const result = writeGrokBotBundle({
    outputPath,
    cookies: SAMPLE_COOKIES,
    sourceBrowser: "brave",
    onlyDomains: [],
  });
  assert.equal(result.outputPath, outputPath);
  assert.ok(fs.existsSync(outputPath));
  const mode = fs.statSync(outputPath).mode & 0o777;
  assert.equal(mode, 0o600);
  const parsed = parseGrokBotBundle(fs.readFileSync(outputPath));
  assert.equal(parsed.manifest.cookieCount, 2);
  assert.equal(parsed.manifest.version, BUNDLE_FORMAT_VERSION);
  assert.ok(parsed.embeddedKey);
});

test("domain filtering and summary text stay explicit", () => {
  assert.equal(cookieMatchesDomains({ domain: ".example.com" }, ["example.com"]), true);
  assert.equal(cookieMatchesDomains({ domain: "app.example.com" }, ["example.com"]), true);
  assert.equal(cookieMatchesDomains({ domain: "other.test" }, ["example.com"]), false);
  assert.equal(filterCookies(SAMPLE_COOKIES, ["example.com"]).length, 1);

  const summary = grokBotSummary({
    outputPath: "/tmp/GrokBot-Import.bcbx",
    cookieCount: 3,
    domainCount: 2,
    sourceBrowser: "brave",
    sourceCookieSkipped: 1,
  });
  assert.match(summary, /Grok Bot transfer file created/);
  assert.match(summary, /treat the file as credentials/);
  assert.doesNotMatch(summary, /one-time key privately/);
});

test("wrong embedded key fails closed", () => {
  const bundle = buildGrokBotBundle({
    cookies: SAMPLE_COOKIES,
    sourceBrowser: "brave",
    importerSource: "// importer\n",
  });
  const parsed = parseGrokBotBundle(bundle.archive);
  assert.throws(
    () => decryptPayload({ manifest: parsed.manifest, encrypted: parsed.payload, passphrase: "wrong-key" }),
    /Unsupported state|auth|decrypt/i,
  );
});

test("v2 bundles fail closed when the embedded key file is missing", async () => {
  const manifest = {
    format: "browser-cookie-bridge-grok-bot",
    version: 2,
    keyDelivery: "embedded",
    keyFile: "decryption.key",
    salt: "abc",
    iv: "def",
    authTag: "ghi",
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bot-missing-key-"));
  try {
    await assert.rejects(
      () => resolveDecryptionKey({ manifest, bundleDir: directory }),
      /Embedded decryption key file is missing/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy v1 bundles still accept a prompted passphrase", async () => {
  const passphrase = "legacy-passphrase";
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const payload = Buffer.from(JSON.stringify({ cookies: [{ name: "a", value: "b", domain: ".example.com", path: "/" }] }), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  const manifest = {
    format: "browser-cookie-bridge-grok-bot",
    version: 1,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: encrypted.subarray(encrypted.length - 16).toString("base64url"),
    kdf: { N: 16384, r: 8, p: 1 },
  };
  validateManifest(manifest);

  const previous = process.env.BCB_IMPORT_KEY;
  process.env.BCB_IMPORT_KEY = passphrase;
  try {
    const resolved = await resolveDecryptionKey({ manifest, bundleDir: os.tmpdir() });
    assert.equal(resolved, passphrase);
    const decrypted = decryptPayload({
      manifest,
      encrypted: encrypted.subarray(0, encrypted.length - 16),
      passphrase: resolved,
    });
    assert.equal(decrypted.length, 1);
  } finally {
    if (previous === undefined) delete process.env.BCB_IMPORT_KEY;
    else process.env.BCB_IMPORT_KEY = previous;
  }
});
