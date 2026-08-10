import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "com.apoorvdarshan.brave-codex-cookie-sync";
export const LOGIN_SYNC_APP_ID = `${APP_ID}.login-sync`;
export const APP_LOGIN_APP_ID = `${APP_ID}.app-login`;
export const DEFAULT_PORT = 43128;
export const EXTENSION_ID = "ihanfnkcipmlhmokbcinlkdfcfheofjb";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const SOURCE_BROWSERS = ["brave", "chrome", "edge", "arc", "vivaldi", "opera", "comet", "atlas"];
export const TARGET_BROWSERS = [...SOURCE_BROWSERS, "codex"];

export function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function appSupportDir(home = os.homedir()) {
  return path.join(home, "Library", "Application Support", "BraveCodexCookieSync");
}

export function configPath(home = os.homedir()) {
  return path.join(appSupportDir(home), "config.json");
}

export function installedExtensionDir(home = os.homedir(), role = "brave") {
  return path.join(appSupportDir(home), `extension-${role}`);
}

export function launchAgentPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${APP_ID}.plist`);
}

export function loginSyncLaunchAgentPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${LOGIN_SYNC_APP_ID}.plist`);
}

export function appLoginLaunchAgentPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${APP_LOGIN_APP_ID}.plist`);
}

export function installedAppPath(home = os.homedir()) {
  return path.join(home, "Applications", "Browser ChatGPT Sync.app");
}

export function braveCookiePaths(home = os.homedir()) {
  const root = path.join(
    home,
    "Library",
    "Application Support",
    "BraveSoftware",
    "Brave-Browser",
  );
  return ["Default", ...Array.from({ length: 20 }, (_, index) => `Profile ${index + 1}`)]
    .flatMap((profile) => [
      path.join(root, profile, "Network", "Cookies"),
      path.join(root, profile, "Cookies"),
    ]);
}

export function codexCookiePaths(home = os.homedir()) {
  const root = path.join(home, "Library", "Application Support", "Codex");
  return [
    path.join(root, "Default", "Partitions", "codex-browser-app", "Network", "Cookies"),
    path.join(root, "Default", "Partitions", "codex-browser-app", "Cookies"),
    path.join(root, "Default", "Cookies"),
    path.join(root, "codex-browser-app", "Cookies"),
  ];
}
