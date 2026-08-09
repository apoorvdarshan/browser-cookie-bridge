import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { EXTENSION_ID, projectRoot } from "../src/paths.js";

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
  assert.equal(projectRoot().endsWith("brave-codex-cookie-sync"), true);
});
