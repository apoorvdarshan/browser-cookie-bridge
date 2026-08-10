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
    const installed = installConfig({ home, hour: 9, minute: 15 });
    assert.equal(installed.sourceBrowser, "brave");
    assert.deepEqual(installed.imports, { cookies: true, passwords: false, history: false });
    for (const browser of [...SOURCE_BROWSERS, "codex"]) {
      assert.equal(fs.existsSync(path.join(installedExtensionDir(home, browser), "manifest.json")), true);
    }

    updatePreferences({ home, sourceBrowser: "edge", cookies: false, history: true });
    const updated = readConfig(home);
    assert.equal(updated.sourceBrowser, "edge");
    assert.deepEqual(updated.imports, { cookies: false, passwords: false, history: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
