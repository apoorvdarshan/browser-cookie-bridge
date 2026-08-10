import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateUpdateRequest } from "../src/updater.js";

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
