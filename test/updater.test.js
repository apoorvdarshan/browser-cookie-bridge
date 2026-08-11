import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseChecksum, releaseAssetName, validateUpdateRequest } from "../src/updater.js";

test("updater accepts only semantic versions and installed app locations", () => {
  const home = path.join(os.tmpdir(), "browser-cookie-bridge-update-test");
  const userApp = path.join(home, "Applications", "Browser Cookie Bridge.app");
  assert.equal(validateUpdateRequest({ version: "1.2.3", appPath: userApp, appPID: 42, home }), userApp);
  assert.equal(
    validateUpdateRequest({ version: "1.2.3-beta.1", appPath: "/Applications/Browser Cookie Bridge.app", appPID: 42, home }),
    "/Applications/Browser Cookie Bridge.app",
  );
  assert.throws(
    () => validateUpdateRequest({ version: "latest", appPath: userApp, appPID: 42, home }),
    /Invalid update version/,
  );
  assert.throws(
    () => validateUpdateRequest({ version: "1.2.3", appPath: "/Applications/Another App.app", appPID: 42, home }),
    /unexpected app path/,
  );
});

test("updater selects architecture-specific DMGs and validates checksum files", () => {
  assert.equal(releaseAssetName("1.2.3", "arm64"), "Browser-Cookie-Bridge-arm64.dmg");
  assert.equal(releaseAssetName("1.2.3", "x64"), "Browser-Cookie-Bridge-x64.dmg");
  assert.throws(() => releaseAssetName("1.2.3", "ppc"), /Unsupported macOS architecture/);
  const digest = "a".repeat(64);
  assert.equal(parseChecksum(`${digest}  Browser-Cookie-Bridge-arm64.dmg\n`, "Browser-Cookie-Bridge-arm64.dmg"), digest);
  assert.throws(() => parseChecksum(`${digest}  another.dmg`, "Browser-Cookie-Bridge-arm64.dmg"), /Invalid release checksum/);
});
