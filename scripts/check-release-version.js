import fs from "node:fs";

const packageVersion = readJSON("package.json").version;
const extensionVersion = readJSON("extension-template/manifest.json").version;
const infoPlist = fs.readFileSync("macos-app/Info.plist", "utf8");
const nodeEntitlements = fs.readFileSync("macos-app/Node.entitlements", "utf8");
const appVersion = infoPlist.match(
  /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
)?.[1];

if (!packageVersion || !extensionVersion || !appVersion) {
  throw new Error("Could not read every release version.");
}
if (!nodeEntitlements.includes("com.apple.security.cs.allow-jit")) {
  throw new Error("Bundled Node must retain its hardened-runtime JIT entitlement.");
}

const versions = new Set([packageVersion, extensionVersion, appVersion]);
if (versions.size !== 1) {
  throw new Error(
    `Release versions differ: package=${packageVersion}, extension=${extensionVersion}, app=${appVersion}`,
  );
}

const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${packageVersion}`) {
  throw new Error(`Tag ${tag} does not match package version v${packageVersion}.`);
}

console.log(`Release version is consistent: v${packageVersion}`);

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
