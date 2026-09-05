import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildGrokBotBundle,
  cookieMatchesDomains,
  filterCookies,
  grokBotSummary,
  parseGrokBotBundle,
  writeGrokBotBundle,
} from "../src/grok-bot-export.js";
import { decryptPayload, validateManifest } from "../src/grok-bot-importer.mjs";

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

test("Grok Bot bundle encrypts cookies and round-trips with the one-time key", () => {
  const passphrase = "test-passphrase-123";
  const bundle = buildGrokBotBundle({
    cookies: SAMPLE_COOKIES,
    sourceBrowser: "brave",
    onlyDomains: ["example.com"],
    passphrase,
    importerSource: "// test importer\n",
  });
  const parsed = parseGrokBotBundle(bundle.archive);
  validateManifest(parsed.manifest);
  assert.match(parsed.importer, /test importer/);
  assert.match(parsed.prompt, /Grok Bot cloud computer only/);
  assert.ok(!parsed.importer.includes("abc123"));
  assert.ok(!Buffer.from(bundle.archive).includes(Buffer.from("abc123")));

  const decrypted = decryptPayload({
    manifest: parsed.manifest,
    encrypted: parsed.payload,
    passphrase,
  });
  assert.equal(decrypted.length, 1);
  assert.equal(decrypted[0].name, "session");
  assert.equal(decrypted[0].domain, ".example.com");
});

test("Grok Bot bundle writer creates a private .bcbx file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bot-export-"));
  const outputPath = path.join(directory, "GrokBot-Import.bcbx");
  const result = writeGrokBotBundle({
    outputPath,
    cookies: SAMPLE_COOKIES,
    sourceBrowser: "brave",
    onlyDomains: [],
    passphrase: "writer-passphrase",
  });
  assert.equal(result.outputPath, outputPath);
  assert.ok(fs.existsSync(outputPath));
  const mode = fs.statSync(outputPath).mode & 0o777;
  assert.equal(mode, 0o600);
  const parsed = parseGrokBotBundle(fs.readFileSync(outputPath));
  assert.equal(parsed.manifest.cookieCount, 2);
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
  assert.match(summary, /one-time key privately/);
});

test("wrong passphrase fails closed", () => {
  const bundle = buildGrokBotBundle({
    cookies: SAMPLE_COOKIES,
    sourceBrowser: "brave",
    passphrase: "correct-key",
    importerSource: "// importer\n",
  });
  const parsed = parseGrokBotBundle(bundle.archive);
  assert.throws(
    () => decryptPayload({ manifest: parsed.manifest, encrypted: parsed.payload, passphrase: "wrong-key" }),
    /Unsupported state|auth|decrypt/i,
  );
});
