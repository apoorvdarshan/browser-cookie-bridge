import assert from "node:assert/strict";
import test from "node:test";
import { codexStagingSummary, transferSummary } from "../src/cli.js";

test("transfer summary distinguishes complete and partial imports", () => {
  const complete = transferSummary({ imported: 8, failed: 0, skipped: 2, historyImported: 3, historyFailed: 0, historySkipped: 1 });
  assert.equal(complete, "Transfer complete: 11 imported and 3 skipped.");

  const partial = transferSummary({ imported: 7, failed: 1, skipped: 2, historyImported: 2, historyFailed: 1, historySkipped: 0 });
  assert.match(partial, /^Partially synced: 9 imported, 2 skipped, 2 failed\./);
  assert.match(partial, /Reload the destination extension/);
});

test("Codex summary explains the required native import step", () => {
  const summary = codexStagingSummary({
    stagedCookies: 8,
    stagedHistory: 0,
    failed: 0,
    skipped: 2,
    historyFailed: 0,
    historySkipped: 0,
  });
  assert.match(summary, /Codex import prepared: 8 staged and 2 skipped/);
  assert.match(summary, /Settings → Browser → Import/);
});
