import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installConfig, installRuntime, readConfig, updatePreferences } from "../src/config.js";
import { installedExtensionDir, SOURCE_BROWSERS } from "../src/paths.js";

test("preferences default to cookies and persist source and history choices", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-codex-sync-"));
  try {
    fs.mkdirSync(installedExtensionDir(home, "atlas"), { recursive: true });
    const installed = installConfig({ home, hour: 9, minute: 15, nodePath: "/Applications/Browser Cookie Bridge.app/Contents/Resources/runtime/node/bin/node" });
    assert.equal(installed.sourceBrowser, "brave");
    assert.equal(installed.targetBrowser, "codex");
    assert.deepEqual(installed.imports, { cookies: true, passwords: false, history: false });
    assert.deepEqual(installed.ui, { menuBar: true, openAtLogin: true, autoCheckUpdates: true, autoRestartCodex: false });
    assert.deepEqual(installed.browserless, { profileName: "browser-cookie-bridge", region: "sfo", onlyDomains: [] });
    assert.equal(installed.nodePath, "/Applications/Browser Cookie Bridge.app/Contents/Resources/runtime/node/bin/node");
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
      autoRestartCodex: true,
      browserlessProfileName: "work-session",
      browserlessRegion: "ams",
      browserlessOnlyDomains: "example.com, app.example.com",
    });
    const updated = readConfig(home);
    assert.equal(updated.sourceBrowser, "edge");
    assert.equal(updated.targetBrowser, "chrome");
    assert.deepEqual(updated.imports, { cookies: false, passwords: false, history: true });
    assert.deepEqual(updated.ui, { menuBar: true, openAtLogin: false, autoCheckUpdates: false, autoRestartCodex: true });
    assert.deepEqual(updated.browserless, {
      profileName: "work-session",
      region: "ams",
      onlyDomains: ["example.com", "app.example.com"],
    });
    const reinstalled = installConfig({ home, hour: 10, minute: 30 });
    assert.equal(reinstalled.ui.autoRestartCodex, true);
    assert.equal(JSON.stringify(updated).includes("secret-token"), false);
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

test("a bundled runtime installs without Swift or Xcode source files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-codex-sync-home-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "browser-codex-sync-bundle-"));
  try {
    for (const directory of ["bin", "src", "extension-template", "node_modules"]) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
      fs.writeFileSync(path.join(source, directory, "placeholder"), directory);
    }
    fs.writeFileSync(path.join(source, "bin", "brave-codex-cookie-sync.js"), "#!/usr/bin/env node\n");
    for (const file of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      fs.writeFileSync(path.join(source, file), file);
    }

    const installed = installRuntime(home, source);
    assert.equal(fs.existsSync(path.join(installed, "bin", "brave-codex-cookie-sync.js")), true);
    assert.equal(fs.existsSync(path.join(installed, "node_modules", ".bin")), false);
    assert.equal(fs.existsSync(path.join(installed, "macos-app")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});
