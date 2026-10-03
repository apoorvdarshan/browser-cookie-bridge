import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildCloudTransferBundle, parseCloudTransferBundle, writeCloudTransferBundle, formatCloudTransferResultLine } from "../src/cloud-transfer-export.js";
import { decryptPayload, validateManifest, findDevToolsEndpoint, validateDevToolsUrl, parseArguments, injectCookies } from "../src/cloud-transfer-importer.mjs";
import { installConfig, updatePreferences } from "../src/config.js";
import { main as cli } from "../src/cli.js";

const cookies = Array.from({ length: 45 }, (_, index) => ({
  name: `fixture-${index}`, value: "synthetic-sensitive-value", domain: ".example.test",
  path: "/", secure: true, httpOnly: true, sameSite: "strict", hostOnly: false,
  session: false, expirationDate: 1_900_000_000,
}));

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bcb-dots-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Dots bundle filters and encrypts cookies with its own manifest and manual instructions", () => {
  const bundle = buildCloudTransferBundle({ target: "dots", cookies, sourceBrowser: "brave", onlyDomains: ["example.test"] });
  const parsed = parseCloudTransferBundle(bundle.archive);
  validateManifest(parsed.manifest);
  assert.equal(parsed.manifest.format, "browser-cookie-bridge-dots");
  assert.equal(bundle.bundleName, "Dots-Import.bcbx");
  assert.equal(decryptPayload({ manifest: parsed.manifest, encrypted: parsed.payload, passphrase: parsed.embeddedKey }).length, 45);
  assert.equal(bundle.archive.includes(Buffer.from(cookies[0].value)), false);
  assert.match(parsed.prompt, /Dots cloud computer only/);
  assert.match(parsed.prompt, /Import authentication cookies yourself/);
  assert.match(parsed.prompt, /Take over/);
  assert.match(parsed.prompt, /sign.in privately|private sign-in/);
  assert.doesNotMatch(parsed.prompt, /Save the attached|paste the prompt/);
  assert.match(parsed.prompt, /existing managed cloud browser/);
  assert.match(parsed.prompt, /--bundle ..\/Dots-Import.bcbx/);
  assert.doesNotMatch(parsed.prompt, /Grok/);
  const line = formatCloudTransferResultLine({ outputPath: "/tmp/Dots-Import.bcbx", prompt: parsed.prompt }, "dots");
  assert.match(line, /^BCB_DOTS_RESULT /);
  assert.doesNotMatch(line, /synthetic-sensitive-value|fixture-0/);
  assert.equal(Object.keys(JSON.parse(line.slice("BCB_DOTS_RESULT ".length))).length, 2);
  assert.throws(() => buildCloudTransferBundle({ target: "dots", cookies, onlyDomains: ["unmatched.test"] }), /No cookies matched/);
  assert.throws(() => buildCloudTransferBundle({ target: "unknown", cookies }), /Unsupported cloud transfer/);
});

test("Dots replaces a private bundle and rejects an invalid filename before writing", (t) => {
  const directory = temporary(t);
  const outputPath = path.join(directory, "Dots-Import.bcbx");
  fs.writeFileSync(outputPath, "old bundle");
  writeCloudTransferBundle({ target: "dots", cookies, sourceBrowser: "chrome", outputPath });
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(parseCloudTransferBundle(fs.readFileSync(outputPath)).manifest.sourceBrowser, "chrome");
  const wrongPath = path.join(directory, "bundle.txt");
  assert.throws(() => writeCloudTransferBundle({ target: "dots", cookies, outputPath: wrongPath }), /Dots bundles must use/);
  assert.equal(fs.existsSync(wrongPath), false);
});

test("Dots and Grok keep separate filters and restore choices after cookie-only destinations", (t) => {
  const home = temporary(t);
  installConfig({ home });
  const preferences = { home, sourceBrowser: "brave", cookies: true, history: true, siteStorage: true };
  updatePreferences({ ...preferences, targetBrowser: "codex" });
  let config = updatePreferences({ ...preferences, targetBrowser: "dots", dotsOnlyDomains: "Example.test, example.test", grokBotOnlyDomains: "other.test" });
  assert.equal(config.imports.history, false);
  assert.equal(config.imports.siteStorage, false);
  assert.deepEqual(config.dots.onlyDomains, ["example.test"]);
  assert.deepEqual(config.grokBot.onlyDomains, ["other.test"]);
  config = installConfig({ home });
  assert.equal(config.targetBrowser, "dots");
  assert.deepEqual(config.rememberedImports, { history: true, siteStorage: true });
  updatePreferences({ ...preferences, targetBrowser: "grok-bot", history: false, siteStorage: false });
  config = updatePreferences({ ...preferences, targetBrowser: "codex", history: false, siteStorage: false });
  assert.equal(config.imports.history, true);
  assert.equal(config.imports.siteStorage, true);
  assert.deepEqual(config.dots.onlyDomains, ["example.test"]);
});

test("scheduled Dots sync cannot export without a manual output path", { skip: process.platform !== "darwin" }, async (t) => {
  const home = temporary(t);
  t.mock.method(os, "homedir", () => home);
  installConfig({ home });
  updatePreferences({ home, sourceBrowser: "brave", targetBrowser: "dots", cookies: true });
  await assert.rejects(cli(["sync"]), /Dots export requires --output/);
  updatePreferences({ home, sourceBrowser: "brave", targetBrowser: "dots", cookies: false });
  await assert.rejects(cli(["sync", "--output", path.join(home, "Dots-Import.bcbx")]), /Dots export requires cookies/);
  assert.equal(fs.existsSync(path.join(home, "Dots-Import.bcbx")), false);
});

