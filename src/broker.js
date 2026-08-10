import crypto from "node:crypto";
import http from "node:http";
import { EXTENSION_ORIGIN } from "./paths.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createBroker({
  token,
  port,
  timeoutMs = 300_000,
  host = "127.0.0.1",
  imports = { cookies: true, history: false },
  sourceBrowser = "brave",
  targetBrowser = "codex",
  onEvent = () => {},
}) {
  const state = {
    runId: crypto.randomUUID(),
    payload: null,
    completed: false,
    result: null,
  };

  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = http.createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/v1/status") {
        sendJson(response, 200, {
          runId: state.runId,
          sourceNeeded: state.payload === null,
          targetNeeded: state.payload !== null && !state.completed,
          imports,
          sourceBrowser,
          targetBrowser,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/source") {
        const body = await readJson(request);
        if (!Array.isArray(body.cookies) || !Array.isArray(body.history)) {
          throw new ClientError("cookies and history must be arrays");
        }
        state.payload = { cookies: body.cookies, history: body.history };
        onEvent({ type: "source", cookies: body.cookies.length, history: body.history.length });
        sendJson(response, 202, {
          acceptedCookies: body.cookies.length,
          acceptedHistory: body.history.length,
          runId: state.runId,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/payload") {
        if (state.payload === null) {
          sendJson(response, 204, null);
          return;
        }
        sendJson(response, 200, { runId: state.runId, ...state.payload });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/complete") {
        const body = await readJson(request);
        state.completed = true;
        state.result = {
          imported: positiveInteger(body.imported),
          failed: positiveInteger(body.failed),
          skipped: positiveInteger(body.skipped),
          historyImported: positiveInteger(body.historyImported),
          historyFailed: positiveInteger(body.historyFailed),
          historySkipped: positiveInteger(body.historySkipped),
        };
        state.payload = null;
        onEvent({ type: "complete", ...state.result });
        resolveCompletion(state.result);
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof ClientError ? 400 : 500;
      sendJson(response, status, { error: error.message });
    }
  });

  const timer = setTimeout(() => {
    const error = new Error(
      `Timed out waiting for both browser extensions. Keep ${sourceBrowser} and ${targetBrowser} open and verify the extension is installed in both.`,
    );
    rejectCompletion(error);
    server.close();
  }, timeoutMs);
  timer.unref();

  completion.finally(() => {
    clearTimeout(timer);
    server.close();
  }).catch(() => {});

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      onEvent({ type: "listening", host, port, runId: state.runId });
    },
    close() {
      clearTimeout(timer);
      state.payload = null;
      server.close();
    },
    completion,
  };
}

function authorized(request, token) {
  const supplied = request.headers.authorization || "";
  const expected = `Bearer ${token}`;
  if (supplied.length !== expected.length) return false;
  const tokenMatches = crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  const origin = request.headers.origin;
  return tokenMatches && (origin === undefined || origin === EXTENSION_ORIGIN);
}

function setSecurityHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", EXTENSION_ORIGIN);
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response, status, value) {
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ClientError("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ClientError("invalid JSON");
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

class ClientError extends Error {}
