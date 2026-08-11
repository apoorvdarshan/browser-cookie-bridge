import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PORT,
  configPath,
  installedExtensionDir,
  projectRoot,
  SOURCE_BROWSERS,
  TARGET_BROWSERS,
} from "./paths.js";

export function readConfig(home) {
  const target = configPath(home);
  if (!fs.existsSync(target)) {
    throw new Error("Not configured. Run `browser-cookie-bridge setup` first.");
  }
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!config.token || !Number.isInteger(config.port)) {
    throw new Error(`Invalid configuration at ${target}`);
  }
  return config;
}

export function installConfig({ home, hour = 9, minute = 0, nodePath = process.execPath }) {
  const target = configPath(home);
  const support = path.dirname(target);
  fs.mkdirSync(support, { recursive: true, mode: 0o700 });

  let existing = {};
  if (fs.existsSync(target)) {
    existing = JSON.parse(fs.readFileSync(target, "utf8"));
  }

  const sourceBrowser = SOURCE_BROWSERS.includes(existing.sourceBrowser) ? existing.sourceBrowser : "brave";
  const configuredTarget = TARGET_BROWSERS.includes(existing.targetBrowser) ? existing.targetBrowser : "codex";
  const config = {
    version: 2,
    token: existing.token || crypto.randomBytes(32).toString("base64url"),
    port: existing.port || DEFAULT_PORT,
    nodePath,
    sourceBrowser,
    targetBrowser: configuredTarget === sourceBrowser ? "codex" : configuredTarget,
    imports: {
      cookies: existing.imports?.cookies !== false,
      passwords: false,
      history: existing.imports?.history === true,
    },
    ui: {
      menuBar: existing.ui?.menuBar !== false,
      openAtLogin: existing.ui?.openAtLogin !== false,
      autoCheckUpdates: existing.ui?.autoCheckUpdates !== false,
    },
    browserless: {
      profileName: cleanProfileName(existing.browserless?.profileName) || "browser-cookie-bridge",
      region: ["sfo", "lon", "ams"].includes(existing.browserless?.region) ? existing.browserless.region : "sfo",
      onlyDomains: cleanDomains(existing.browserless?.onlyDomains),
    },
    schedule: { hour, minute },
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writePrivateJson(target, config);
  for (const browser of SOURCE_BROWSERS) installExtension(config, home, browser, "browser");
  fs.rmSync(installedExtensionDir(home, "codex"), { recursive: true, force: true });
  fs.rmSync(installedExtensionDir(home, "atlas"), { recursive: true, force: true });
  return config;
}

export function updatePreferences({
  home,
  cookies,
  history,
  sourceBrowser,
  targetBrowser,
  menuBar,
  openAtLogin,
  autoCheckUpdates,
  browserlessProfileName,
  browserlessRegion,
  browserlessOnlyDomains,
}) {
  const config = readConfig(home);
  if (!SOURCE_BROWSERS.includes(sourceBrowser)) {
    throw new Error(`Unsupported source browser: ${sourceBrowser}`);
  }
  if (!TARGET_BROWSERS.includes(targetBrowser)) {
    throw new Error(`Unsupported target browser: ${targetBrowser}`);
  }
  if (sourceBrowser === targetBrowser) {
    throw new Error("Source and target browsers must be different");
  }
  config.sourceBrowser = sourceBrowser;
  config.targetBrowser = targetBrowser;
  config.imports = { cookies: Boolean(cookies), passwords: false, history: Boolean(history) };
  config.ui = {
    menuBar: Boolean(menuBar),
    openAtLogin: Boolean(openAtLogin),
    autoCheckUpdates: Boolean(autoCheckUpdates),
  };
  const region = browserlessRegion ?? config.browserless?.region ?? "sfo";
  if (!["sfo", "lon", "ams"].includes(region)) throw new Error("Browserless region must be sfo, lon, or ams");
  config.browserless = {
    profileName: cleanProfileName(browserlessProfileName ?? config.browserless?.profileName) || "browser-cookie-bridge",
    region,
    onlyDomains: cleanDomains(browserlessOnlyDomains ?? config.browserless?.onlyDomains),
  };
  config.updatedAt = new Date().toISOString();
  writePrivateJson(configPath(home), config);
  return config;
}

export function installRuntime(home, source = projectRoot()) {
  const target = path.join(path.dirname(configPath(home)), "runtime");
  if (path.resolve(source) === path.resolve(target)) return target;

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["bin", "src", "extension-template", "node_modules"]) {
    fs.rmSync(path.join(target, name), { recursive: true, force: true });
    fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(target, "node_modules", ".bin"), { recursive: true, force: true });
  const appSource = path.join(source, "macos-app");
  const appTarget = path.join(target, "macos-app");
  fs.rmSync(appTarget, { recursive: true, force: true });
  if (fs.existsSync(appSource)) {
    fs.mkdirSync(appTarget, { recursive: true, mode: 0o700 });
    for (const name of ["Sources", "Resources"]) {
      fs.cpSync(path.join(appSource, name), path.join(appTarget, name), { recursive: true, force: true });
    }
    for (const name of ["Package.swift", "Info.plist"]) {
      fs.copyFileSync(path.join(appSource, name), path.join(appTarget, name));
    }
  }
  for (const name of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
  fs.chmodSync(path.join(target, "bin", "brave-codex-cookie-sync.js"), 0o700);
  return target;
}

function cleanProfileName(value) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function cleanDomains(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

function installExtension(config, home, browser, role) {
  const source = path.join(projectRoot(), "extension-template");
  const target = installedExtensionDir(home, browser);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });

  for (const name of ["manifest.json", "background.js"]) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }

  const generated = [
    "// Generated locally by Browser Cookie Bridge. Do not share this file.",
    `globalThis.SYNC_CONFIG = ${JSON.stringify({ token: config.token, port: config.port })};`,
    `globalThis.SYNC_ROLE = ${JSON.stringify(role)};`,
    `globalThis.SYNC_BROWSER = ${JSON.stringify(browser)};`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(target, "config.js"), generated, { mode: 0o600 });
}

function writePrivateJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}
