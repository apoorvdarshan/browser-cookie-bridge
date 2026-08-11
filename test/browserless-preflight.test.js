import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectBrowserlessProfile, sizeSeverity } from "../src/browserless-preflight.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

test("classifies 100 MB, 500 MB, and 1 GB IndexedDB profiles without loading their contents", () => {
  assert.equal(sizeSeverity(100 * MB), "elevated");
  assert.equal(sizeSeverity(500 * MB), "high");
  assert.equal(sizeSeverity(GB), "extreme");
});

test("preflight measures sparse stress profiles and reports local storage separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-preflight-"));
  try {
    const indexedDB = path.join(root, "IndexedDB");
    const localStorage = path.join(root, "Local Storage", "leveldb");
    fs.mkdirSync(indexedDB, { recursive: true });
    fs.mkdirSync(localStorage, { recursive: true });
    fs.writeFileSync(path.join(indexedDB, "large.data"), "");
    fs.truncateSync(path.join(indexedDB, "large.data"), GB);
    fs.writeFileSync(path.join(localStorage, "000001.ldb"), "");
    fs.truncateSync(path.join(localStorage, "000001.ldb"), 32 * MB);

    const result = inspectBrowserlessProfile({ profilePath: root });
    assert.equal(result.indexedDBBytes, GB);
    assert.equal(result.localStorageBytes, 32 * MB);
    assert.equal(result.profileBytes, GB + 32 * MB);
    assert.equal(result.severity, "extreme");
    assert.equal(result.serverArtifactCapBytes, 2 * MB);
    assert.match(result.summary, /1\.03 GB profile/);
    assert.match(result.summary, /1\.00 GB IndexedDB/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight skips symlinks instead of escaping the selected profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-preflight-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cookie-bridge-preflight-outside-"));
  try {
    fs.writeFileSync(path.join(root, "inside"), Buffer.alloc(16));
    fs.writeFileSync(path.join(outside, "secret"), Buffer.alloc(128));
    fs.symlinkSync(outside, path.join(root, "IndexedDB"));
    const result = inspectBrowserlessProfile({ profilePath: root });
    assert.equal(result.profileBytes, 16);
    assert.equal(result.indexedDBBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
