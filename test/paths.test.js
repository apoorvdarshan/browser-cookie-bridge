import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  braveCookiePaths,
  codexCookiePaths,
  cursorCookiePaths,
  isAppBundleWithIdentifier,
  TARGET_BROWSERS,
} from "../src/paths.js";

test("profile discovery includes current and legacy Chromium cookie locations", () => {
  const brave = braveCookiePaths("/tmp/test-home");
  const codex = codexCookiePaths("/tmp/test-home");
  const cursor = cursorCookiePaths("/tmp/test-home");
  assert(brave.some((candidate) => candidate.endsWith("Brave-Browser/Default/Cookies")));
  assert(brave.some((candidate) => candidate.endsWith("Brave-Browser/Profile 1/Network/Cookies")));
  assert(codex.some((candidate) => candidate.endsWith("Default/Partitions/codex-browser-app/Cookies")));
  assert.equal(cursor.length, 1);
  assert(cursor.some((candidate) => candidate.endsWith("Cursor/Partitions/cursor-browser/Cookies")));
  assert(cursor.every((candidate) => candidate.includes("/Partitions/cursor-browser/")));
  assert(!cursor.includes("/tmp/test-home/Library/Application Support/Cursor/Cookies"));
});

test("Browserless is destination-only", () => {
  assert(TARGET_BROWSERS.includes("browserless"));
  assert(TARGET_BROWSERS.includes("cursor"));
});

test("canonical app detection requires the Browser Cookie Bridge bundle identifier", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Browser Cookie Bridge.app");
  const contents = path.join(app, "Contents");
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, "Info.plist"), `
    <plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>
  `);
  assert.equal(isAppBundleWithIdentifier(app), false);
  fs.writeFileSync(path.join(contents, "Info.plist"), `
    <plist><dict><key>CFBundleIdentifier</key><string>com.apoorvdarshan.browser-cookie-bridge</string></dict></plist>
  `);
  assert.equal(isAppBundleWithIdentifier(app), true);
});
