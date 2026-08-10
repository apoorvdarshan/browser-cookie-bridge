import assert from "node:assert/strict";
import test from "node:test";
import { directCodexSummary, transferSummary } from "../src/cli.js";

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
