import fs from "node:fs";
import path from "node:path";

export const BROWSERLESS_SERVER_ARTIFACT_CAP_BYTES = 2 * 1024 * 1024;

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export function inspectBrowserlessProfile({ profilePath } = {}) {
  if (!profilePath || !fs.existsSync(profilePath)) {
    throw new Error("The local browser profile could not be inspected.");
  }

  const profileBytes = directorySize(profilePath);
  const indexedDBBytes = directorySize(path.join(profilePath, "IndexedDB"));
  const localStorageBytes = directorySize(path.join(profilePath, "Local Storage"));
  const freeBytes = availableBytes(profilePath);
  const severity = sizeSeverity(indexedDBBytes);
  const temporarySpaceWarning = Number.isFinite(freeBytes) && freeBytes < profileBytes + 256 * MEBIBYTE;

  return {
    profilePath,
    profileBytes,
    indexedDBBytes,
    localStorageBytes,
    freeBytes,
    severity,
    temporarySpaceWarning,
    serverArtifactCapBytes: BROWSERLESS_SERVER_ARTIFACT_CAP_BYTES,
    summary: profileSummary({
      profileBytes,
      indexedDBBytes,
      localStorageBytes,
      freeBytes,
      severity,
      temporarySpaceWarning,
    }),
  };
}

export function sizeSeverity(indexedDBBytes) {
  if (indexedDBBytes >= GIBIBYTE) return "extreme";
  if (indexedDBBytes >= 500 * MEBIBYTE) return "high";
  if (indexedDBBytes >= 100 * MEBIBYTE) return "elevated";
  return "normal";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function directorySize(root) {
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return 0;
  } catch {
    return 0;
  }
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(candidate).size;
      } catch {}
    }
  }
  return total;
}

function availableBytes(candidate) {
  try {
    const statistics = fs.statfsSync(candidate);
    return Number(statistics.bavail) * Number(statistics.bsize);
  } catch {
    return Number.NaN;
  }
}

function profileSummary({ profileBytes, indexedDBBytes, localStorageBytes, freeBytes, severity, temporarySpaceWarning }) {
  const parts = [
    `${formatBytes(profileBytes)} profile`,
    `${formatBytes(indexedDBBytes)} IndexedDB`,
    `${formatBytes(localStorageBytes)} local storage`,
  ];
  if (Number.isFinite(freeBytes)) parts.push(`${formatBytes(freeBytes)} free`);
  if (temporarySpaceWarning) parts.push("low temporary disk space");
  else if (severity !== "normal") parts.push(`${severity} IndexedDB load`);
  return parts.join(" · ");
}
