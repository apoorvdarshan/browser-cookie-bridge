import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { EXTENSION_ID, SOURCE_BROWSERS, projectRoot } from "../src/paths.js";

test("manifest key produces the pinned extension ID", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../extension-template/manifest.json", import.meta.url), "utf8"),
  );
  const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  const id = digest
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
  assert.equal(id, EXTENSION_ID);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(projectRoot().endsWith("browser-cookie-bridge"), true);
});

test("Comet is available and retired Atlas is excluded", () => {
  assert.equal(SOURCE_BROWSERS.includes("comet"), true);
  assert.equal(SOURCE_BROWSERS.includes("atlas"), false);
});

test("browser extension routing is selected dynamically by the broker", () => {
  const background = fs.readFileSync(
    new URL("../extension-template/background.js", import.meta.url),
    "utf8",
  );
  assert.match(background, /SYNC_ROLE === "browser"/);
  assert.match(background, /SYNC_BROWSER === status\.sourceBrowser/);
  assert.match(background, /SYNC_BROWSER === status\.targetBrowser/);
  assert.match(background, /"X-Sync-Browser": SYNC_BROWSER/);
  assert.match(background, /reportFailure\("target", error\)/);
  assert.doesNotMatch(background, /importIntoCodex/);
});
