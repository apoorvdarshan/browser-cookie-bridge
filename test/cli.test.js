import assert from "node:assert/strict";
import test from "node:test";
import {
  directCodexSummary,
  directTargetSummary,
  requireClosedCodexSource,
  requireClosedDirectTargetSource,
  transferSummary,
} from "../src/cli.js";

test("Codex full site-data preflight resolves and checks the source browser", () => {
  const checked = [];
  const source = requireClosedCodexSource({
    sourceBrowser: "brave",
    siteStorage: true,
    runningCheck({ browser }) {
      checked.push(browser);
      return false;
    },
  });

  assert.equal(source, "brave");
  assert.deepEqual(checked, ["brave"]);
  assert.equal(requireClosedCodexSource({ sourceBrowser: undefined, siteStorage: false }), "brave");
  assert.throws(
    () => requireClosedCodexSource({ sourceBrowser: "chrome", siteStorage: true, runningCheck: () => true }),
    /Quit chrome completely/,
  );
});

test("direct target helpers describe Cursor safeguards", () => {
  assert.throws(
    () => requireClosedDirectTargetSource({
      sourceBrowser: "chrome",
      siteStorage: true,
      targetName: "Cursor",
      runningCheck: () => true,
    }),
    /before importing full site data into Cursor/,
  );
  const summary = directTargetSummary({
    targetName: "Cursor",
    imported: 4,
    skipped: 0,
    failed: 0,
    historyImported: 0,
    historySkipped: 0,
    historyFailed: 0,
    siteStorageImported: 0,
    sourceCookieSkipped: 0,
    backupPath: "/tmp/cursor-backup",
  });
  assert.match(summary, /Direct Cursor sync complete: 4 imported/);
  assert.match(summary, /Reopen Cursor/);

  const cleanupWarning = directTargetSummary({
    targetName: "Cursor",
    imported: 4,
    skipped: 0,
    failed: 0,
    historyImported: 0,
    historySkipped: 0,
    historyFailed: 0,
    siteStorageImported: 0,
    sourceCookieSkipped: 0,
    backupPath: "/tmp/cursor-backup",
    backupCleanupWarning: "The transfer succeeded, but old backups could not be pruned.",
  });
  assert.match(cleanupWarning, /completed with warnings/);
  assert.match(cleanupWarning, /old backups could not be pruned/);
});

test("transfer summary distinguishes complete and partial imports", () => {
  const complete = transferSummary({ imported: 8, failed: 0, skipped: 2, historyImported: 3, historyFailed: 0, historySkipped: 1 });
  assert.equal(complete, "Transfer complete: 11 imported and 3 skipped.");

  const partial = transferSummary({ imported: 7, failed: 1, skipped: 2, historyImported: 2, historyFailed: 1, historySkipped: 0 });
  assert.match(partial, /^Partially synced: 9 imported, 2 skipped, 2 failed\./);
  assert.match(partial, /Reload the destination extension/);
});

test("Codex summary explains the completed direct merge and backup", () => {
  const summary = directCodexSummary({
    imported: 8,
    historyImported: 0,
    failed: 0,
    skipped: 2,
    historyFailed: 0,
    historySkipped: 0,
    backupPath: "/tmp/backup",
  });
  assert.match(summary, /Direct Codex sync complete: 8 imported and 2 skipped/);
  assert.match(summary, /Reopen Codex/);
  assert.match(summary, /Backup: \/tmp\/backup/);
});

test("Codex summary reports source cookies that could not be read", () => {
  const summary = directCodexSummary({
    imported: 8,
    historyImported: 0,
    skipped: 0,
    historySkipped: 0,
    failed: 0,
    historyFailed: 0,
    sourceCookieSkipped: 3,
    siteStorageImported: 0,
    backupPath: "/tmp/backup",
  });
  assert.match(summary, /with warnings/);
  assert.match(summary, /3 source cookies were unreadable or unsupported/);
});
