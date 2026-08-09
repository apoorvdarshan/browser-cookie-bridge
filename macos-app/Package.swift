// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "BraveCodexSyncApp",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "BraveCodexSyncApp", targets: ["BraveCodexSyncApp"]),
  ],
  targets: [
    .executableTarget(
      name: "BraveCodexSyncApp",
      path: "Sources/BraveCodexSyncApp"
    ),
  ]
)
