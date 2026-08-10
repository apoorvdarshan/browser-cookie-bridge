/* global SYNC_BROWSER, SYNC_CONFIG, SYNC_ROLE */

importScripts("config.js");

const ALARM_NAME = "brave-codex-cookie-sync";
let running = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  void runSync();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  void runSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void runSync();
});

void runSync();

async function runSync() {
  if (running || typeof SYNC_CONFIG === "undefined") return;
  running = true;
  let status;
  try {
    status = await request("/v1/status");
  } catch {
    // The broker normally exists only during a scheduled or manual sync.
    running = false;
    return;
  }
  try {
    if (SYNC_ROLE === "browser" && SYNC_BROWSER === status.sourceBrowser && status.sourceNeeded) {
      try {
        await sendSourceData(status.imports);
      } catch (error) {
        await reportFailure("source", error);
        return;
      }
    }
    if (SYNC_BROWSER === status.targetBrowser && status.targetNeeded) {
      try {
        await importIntoTarget();
      } catch (error) {
        await reportFailure("target", error);
      }
    }
  } finally {
    running = false;
  }
}

async function reportFailure(endpoint, error) {
  try {
    await request("/v1/failure", {
      method: "POST",
      body: JSON.stringify({ endpoint, message: error instanceof Error ? error.message : String(error) }),
    });
  } catch {
    // The broker may already have closed after accepting the failure.
  }
}

async function sendSourceData(imports) {
  let transferableCookies = [];
  let transferableHistory = [];
  if (imports.cookies) {
    const cookies = await chrome.cookies.getAll({});
    transferableCookies = cookies
      .filter((cookie) => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000)
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        session: cookie.session,
        expirationDate: cookie.expirationDate,
        partitionKey: cookie.partitionKey,
      }));
  }
  if (imports.history) {
    const history = await chrome.history.search({ text: "", startTime: 0, maxResults: 50_000 });
    transferableHistory = history
      .filter((item) => typeof item.url === "string" && /^https?:\/\//.test(item.url))
      .map((item) => ({ url: item.url }));
  }
  await request("/v1/source", {
    method: "POST",
    body: JSON.stringify({ cookies: transferableCookies, history: transferableHistory }),
  });
}

async function importIntoTarget() {
  const payload = await request("/v1/payload");
  if (!payload || !Array.isArray(payload.cookies) || !Array.isArray(payload.history)) return;

  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let historyImported = 0;
  let historyFailed = 0;
  let historySkipped = 0;
  const existingHistory = payload.history.length
    ? await chrome.history.search({ text: "", startTime: 0, maxResults: 50_000 })
    : [];
  const existingHistoryURLs = new Set(existingHistory.map((item) => item.url));
  for (const cookie of payload.cookies) {
    try {
      const details = cookieSetDetails(cookie);
      if (!details) {
        skipped += 1;
        continue;
      }
      const result = await chrome.cookies.set(details);
      if (result) imported += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  for (const item of payload.history) {
    try {
      if (!item || typeof item.url !== "string" || !/^https?:\/\//.test(item.url)) {
        historySkipped += 1;
        continue;
      }
      if (existingHistoryURLs.has(item.url)) {
        historySkipped += 1;
        continue;
      }
      await chrome.history.addUrl({ url: item.url });
      existingHistoryURLs.add(item.url);
      historyImported += 1;
    } catch {
      historyFailed += 1;
    }
  }

  await request("/v1/complete", {
    method: "POST",
    body: JSON.stringify({ imported, failed, skipped, historyImported, historyFailed, historySkipped }),
  });
}

function cookieSetDetails(cookie) {
  if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") return null;
  if (typeof cookie.domain !== "string" || !cookie.domain) return null;
  const host = cookie.domain.replace(/^\./, "");
  if (!host || host.includes("/") || host.includes(":")) return null;

  const details = {
    url: `${cookie.secure ? "https" : "http"}://${host}/`,
    name: cookie.name,
    value: cookie.value,
    path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };

  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (["no_restriction", "lax", "strict", "unspecified"].includes(cookie.sameSite)) {
    details.sameSite = cookie.sameSite;
  }
  if (!cookie.session && Number.isFinite(cookie.expirationDate)) {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.partitionKey && typeof cookie.partitionKey.topLevelSite === "string") {
    details.partitionKey = cookie.partitionKey;
  }
  return details;
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${SYNC_CONFIG.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SYNC_CONFIG.token}`,
      "Content-Type": "application/json",
      "X-Sync-Browser": SYNC_BROWSER,
      "X-Sync-Role": SYNC_ROLE,
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Broker returned ${response.status}`);
  return response.json();
}
