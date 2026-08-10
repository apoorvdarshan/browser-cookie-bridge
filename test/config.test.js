import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installConfig, readConfig, updatePreferences } from "../src/config.js";
import { installedExtensionDir, SOURCE_BROWSERS } from "../src/paths.js";

test("preferences default to cookies and persist source and history choices", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-codex-sync-"));
  try {
    fs.mkdirSync(installedExtensionDir(home, "atlas"), { recursive: true });
    const installed = installConfig({ home, hour: 9, minute: 15 });
    assert.equal(installed.sourceBrowser, "brave");
    assert.equal(installed.targetBrowser, "codex");
    assert.deepEqual(installed.imports, { cookies: true, passwords: false, history: false });
    assert.deepEqual(installed.ui, { menuBar: true, openAtLogin: true, autoCheckUpdates: true });
    for (const browser of SOURCE_BROWSERS) {
      assert.equal(fs.existsSync(path.join(installedExtensionDir(home, browser), "manifest.json")), true);
    }
    assert.equal(fs.existsSync(installedExtensionDir(home, "codex")), false);
    assert.equal(fs.existsSync(installedExtensionDir(home, "atlas")), false);

    updatePreferences({
      home,
      sourceBrowser: "edge",
      targetBrowser: "chrome",
      cookies: false,
      history: true,
      menuBar: true,
      openAtLogin: false,
      autoCheckUpdates: false,
    });
    const updated = readConfig(home);
    assert.equal(updated.sourceBrowser, "edge");
    assert.equal(updated.targetBrowser, "chrome");
    assert.deepEqual(updated.imports, { cookies: false, passwords: false, history: true });
    assert.deepEqual(updated.ui, { menuBar: true, openAtLogin: false, autoCheckUpdates: false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a browser cannot import into itself", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-codex-sync-"));
  try {
    installConfig({ home, hour: 9, minute: 15 });
    assert.throws(() => updatePreferences({
      home,
      sourceBrowser: "brave",
      targetBrowser: "brave",
      cookies: true,
      history: false,
      menuBar: false,
      openAtLogin: true,
    }), /must be different/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
