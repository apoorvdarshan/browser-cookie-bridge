import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { progressParser, runBrowserlessCLI, uploadBrowserlessProfile } from "../src/browserless.js";

test("creates a missing Browserless profile with explicit privacy controls", async () => {
  const calls = [];
  const result = await uploadBrowserlessProfile({
    browser: "brave",
    localProfile: "Default",
    profileName: "bridge-test",
    region: "ams",
    onlyDomains: ["example.com"],
    token: "secret-token",
    root: "/runtime",
    runner: async (cliPath, args, environment) => {
      calls.push({ cliPath, args, environment });
      return calls.length === 1
        ? { status: 1, output: "Profile not found (404)" }
        : { status: 0, output: '> Uploading to Browserless\n{\n  "name": "bridge-test",\n  "cookieCount": 12,\n  "originCount": 3\n}\n' };
    },
  });

  assert.equal(result.operation, "upload");
  assert.equal(result.verified, true);
  assert.match(result.summary, /12 cookies, 3 origins/);
  assert.match(result.summary, /verified/);
  assert.deepEqual(calls[1].args, [
    "profile", "upload", "--browser", "brave", "--profile", "Default",
    "--name", "bridge-test", "--region", "ams", "--json", "--accept-terms",
    "--auto-fit", "--only-domain", "example.com",
  ]);
  assert.equal(calls[1].environment.BROWSERLESS_TOKEN, "secret-token");
  assert.equal(calls[1].environment.BROWSERLESS_TELEMETRY_DISABLED, "1");
  assert.equal(calls[1].environment.DO_NOT_TRACK, "1");
  assert.equal(calls[1].environment.BROWSERLESS_DISABLE_KEYCHAIN, "1");
  assert(!calls[1].args.includes("secret-token"));
  assert.equal(calls.length, 3);
});

test("parses live Browserless capture progress across split output chunks", () => {
  const progress = [];
  const parse = progressParser((event) => progress.push(event));
  parse("copying profile data…\nlaunching headless browser…\ncapturing per-origin storage…\n  2/10  https://exa");
  parse("mple.com\n> Uploading to Browserless\n");
  assert.deepEqual(progress.map((event) => event.phase), ["copying", "launching", "capturing", "capturing", "uploading"]);
  assert.equal(progress[3].current, 2);
  assert.equal(progress[3].total, 10);
  assert.match(progress[3].detail, /example\.com/);
});

test("cancellation terminates the Browserless process group and removes its temporary workspace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browserless-cancel-test-"));
  const fakeCLI = path.join(directory, "fake-cli.mjs");
  const controller = new AbortController();
  let temporaryRoot = "";
  try {
    fs.writeFileSync(fakeCLI, `
      console.log("TMPDIR=" + process.env.TMPDIR);
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    `);
    const output = [];
    const promise = runBrowserlessCLI(
      fakeCLI,
      ["profile", "upload"],
      { ...process.env, BROWSERLESS_TOKEN: "keychain-secret" },
      path.resolve("src/browserless-runner.js"),
      {
        signal: controller.signal,
        timeoutMs: 5_000,
        onOutput(chunk) {
          output.push(chunk);
          const match = output.join("").match(/TMPDIR=(.+)/);
          if (match) {
            temporaryRoot = match[1].trim();
            controller.abort();
          }
        },
      },
    );
    const result = await promise;
    assert.equal(result.status, 130);
    assert.equal(result.canceled, true);
    assert(temporaryRoot.includes("browser-cookie-bridge-browserless-"));
    assert.equal(fs.existsSync(temporaryRoot), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refreshes an existing Browserless profile and rejects unsupported sources", async () => {
  const calls = [];
  const result = await uploadBrowserlessProfile({
    browser: "chrome",
    localProfile: "Profile 1",
    profileName: "existing",
    token: "token",
    runner: async (_cliPath, args) => {
      calls.push(args);
      return calls.length === 1
        ? { status: 0, output: '{"name":"existing"}\n' }
        : { status: 0, output: '{"name":"existing","cookieCount":2,"originCount":1}\n' };
    },
  });
  assert.equal(result.operation, "refresh");
  assert.equal(calls[1][1], "refresh");
  await assert.rejects(
    uploadBrowserlessProfile({ browser: "comet", localProfile: "Default", profileName: "x", token: "token" }),
    /not supported/,
  );
});

test("does not turn authentication failures into create attempts", async () => {
  let calls = 0;
  await assert.rejects(
    uploadBrowserlessProfile({
      browser: "brave",
      localProfile: "Default",
      profileName: "private",
      token: "bad",
      runner: async () => {
        calls += 1;
        return { status: 1, output: "Token rejected (401)" };
      },
    }),
    /Token rejected/,
  );
  assert.equal(calls, 1);
});

test("turns Browserless network failures into actionable retry guidance", async () => {
  let calls = 0;
  await assert.rejects(
    uploadBrowserlessProfile({
      browser: "brave",
      localProfile: "Default",
      profileName: "network-test",
      token: "token",
      runner: async () => {
        calls += 1;
        return calls === 1
          ? { status: 1, output: "Profile not found (404)" }
          : { status: 5, output: "TypeError: fetch failed (ECONNRESET)" };
      },
    }),
    /could not be reached.*internet connection.*region/i,
  );
  assert.equal(calls, 2);
});

test("timeout terminates the Browserless process group and removes its temporary workspace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browserless-timeout-test-"));
  const fakeCLI = path.join(directory, "fake-cli.mjs");
  let temporaryRoot = "";
  try {
    fs.writeFileSync(fakeCLI, `
      console.log("TMPDIR=" + process.env.TMPDIR);
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    `);
    const output = [];
    const result = await runBrowserlessCLI(
      fakeCLI,
      ["profile", "upload"],
      { ...process.env, BROWSERLESS_TOKEN: "keychain-secret" },
      path.resolve("src/browserless-runner.js"),
      {
        timeoutMs: 75,
        onOutput(chunk) {
          output.push(chunk);
          const match = output.join("").match(/TMPDIR=(.+)/);
          if (match) temporaryRoot = match[1].trim();
        },
      },
    );
    assert.equal(result.status, 124);
    assert.equal(result.timedOut, true);
    assert(temporaryRoot.includes("browser-cookie-bridge-browserless-"));
    assert.equal(fs.existsSync(temporaryRoot), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("removes the API token from the environment before loading the capture CLI", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browserless-runner-"));
  const fakeCLI = path.join(directory, "fake-cli.mjs");
  try {
    fs.writeFileSync(fakeCLI, `console.log(JSON.stringify({ tokenEnvironment: process.env.BROWSERLESS_TOKEN ?? null, arguments: process.argv.slice(2) }));\n`);
    const result = spawnSync(process.execPath, [
      path.resolve("src/browserless-runner.js"), fakeCLI, "profile", "show", "test",
    ], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, BROWSERLESS_TOKEN: "keychain-secret" },
    });
    assert.equal(result.status, 0, result.stderr);
    const details = JSON.parse(result.stdout);
    assert.equal(details.tokenEnvironment, null);
    assert.deepEqual(details.arguments.slice(-2), ["--token", "keychain-secret"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
