import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PORT,
  configPath,
  installedExtensionDir,
  projectRoot,
} from "./paths.js";

export function readConfig(home) {
  const target = configPath(home);
  if (!fs.existsSync(target)) {
    throw new Error("Not configured. Run `brave-codex-cookie-sync setup` first.");
  }
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!config.token || !Number.isInteger(config.port)) {
    throw new Error(`Invalid configuration at ${target}`);
  }
  return config;
}

export function installConfig({ home, hour = 9, minute = 0 }) {
  const target = configPath(home);
  const support = path.dirname(target);
  fs.mkdirSync(support, { recursive: true, mode: 0o700 });

  let existing = {};
  if (fs.existsSync(target)) {
    existing = JSON.parse(fs.readFileSync(target, "utf8"));
  }

  const config = {
    version: 1,
    token: existing.token || crypto.randomBytes(32).toString("base64url"),
    port: existing.port || DEFAULT_PORT,
    nodePath: process.execPath,
    schedule: { hour, minute },
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writePrivateJson(target, config);
  installExtension(config, home, "brave");
  installExtension(config, home, "codex");
  return config;
}

export function installRuntime(home) {
  const source = projectRoot();
  const target = path.join(path.dirname(configPath(home)), "runtime");
  if (path.resolve(source) === path.resolve(target)) return target;

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["bin", "src", "extension-template"]) {
    fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, force: true });
  }
  const appSource = path.join(source, "macos-app");
  const appTarget = path.join(target, "macos-app");
  fs.rmSync(appTarget, { recursive: true, force: true });
  fs.mkdirSync(appTarget, { recursive: true, mode: 0o700 });
  for (const name of ["Sources", "Resources"]) {
    fs.cpSync(path.join(appSource, name), path.join(appTarget, name), { recursive: true, force: true });
  }
  for (const name of ["Package.swift", "Info.plist"]) {
    fs.copyFileSync(path.join(appSource, name), path.join(appTarget, name));
  }
  for (const name of ["package.json", "README.md", "LICENSE"]) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
  fs.chmodSync(path.join(target, "bin", "brave-codex-cookie-sync.js"), 0o700);
  return target;
}

function installExtension(config, home, role) {
  const source = path.join(projectRoot(), "extension-template");
  const target = installedExtensionDir(home, role);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });

  for (const name of ["manifest.json", "background.js"]) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }

  const generated = [
    "// Generated locally by brave-codex-cookie-sync. Do not share this file.",
    `globalThis.SYNC_CONFIG = ${JSON.stringify({ token: config.token, port: config.port })};`,
    `globalThis.SYNC_ROLE = ${JSON.stringify(role === "brave" ? "source" : "target")};`,
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
