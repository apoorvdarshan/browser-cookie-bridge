import assert from "node:assert/strict";
import test from "node:test";
import { createBroker } from "../src/broker.js";

test("broker transfers an in-memory payload and clears it after completion", async () => {
  const token = "test-token";
  const port = 43291;
  const broker = createBroker({ token, port, timeoutMs: 5_000 });
  await broker.listen();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const status = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers }).then((response) => response.json());
  assert.equal(status.sourceNeeded, true);

  const secretCookie = { name: "session", value: "secret", domain: "example.test" };
  const sourceResponse = await fetch(`http://127.0.0.1:${port}/v1/source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cookies: [secretCookie], history: [{ url: "https://example.test/" }] }),
  });
  assert.equal(sourceResponse.status, 202);

  const payload = await fetch(`http://127.0.0.1:${port}/v1/payload`, { headers }).then((response) => response.json());
  assert.deepEqual(payload.cookies, [secretCookie]);
  assert.deepEqual(payload.history, [{ url: "https://example.test/" }]);

  await fetch(`http://127.0.0.1:${port}/v1/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ imported: 1, failed: 0, skipped: 0 }),
  });
  assert.deepEqual(await broker.completion, {
    imported: 1,
    failed: 0,
    skipped: 0,
    historyImported: 0,
    historyFailed: 0,
    historySkipped: 0,
  });
});

test("broker rejects requests without its install token", async () => {
  const port = 43292;
  const broker = createBroker({ token: "correct", port, timeoutMs: 5_000 });
  await broker.listen();
  const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(response.status, 401);
  broker.close();
});
