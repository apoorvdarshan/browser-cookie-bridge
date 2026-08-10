import assert from "node:assert/strict";
import test from "node:test";
import { buildLoginSyncPlist } from "../src/scheduler.js";

test("login sync LaunchAgent runs once when the user session loads", () => {
  const plist = buildLoginSyncPlist({
    nodePath: "/path/to/node",
    cliPath: "/path/with & symbol/sync.js",
    support: "/tmp/browser sync",
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(plist, /StartInterval|StartCalendarInterval/);
  assert.match(plist, /\/path\/with &amp; symbol\/sync\.js/);
  assert.match(plist, /<string>300<\/string>/);
});