test("Dots requires a choice for separate browser contexts before injecting cookies", async (t) => {
  const commands = [];
  class BrowserSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(raw) {
      const message = JSON.parse(raw);
      commands.push(message);
      const result = message.method === "Target.getBrowserContexts" ? { browserContextIds: ["managed-context"] } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) })));
    }
    close() {}
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = BrowserSocket;
  t.after(() => { globalThis.WebSocket = previous; });
  await assert.rejects(injectCookies("ws://127.0.0.1/devtools/browser/a", cookies, { requireContextSelection: true }), /separate contexts/);
  assert.equal(commands.some((command) => command.method === "Storage.setCookies"), false);
  await assert.rejects(injectCookies("ws://127.0.0.1/devtools/browser/a", cookies, { browserContextId: "wrong" }), /unavailable/);
  const result = await injectCookies("ws://127.0.0.1/devtools/browser/a", cookies, { browserContextId: "managed-context" });
  assert.equal(result.imported, 45);
  const writes = commands.filter((command) => command.method === "Storage.setCookies");
  assert.equal(writes.length, 2);
  assert(writes.every((command) => command.params.browserContextId === "managed-context"));
});

test("DevTools discovery uses loopback endpoints and refuses ambiguous browsers", async (t) => {
  assert.equal(validateDevToolsUrl("ws://127.0.0.1:1234/devtools/browser/fixture").protocol, "ws:");
  for (const value of ["https://remote.test", "ws://remote.test/devtools/browser/a", "ws://127.0.0.1/devtools/page/a"]) {
    assert.throws(() => validateDevToolsUrl(value));
  }
  assert.deepEqual(parseArguments(["--bundle", "../Dots-Import.bcbx", "--cdp-url", "http://localhost:1234"]), {
    bundlePath: "../Dots-Import.bcbx", cdpUrl: "http://localhost:1234", browserContextId: undefined,
  });
  assert.throws(() => parseArguments(["--cdp-url"]), /Missing value/);
  t.mock.method(globalThis, "fetch", async (url) => new Response(JSON.stringify({
    webSocketDebuggerUrl: `ws://127.0.0.1:${new URL(url).port}/devtools/browser/fixture`,
  })));
  assert.match((await findDevToolsEndpoint({ ports: [1234] })).webSocketDebuggerUrl, /:1234/);
  await assert.rejects(findDevToolsEndpoint({ ports: [1234, 1235] }), /Multiple browsers/);
  assert.match((await findDevToolsEndpoint({ cdpUrl: "http://127.0.0.1:4444" })).webSocketDebuggerUrl, /:4444/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No browser"); });
  await assert.rejects(findDevToolsEndpoint({ ports: [1234] }), /Do not launch a separate browser/);
});

for (const failed of [false, true]) {
  test(`standalone Dots importer ${failed ? "keeps files and hides CDP error credentials on failure" : "batches cookies and removes transfer files after success"}`, (t) => {
    const directory = temporary(t);
    const extracted = path.join(directory, "extracted");
    fs.mkdirSync(extracted, { mode: 0o700 });
    const bundle = buildCloudTransferBundle({ target: "dots", cookies, sourceBrowser: "brave" });
    const parsed = parseCloudTransferBundle(bundle.archive);
    const bundlePath = path.join(directory, "Dots-Import.bcbx");
    fs.writeFileSync(bundlePath, bundle.archive);
    for (const [name, contents] of Object.entries({
      "manifest.json": JSON.stringify(parsed.manifest), "payload.enc": parsed.payload,
      "decryption.key": parsed.embeddedKey, "PROMPT.txt": parsed.prompt, "import.mjs": parsed.importer,
    })) fs.writeFileSync(path.join(extracted, name), contents);
    // Simulate a Linux cloud computer and its CDP transport with synthetic cookies only.
    const mockPath = path.join(directory, "mock-cloud.mjs");
    fs.writeFileSync(mockPath, `
      import fs from 'node:fs';
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const batches = [];
      globalThis.WebSocket = class extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send(raw) {
          const message = JSON.parse(raw);
          if (message.method === 'Target.getBrowserContexts') {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: { browserContextIds: [] } }) })));
            return;
          }
          if (message.method !== 'Storage.setCookies') throw new Error('Unexpected CDP command');
          batches.push(message.params.cookies);
          fs.writeFileSync(${JSON.stringify(path.join(directory, "batches.json"))}, JSON.stringify(batches));
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
            id: message.id, ${failed ? "error: { message: 'synthetic-sensitive-value' }" : "result: {}"}
          }) })));
        }
        close() {}
      };
    `);
    const result = spawnSync(process.execPath, ["--import", mockPath, "import.mjs", "--bundle", bundlePath, "--cdp-url", "ws://127.0.0.1:1234/devtools/browser/fixture"], { cwd: extracted, encoding: "utf8" });
    assert.equal(result.status, failed ? 1 : 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-sensitive-value|fixture-0/);
    assert.equal(fs.existsSync(bundlePath), failed);
    assert.equal(fs.existsSync(path.join(extracted, "decryption.key")), failed);
    if (!failed) {
      assert.match(result.stdout, /Imported 45 cookies/);
      assert.deepEqual(fs.readdirSync(extracted), []);
      const batches = JSON.parse(fs.readFileSync(path.join(directory, "batches.json")));
      assert.deepEqual(batches.map((batch) => batch.length), [40, 5]);
      assert.equal(batches[0][0].httpOnly, true);
      assert.equal(batches[0][0].sameSite, "Strict");
      assert.equal(batches[0][0].expires, 1_900_000_000);
    }
  });
}
