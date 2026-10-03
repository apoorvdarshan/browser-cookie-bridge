// Compatibility exports for the original Grok Bot integration.
export {
  BUNDLE_EXTENSION,
  BUNDLE_FORMAT_VERSION,
  EMBEDDED_KEY_FILENAME,
  GROK_BOT_PROMPT,
  buildCloudTransferBundle as buildGrokBotBundle,
  writeCloudTransferBundle as writeGrokBotBundle,
  exportCloudTransferBundleFromProfile as exportGrokBotBundleFromProfile,
  parseCloudTransferBundle as parseGrokBotBundle,
  cloudTransferSummary as grokBotSummary,
  formatCloudTransferResultLine as formatGrokBotResultLine,
  filterCookies,
  normalizeDomainFilters,
  cookieMatchesDomains,
} from "./cloud-transfer-export.js";
export const DEFAULT_BUNDLE_NAME = "GrokBot-Import.bcbx";
