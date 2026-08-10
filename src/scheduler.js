import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_ID,
  LOGIN_SYNC_APP_ID,
  appSupportDir,
  launchAgentPath,
  loginSyncLaunchAgentPath,
} from "./paths.js";

export function installSchedule({ hour, minute, cliPath, nodePath = process.execPath, home = os.homedir() }) {
  const plist = launchAgentPath(home);
  const support = appSupportDir(home);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.join(support, "logs"), { recursive: true, mode: 0o700 });

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliPath)}</string>
    <string>sync</string>
    <string>--timeout</string>
    <string>300</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(support, "logs", "sync.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(support, "logs", "sync-error.log"))}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plist, content, { mode: 0o600 });

  bootstrap(plist, "daily schedule");
  return plist;
}

export function installLoginSync({ cliPath, nodePath = process.execPath, home = os.homedir() }) {
  const plist = loginSyncLaunchAgentPath(home);
  const support = appSupportDir(home);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.join(support, "logs"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plist, buildLoginSyncPlist({ cliPath, nodePath, support }), { mode: 0o600 });
  bootstrap(plist, "login sync");
  return plist;
}

export function buildLoginSyncPlist({ cliPath, nodePath, support }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_SYNC_APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliPath)}</string>
    <string>sync</string>
    <string>--timeout</string>
    <string>300</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(support, "logs", "login-sync.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(support, "logs", "login-sync-error.log"))}</string>
</dict>
</plist>
`;
}

export function removeSchedule(home = os.homedir()) {
  const plist = launchAgentPath(home);
  if (!fs.existsSync(plist)) return false;
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
  fs.unlinkSync(plist);
  return true;
}

export function removeLoginSync(home = os.homedir()) {
  const plist = loginSyncLaunchAgentPath(home);
  if (!fs.existsSync(plist)) return false;
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
  fs.unlinkSync(plist);
  return true;
}

function bootstrap(plist, description) {
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `launchctl could not install the ${description}`);
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
