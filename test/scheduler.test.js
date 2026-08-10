import assert from "node:assert/strict";
import test from "node:test";
import { buildAppLoginPlist, buildLoginSyncPlist } from "../src/scheduler.js";

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

test("app login LaunchAgent opens the installed app when the user session loads", () => {
  const plist = buildAppLoginPlist({ appPath: "/Applications/Browser & Codex.app" });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>\/usr\/bin\/open<\/string>/);
  assert.match(plist, /Browser &amp; Codex\.app/);
});
