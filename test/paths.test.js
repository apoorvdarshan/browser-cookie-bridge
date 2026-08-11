import assert from "node:assert/strict";
import test from "node:test";
import { braveCookiePaths, codexCookiePaths, TARGET_BROWSERS } from "../src/paths.js";

test("profile discovery includes current and legacy Chromium cookie locations", () => {
  const brave = braveCookiePaths("/tmp/test-home");
  const codex = codexCookiePaths("/tmp/test-home");
  assert(brave.some((candidate) => candidate.endsWith("Brave-Browser/Default/Cookies")));
  assert(brave.some((candidate) => candidate.endsWith("Brave-Browser/Profile 1/Network/Cookies")));
  assert(codex.some((candidate) => candidate.endsWith("Default/Partitions/codex-browser-app/Cookies")));
});

test("Browserless is destination-only", () => {
  assert(TARGET_BROWSERS.includes("browserless"));
});
