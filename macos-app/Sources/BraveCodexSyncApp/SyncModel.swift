import AppKit
import Foundation
import Security
import UniformTypeIdentifiers

extension Notification.Name {
  static let menuBarVisibilityChanged = Notification.Name("BraveCodexSync.menuBarVisibilityChanged")
  static let nativeAlert = Notification.Name("BraveCodexSync.nativeAlert")
  static let updateStateChanged = Notification.Name("BraveCodexSync.updateStateChanged")
  static let syncStateChanged = Notification.Name("BraveCodexSync.syncStateChanged")
  static let showMainWindow = Notification.Name("BraveCodexSync.showMainWindow")
  static let presentGrokBotResult = Notification.Name("BraveCodexSync.presentGrokBotResult")
}

struct NativeAlert {
  enum Kind { case information, warning, error }
  /// Optional second button. Kept as data (not a closure) so the alert can be logged and posted through
  /// NotificationCenter; the app delegate performs the action.
  enum SecondaryButton {
    case openFullDiskAccessSettings

    var title: String {
      switch self {
      case .openFullDiskAccessSettings: "Open Full Disk Access settings"
      }
    }
  }
  let title: String
  let message: String
  let kind: Kind
  var secondaryButton: SecondaryButton? = nil
}

/// macOS TCC: reading another app's cookie database from an app-spawned process requires Full Disk Access.
/// A denial surfaces as EPERM/EACCES and persists after the browser is quit, so it needs its own guidance.
enum FullDiskAccess {
  static let appName = "Browser Cookie Bridge"
  /// System Settings (macOS 13+) deep link first, then the legacy System Preferences anchor.
  static let settingsURLs: [URL] = [
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  ].compactMap { URL(string: $0) }

  static let instructions =
    "Open System Settings › Privacy & Security › Full Disk Access, turn on \(appName), then quit and reopen the app and try again."

  /// In-app gate title, e.g. "Grant Full Disk Access to read Brave cookies".
  static func statusTitle(browserName: String) -> String { "Grant Full Disk Access to read \(browserName) cookies" }

  static func statusDetail(browserName: String) -> String {
    "macOS blocked \(appName) from reading \(browserName)'s cookie database (operation not permitted). Quitting \(browserName) does not fix this — \(instructions)"
  }

  /// Two-line version for the main window status row (the full detail is in the tooltip and alerts).
  static func gateDetail(browserName: String) -> String {
    "macOS blocked reading \(browserName)'s cookie database. Turn on \(appName) under Privacy & Security › Full Disk Access, then quit and reopen the app"
  }

  /// Chromium roots mirrored from src/chromium-reader.js so the app can probe the same file the CLI reads.
  private static let chromiumRoots: [String: (components: [String], directProfile: Bool)] = [
    "brave": (["BraveSoftware", "Brave-Browser"], false),
    "chrome": (["Google", "Chrome"], false),
    "edge": (["Microsoft Edge"], false),
    "arc": (["Arc", "User Data"], false),
    "vivaldi": (["Vivaldi"], false),
    "opera": (["com.operasoftware.Opera"], true),
    "comet": (["Comet"], false),
  ]

  @MainActor
  @discardableResult
  static func openSettings() -> Bool {
    for url in settingsURLs where NSWorkspace.shared.open(url) {
      AppDiagnostics.log("full-disk-access: opened \(url.absoluteString)")
      return true
    }
    AppDiagnostics.log("full-disk-access: could not open System Settings via any known URL")
    return false
  }

  /// True when the CLI output describes a TCC denial rather than a locked database or another failure.
  /// The CLI's Full Disk Access message is the primary contract; the raw EPERM copyfile text is matched as a
  /// fallback for runtimes that predate it.
  static func indicatesDenial(in output: String) -> Bool {
    if output.contains("Full Disk Access") { return true }
    let eperm = output.range(of: #"\bEPERM\b|operation not permitted"#, options: [.regularExpression, .caseInsensitive]) != nil
    return eperm && output.contains("Cookies")
  }

  /// Cheap, SQLite-free probe: opens the selected browser's cookie store read-only from the app process. The app
  /// is the TCC "responsible process" for the Node CLI it spawns, so the result matches what the CLI will hit.
  /// Returns true only for a definite EPERM/EACCES on an existing file; anything ambiguous returns false so the
  /// gate never blocks Create on a guess.
  static func isCookieStoreReadDenied(browserID: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Bool {
    guard let databasePath = cookieDatabasePath(browserID: browserID, home: home) else { return false }
    let descriptor = Darwin.open(databasePath, O_RDONLY)
    if descriptor >= 0 {
      Darwin.close(descriptor)
      return false
    }
    return errno == EPERM || errno == EACCES
  }

  /// True when a Foundation file error wraps EPERM/EACCES — the signature of a TCC denial.
  static func isDenial(_ error: Error) -> Bool {
    var current: NSError? = error as NSError
    while let candidate = current {
      if candidate.domain == NSPOSIXErrorDomain && (candidate.code == Int(EPERM) || candidate.code == Int(EACCES)) {
        return true
      }
      if candidate.domain == NSCocoaErrorDomain && candidate.code == NSFileReadNoPermissionError { return true }
      current = candidate.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return false
  }

  static func cookieDatabasePath(browserID: String, home: URL) -> String? {
    guard let root = chromiumRoots[browserID] else { return nil }
    var rootURL = home.appending(path: "Library/Application Support")
    for component in root.components { rootURL.append(path: component) }
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: rootURL.path) else { return nil }
    let profile = root.directProfile ? rootURL : rootURL.appending(path: activeProfileName(root: rootURL))
    for candidate in ["Network/Cookies", "Cookies"] {
      let path = profile.appending(path: candidate).path
      if fileManager.fileExists(atPath: path) { return path }
    }
    return nil
  }

  private static func activeProfileName(root: URL) -> String {
    let fileManager = FileManager.default
    if let data = try? Data(contentsOf: root.appending(path: "Local State")),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let lastUsed = (json["profile"] as? [String: Any])?["last_used"] as? String,
       !lastUsed.isEmpty,
       fileManager.fileExists(atPath: root.appending(path: lastUsed).path) {
      return lastUsed
    }
    if fileManager.fileExists(atPath: root.appending(path: "Default").path) { return "Default" }
    let entries = (try? fileManager.contentsOfDirectory(atPath: root.path)) ?? []
    return entries.first { $0.range(of: #"^Profile \d+$"#, options: .regularExpression) != nil } ?? "Default"
  }
}

struct GrokBotResultPresentation: Sendable {
  let prompt: String
  let outputPath: String
}

/// Append-only diagnostics shared by the model and the app delegate.
/// Lives next to the launchd logs in Application Support so a failed Create/Replace can be
/// debugged after the fact. The CLI never prints cookie values, so captured output is safe to keep.
enum AppDiagnostics {
  private static let lock = NSLock()
  private static let maxLogBytes = 512 * 1024

  static var logsDirectory: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library/Application Support/BraveCodexCookieSync/logs")
  }
  static var appLogURL: URL { logsDirectory.appending(path: "app.log") }
  static var lastSyncResultURL: URL { logsDirectory.appending(path: "last-sync-result.json") }

  static func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(message)\n"
    lock.withLock {
      prepareDirectory()
      let url = appLogURL
      if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > maxLogBytes {
        try? FileManager.default.removeItem(at: url)
      }
      if let handle = try? FileHandle(forWritingTo: url) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(line.utf8))
      } else {
        try? Data(line.utf8).write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      }
    }
  }

  static func writeLastSyncResult(_ record: SyncResultRecord) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    guard let data = try? encoder.encode(record) else { return }
    lock.withLock {
      prepareDirectory()
      try? data.write(to: lastSyncResultURL, options: .atomic)
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lastSyncResultURL.path)
    }
  }

  private static func prepareDirectory() {
    try? FileManager.default.createDirectory(
      at: logsDirectory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
  }
}

/// A private copy of the source browser's SQLite stores taken by the app process itself.
///
/// The app is the TCC client that holds Full Disk Access. The Node binary from `config.nodePath` (a Homebrew
/// install on local `npm run build:app` builds) is a *different* TCC client and is denied when it opens or
/// copies another app's Cookies database, even though the app was granted access. Copying with FileManager
/// here and handing the CLI the copy (via `BCB_SOURCE_SNAPSHOT_DIR`) sidesteps that, and — because the copy
/// includes the WAL/journal sidecars — also lets the source browser stay open during a Grok Bot Create.
struct SourceSnapshot: Sendable {
  static let environmentKey = "BCB_SOURCE_SNAPSHOT_DIR"
  static let sidecarSuffixes = ["-journal", "-wal", "-shm"]
  static let directoryPrefix = "bcb-cookie-snapshot-"

  let directory: URL
  let files: [String]

  static func root(support: URL) -> URL { support.appending(path: "snapshots") }

  /// Copies `Cookies` (and `History` when requested) plus sidecars into a fresh 0700 directory. Returns nil when
  /// the browser has no cookie store yet. Throws (after removing any partial copy) when the copy itself fails;
  /// callers use `FullDiskAccess.isDenial` to tell a TCC denial from other errors.
  static func take(
    browserID: String,
    includeHistory: Bool,
    support: URL,
    home: URL = FileManager.default.homeDirectoryForCurrentUser
  ) throws -> SourceSnapshot? {
    guard let cookiesPath = FullDiskAccess.cookieDatabasePath(browserID: browserID, home: home) else { return nil }
    let fileManager = FileManager.default
    let cookiesURL = URL(fileURLWithPath: cookiesPath)
    var profileURL = cookiesURL.deletingLastPathComponent()
    if profileURL.lastPathComponent == "Network" { profileURL.deleteLastPathComponent() }

    let rootURL = root(support: support)
    try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let directory = rootURL.appending(path: directoryPrefix + UUID().uuidString)
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])

    var sources = [cookiesURL]
    if includeHistory {
      let history = profileURL.appending(path: "History")
      if fileManager.fileExists(atPath: history.path) { sources.append(history) }
    }
    var copied: [String] = []
    do {
      for source in sources {
        // Copy the main file first, then any sidecars so the CLI opens a consistent WAL-mode database.
        let names = [source.lastPathComponent] + sidecarSuffixes.map { source.lastPathComponent + $0 }
        for name in names {
          let from = source.deletingLastPathComponent().appending(path: name)
          guard fileManager.fileExists(atPath: from.path) else { continue }
          let to = directory.appending(path: name)
          try fileManager.copyItem(at: from, to: to)
          try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: to.path)
          copied.append(name)
        }
      }
    } catch {
      try? fileManager.removeItem(at: directory)
      throw error
    }
    return SourceSnapshot(directory: directory, files: copied)
  }

  func discard() {
    try? FileManager.default.removeItem(at: directory)
  }

  /// Snapshots are removed as soon as the CLI exits; anything left behind means a previous run was killed.
  static func removeStale(support: URL) {
    let rootURL = root(support: support)
    guard let entries = try? FileManager.default.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil) else { return }
    for entry in entries where entry.lastPathComponent.hasPrefix(directoryPrefix) {
      try? FileManager.default.removeItem(at: entry)
    }
  }
}

struct SyncResultRecord: Encodable, Sendable {
  let startedAt: Date
  let finishedAt: Date
  let target: String
  let arguments: [String]
  let exitStatus: Int32?
  let terminatedBySignal: Bool
  let success: Bool
  let outputPath: String?
  let bundleWritten: Bool?
  let presented: Bool
  let lastLine: String?
}

struct UpdateMenuState {
  let version: String?
  let checking: Bool
  let installing: Bool
}

struct SyncMenuState {
  let uploading: Bool
  let canceling: Bool
}

struct BrowserlessProfileAssessment: Decodable {
  let browser: String?
  let profileName: String?
  let profileBytes: Int64
  let indexedDBBytes: Int64
  let localStorageBytes: Int64
  let freeBytes: Int64?
  let severity: String
  let temporarySpaceWarning: Bool
  let serverArtifactCapBytes: Int64
  let summary: String
}

private struct BrowserlessProgressEvent: Decodable {
  let phase: String
  let fraction: Double?
  let detail: String?
  let assessment: BrowserlessProfileAssessment?
}

struct BrowserChoice: Identifiable, Hashable {
  let id: String
  let name: String
  let bundleIdentifier: String
  let applicationName: String
  let extensionURL: String
}

@MainActor
final class SyncModel: ObservableObject {
  enum State { case ready, syncing, success, canceled, warning, error }

  let browsers = [
    BrowserChoice(id: "brave", name: "Brave", bundleIdentifier: "com.brave.Browser", applicationName: "Brave Browser", extensionURL: "brave://extensions"),
    BrowserChoice(id: "chrome", name: "Chrome", bundleIdentifier: "com.google.Chrome", applicationName: "Google Chrome", extensionURL: "chrome://extensions"),
    BrowserChoice(id: "edge", name: "Edge", bundleIdentifier: "com.microsoft.edgemac", applicationName: "Microsoft Edge", extensionURL: "edge://extensions"),
    BrowserChoice(id: "arc", name: "Arc", bundleIdentifier: "company.thebrowser.Browser", applicationName: "Arc", extensionURL: "chrome://extensions"),
    BrowserChoice(id: "vivaldi", name: "Vivaldi", bundleIdentifier: "com.vivaldi.Vivaldi", applicationName: "Vivaldi", extensionURL: "vivaldi://extensions"),
    BrowserChoice(id: "opera", name: "Opera", bundleIdentifier: "com.operasoftware.Opera", applicationName: "Opera", extensionURL: "opera://extensions"),
    BrowserChoice(id: "comet", name: "Comet", bundleIdentifier: "ai.perplexity.comet", applicationName: "Comet", extensionURL: "chrome://extensions")
  ]

  @Published var state: State = .ready
  @Published var isSyncing = false
  @Published var isWorking = false
  @Published var dailyEnabled = false
  @Published var loginSyncEnabled = false
  @Published var openAtLogin = false
  @Published var menuBarEnabled = true
  @Published var autoCheckUpdates = true
  @Published var autoRestartCodex = false
  @Published var autoRestartBoth = false
  @Published var isCheckingForUpdates = false
  @Published var isInstallingUpdate = false
  @Published var availableUpdateVersion: String?
  @Published var scheduleTime = Date()
  @Published var extensionsReady = false
  @Published var cookiesEnabled = true
  @Published var historyEnabled = false
  @Published var siteStorageEnabled = false
  @Published var selectedSourceID = "brave"
  @Published var selectedTargetID = "codex"
  @Published var codexRunning = false
  @Published var cursorRunning = false
  @Published var sourceBrowserRunning = false
  /// macOS denied reading the selected browser's cookie store (TCC / Full Disk Access). Set by the native probe
  /// or by a CLI failure that reported the denial; cleared when the probe can read the file again.
  @Published var sourceCookieAccessDenied = false
  @Published var browserlessConfigured = false
  @Published var browserlessProfileName = "browser-cookie-bridge"
  @Published var browserlessRegion = "sfo"
  @Published var browserlessOnlyDomains = ""
  @Published var grokBotOnlyDomains = ""
  @Published var showingBrowserlessSetup = false
  @Published var grokBotPrompt = ""
  @Published var grokBotOutputPath = ""
  @Published var browserlessAssessment: BrowserlessProfileAssessment?
  @Published var isInspectingBrowserlessProfile = false
  @Published var uploadProgress = 0.0
  @Published var uploadElapsedSeconds = 0
  @Published var uploadCanceling = false
  @Published var primaryStatus = "Ready to sync"
  @Published var secondaryStatus = "Choose what to move, then start a transfer"

  private let home = FileManager.default.homeDirectoryForCurrentUser
  private var support: URL { home.appending(path: "Library/Application Support/BraveCodexCookieSync") }
  private var runtimeCLI: URL { support.appending(path: "runtime/bin/brave-codex-cookie-sync.js") }
  private var launchAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.plist") }
  private var loginSyncAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.login-sync.plist") }
  private var appLoginAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.app-login.plist") }
  private var endpointStatusTimer: Timer?
  private var updateTimer: Timer?
  private var activeGrokBotOutputPath: String?

  private static let grokBotFallbackPrompt = """
On your Grok Bot cloud computer only — do not access my local Mac and do not print cookie values.

1. Save the attached GrokBot-Import.bcbx to the cloud computer.
2. Unzip it: unzip -o GrokBot-Import.bcbx -d bcb-import && cd bcb-import
3. Run: node import.mjs
4. Report only how many cookies were imported per domain, then delete the bcb-import folder and any copies of the bundle.
"""
  private var didCheckAfterLaunch = false
  private var didConsumeUpdateResult = false
  private var assessedBrowserID: String?
  private var activeSyncProcess: Process?
  private var uploadTimer: Timer?
  private var uploadStartedAt: Date?
  private var runtimeReady = true
  private var rememberedHistoryEnabled = false
  private var rememberedSiteStorageEnabled = false
  /// True while the status line shows the outcome of an explicit action. The idle "Ready…" text for
  /// Grok Bot and Browserless must not overwrite it (see `updateEndpointRunningStatus`).
  private var showingOperationResult = false
  /// Exit details of the most recent CLI process; set on the main actor immediately before its completion runs.
  private var lastCLIExit: (status: Int32, signaled: Bool)?
  /// A CLI run reported a Full Disk Access denial. Kept until the native probe confirms the file is readable
  /// again (which requires the user to grant access and relaunch), so the gate does not flicker.
  private var cliReportedAccessDenied = false

  var selectedBrowser: BrowserChoice {
    browsers.first(where: { $0.id == selectedSourceID }) ?? browsers[0]
  }

  var selectedTargetBrowser: BrowserChoice? {
    browsers.first(where: { $0.id == selectedTargetID })
  }

  var isBrowserlessTarget: Bool { selectedTargetID == "browserless" }
  var isGrokBotTarget: Bool { selectedTargetID == "grok-bot" }
  var isDirectTarget: Bool { selectedTargetID == "codex" || selectedTargetID == "cursor" }
  var targetName: String {
    if isBrowserlessTarget { return "Browserless Cloud" }
    if isGrokBotTarget { return "Grok Bot" }
    if selectedTargetID == "cursor" { return "Cursor" }
    return selectedTargetBrowser?.name ?? "ChatGPT Codex"
  }
  var directTargetRunning: Bool {
    selectedTargetID == "cursor" ? cursorRunning : selectedTargetID == "codex" && codexRunning
  }
  var directTargetBlocked: Bool {
    isDirectTarget && directTargetRunning
      && (selectedTargetID == "cursor" || (!autoRestartCodex && !(siteStorageEnabled && autoRestartBoth)))
  }
  var sourceSiteDataBlocked: Bool {
    isDirectTarget && siteStorageEnabled && sourceBrowserRunning
      && (selectedTargetID == "cursor" || !autoRestartBoth)
  }
  var browserlessBlocked: Bool {
    isBrowserlessTarget && (!browserlessConfigured || sourceBrowserRunning || selectedSourceID == "comet")
  }
  var cursorHasNoDataSelected: Bool { selectedTargetID == "cursor" && !cookiesEnabled }
  var grokBotHasNoDataSelected: Bool { isGrokBotTarget && !cookiesEnabled }
  /// macOS refuses to let this app read the source browser's cookie store (TCC). The source browser may stay
  /// open for Grok Bot — the app snapshots the database itself — so only a Full Disk Access denial blocks
  /// Create, and the button becomes a shortcut to System Settings.
  var grokBotSourceAccessBlocked: Bool { isGrokBotTarget && sourceCookieAccessDenied }
  var grokBotBlocked: Bool { grokBotHasNoDataSelected || grokBotSourceAccessBlocked }
  var syncBlocked: Bool {
    !runtimeReady || directTargetBlocked || sourceSiteDataBlocked || browserlessBlocked || cursorHasNoDataSelected || grokBotBlocked
  }
  var formattedUploadElapsed: String {
    let minutes = uploadElapsedSeconds / 60
    let seconds = uploadElapsedSeconds % 60
    return String(format: "%d:%02d", minutes, seconds)
  }
  var sourceIcon: NSImage { browserIcon(selectedBrowser) }
  var targetIcon: NSImage {
    if isBrowserlessTarget { return browserlessIcon }
    if isGrokBotTarget { return grokBotIcon }
    if selectedTargetID == "cursor" { return cursorIcon }
    return selectedTargetBrowser.map(browserIcon) ?? codexIcon
  }
  var grokBotIcon: NSImage {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.anysphere.sand") {
      return NSWorkspace.shared.icon(forFile: url.path)
    }
    if let url = Bundle.main.url(forResource: "grok-bot", withExtension: "png", subdirectory: "BrowserIcons"),
       let image = NSImage(contentsOf: url) {
      return image
    }
    return NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Grok Bot") ?? NSImage()
  }
  var browserlessIcon: NSImage {
    bundledIcon("browserless")
      ?? NSImage(systemSymbolName: "cloud.fill", accessibilityDescription: "Browserless Cloud")
      ?? NSImage()
  }
  var codexIcon: NSImage {
    bundledIcon("chatgpt-codex")
      ?? chatGPTResource("app.icns")
      ?? appIcon(bundleIdentifier: "com.openai.codex", fallbackSymbol: "terminal")
  }
  var cursorIcon: NSImage {
    if let url = Bundle.main.url(forResource: "cursor", withExtension: "png", subdirectory: "BrowserIcons"),
       let image = NSImage(contentsOf: url) {
      return image
    }
    return appIcon(bundleIdentifier: "com.todesktop.230313mzl4w4u92", fallbackSymbol: "cursorarrow.square")
  }

  func browserIcon(_ browser: BrowserChoice) -> NSImage {
    if browser.id == "brave",
       let bundled = Bundle.main.url(forResource: browser.id, withExtension: "svg", subdirectory: "BrowserIcons"),
       let image = NSImage(contentsOf: bundled) {
      return image
    }
    if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: browser.bundleIdentifier) {
      return NSWorkspace.shared.icon(forFile: appURL.path)
    }
    if let bundled = Bundle.main.url(forResource: browser.id, withExtension: "svg", subdirectory: "BrowserIcons"),
       let image = NSImage(contentsOf: bundled) {
      return image
    }
    return appIcon(bundleIdentifier: browser.bundleIdentifier, fallbackSymbol: "globe")
  }

  private func bundledIcon(_ name: String) -> NSImage? {
    guard let url = Bundle.main.url(forResource: name, withExtension: "svg", subdirectory: "BrowserIcons") else {
      return nil
    }
    return NSImage(contentsOf: url)
  }

  init() {
    runtimeReady = bootstrapBundledRuntimeIfNeeded()
    SourceSnapshot.removeStale(support: support)
    let calendar = Calendar.current
    scheduleTime = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    updateEndpointRunningStatus()
    refreshBrowserlessPreflight()
    endpointStatusTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.updateEndpointRunningStatus() }
    }
    updateTimer = Timer.scheduledTimer(withTimeInterval: 24 * 60 * 60, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.autoCheckUpdates else { return }
        self.checkForUpdates()
      }
    }
  }

  private func bootstrapBundledRuntimeIfNeeded() -> Bool {
    guard let resources = Bundle.main.resourceURL else { return true }
    let bundledRuntime = resources.appending(path: "runtime")
    let bundledNode = bundledRuntime.appending(path: "node/bin/node")
    let bundledCLI = bundledRuntime.appending(path: "bin/brave-codex-cookie-sync.js")
    guard FileManager.default.isExecutableFile(atPath: bundledNode.path),
          FileManager.default.fileExists(atPath: bundledCLI.path) else { return true }

    if Bundle.main.bundlePath.hasPrefix("/Volumes/") {
      state = .warning
      primaryStatus = "Move the app to Applications"
      secondaryStatus = "Drag Browser Cookie Bridge onto Applications in the DMG window, then open it there"
      return false
    }

    let process = Process()
    let output = Pipe()
    process.executableURL = bundledNode
    process.arguments = [
      bundledCLI.path,
      "bootstrap-bundled",
      "--app-path", Bundle.main.bundlePath,
    ]
    process.standardOutput = output
    process.standardError = output

    do {
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus != 0 else { return true }
      let data = output.fileHandleForReading.readDataToEndOfFile()
      let message = String(decoding: data, as: UTF8.self)
        .split(separator: "\n")
        .map(String.init)
        .last(where: { !$0.isEmpty })
      state = .error
      primaryStatus = "Could not prepare the local runtime"
      secondaryStatus = message ?? "Move the app to Applications and reopen it"
      return false
    } catch {
      state = .error
      primaryStatus = "Could not prepare the local runtime"
      secondaryStatus = error.localizedDescription
      return false
    }
  }

  func refresh() {
    dailyEnabled = FileManager.default.fileExists(atPath: launchAgent.path)
    loginSyncEnabled = FileManager.default.fileExists(atPath: loginSyncAgent.path)
    openAtLogin = FileManager.default.fileExists(atPath: appLoginAgent.path)
    if let config = loadConfig() {
      let calendar = Calendar.current
      scheduleTime = calendar.date(
        bySettingHour: config.schedule.hour,
        minute: config.schedule.minute,
        second: 0,
        of: Date()
      ) ?? scheduleTime
      let configuredSource = config.sourceBrowser ?? "brave"
      selectedSourceID = browsers.contains(where: { $0.id == configuredSource }) ? configuredSource : "brave"
      let configuredTarget = config.targetBrowser ?? "codex"
      selectedTargetID = configuredTarget == "codex" || configuredTarget == "cursor" || configuredTarget == "browserless" || configuredTarget == "grok-bot" || browsers.contains(where: { $0.id == configuredTarget })
        ? configuredTarget
        : "codex"
      if selectedTargetID == selectedSourceID { selectedTargetID = "codex" }
      cookiesEnabled = config.imports?.cookies ?? true
      let loadedHistoryEnabled = config.imports?.history ?? false
      let loadedSiteStorageEnabled = config.imports?.siteStorage ?? false
      rememberedHistoryEnabled = config.rememberedImports?.history ?? loadedHistoryEnabled
      rememberedSiteStorageEnabled = config.rememberedImports?.siteStorage ?? loadedSiteStorageEnabled
      historyEnabled = loadedHistoryEnabled
      siteStorageEnabled = loadedSiteStorageEnabled
      if selectedTargetID == "cursor" || selectedTargetID == "grok-bot" {
        historyEnabled = false
        siteStorageEnabled = false
      }
      menuBarEnabled = config.ui?.menuBar ?? true
      autoCheckUpdates = config.ui?.autoCheckUpdates ?? true
      autoRestartCodex = config.ui?.autoRestartCodex ?? false
      autoRestartBoth = config.ui?.autoRestartBoth ?? false
      browserlessProfileName = config.browserless?.profileName ?? "browser-cookie-bridge"
      browserlessRegion = config.browserless?.region ?? "sfo"
      browserlessOnlyDomains = (config.browserless?.onlyDomains ?? []).joined(separator: ", ")
      grokBotOnlyDomains = (config.grokBot?.onlyDomains ?? []).joined(separator: ", ")
    }
    browserlessConfigured = BrowserlessCredentialStore.read() != nil
    NotificationCenter.default.post(name: .menuBarVisibilityChanged, object: menuBarEnabled)
    extensionsReady = requiredExtensionIDs.allSatisfy {
      FileManager.default.fileExists(atPath: support.appending(path: "extension-\($0)/manifest.json").path)
    }
    updateEndpointRunningStatus()
    refreshBrowserlessPreflight()
    consumeUpdateResultIfNeeded()
    if autoCheckUpdates && !didCheckAfterLaunch {
      didCheckAfterLaunch = true
      checkForUpdates()
    }
  }

  func selectSource(_ id: String) {
    guard browsers.contains(where: { $0.id == id }), id != selectedSourceID, id != selectedTargetID else { return }
    selectedSourceID = id
    browserlessAssessment = nil
    assessedBrowserID = nil
    persistPreferences(successMessage: "Export source changed to \(selectedBrowser.name)")
  }

  func selectTarget(_ id: String) {
    let validTarget = id == "codex" || id == "cursor" || id == "browserless" || id == "grok-bot" || browsers.contains(where: { $0.id == id })
    guard validTarget, id != selectedTargetID, id != selectedSourceID else { return }
    let wasCursor = selectedTargetID == "cursor"
    if id == "cursor" && !wasCursor {
      rememberedHistoryEnabled = historyEnabled
      rememberedSiteStorageEnabled = siteStorageEnabled
    }
    selectedTargetID = id
    if id == "cursor" || id == "grok-bot" {
      historyEnabled = false
      siteStorageEnabled = false
    } else if wasCursor {
      historyEnabled = rememberedHistoryEnabled
      siteStorageEnabled = rememberedSiteStorageEnabled
    }
    persistPreferences(successMessage: "Import destination changed to \(targetName)")
    updateEndpointRunningStatus()
    if id == "browserless" && !browserlessConfigured { showingBrowserlessSetup = true }
    if id == "browserless" { refreshBrowserlessPreflight() }
  }

  func setCookiesEnabled(_ enabled: Bool) {
    cookiesEnabled = enabled
    persistPreferences(successMessage: enabled ? "Cookie import enabled" : "Cookie import disabled")
  }

  func setHistoryEnabled(_ enabled: Bool) {
    guard selectedTargetID != "cursor", selectedTargetID != "grok-bot" else { return }
    historyEnabled = enabled
    rememberedHistoryEnabled = enabled
    persistPreferences(successMessage: enabled ? "History URL import enabled" : "History import disabled")
  }

  func setSiteStorageEnabled(_ enabled: Bool) {
    guard selectedTargetID != "cursor", selectedTargetID != "grok-bot" else { return }
    siteStorageEnabled = enabled
    rememberedSiteStorageEnabled = enabled
    persistPreferences(successMessage: enabled ? "Full site-data import enabled" : "Full site-data import disabled")
  }

  func saveBrowserlessSettings(token: String, profileName: String, region: String, onlyDomains: String) {
    let cleanedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanedName = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleanedName.isEmpty, !cleanedToken.isEmpty || BrowserlessCredentialStore.read() != nil else {
      postNativeAlert(title: "Browserless connection incomplete", message: "Enter an API token and cloud profile name.", kind: .warning)
      return
    }
    do {
      if !cleanedToken.isEmpty { try BrowserlessCredentialStore.save(cleanedToken) }
      browserlessConfigured = true
      browserlessProfileName = cleanedName
      browserlessRegion = region
      browserlessOnlyDomains = onlyDomains
      showingBrowserlessSetup = false
      persistPreferences(successMessage: "Browserless connected — uploads remain manual")
      refreshBrowserlessPreflight(force: true)
    } catch {
      postNativeAlert(title: "Could not save Browserless token", message: error.localizedDescription, kind: .error)
    }
  }

  func disconnectBrowserless() {
    BrowserlessCredentialStore.delete()
    browserlessConfigured = false
    showingBrowserlessSetup = false
    updateEndpointRunningStatus()
  }

  func setMenuBarEnabled(_ enabled: Bool) {
    menuBarEnabled = enabled
    NotificationCenter.default.post(name: .menuBarVisibilityChanged, object: enabled)
    persistPreferences(successMessage: enabled ? "Menu-bar icon enabled" : "Menu-bar icon hidden")
  }

  func setAutoCheckUpdates(_ enabled: Bool) {
    autoCheckUpdates = enabled
    persistPreferences(successMessage: enabled ? "Automatic update checks enabled" : "Automatic update checks disabled")
    if enabled { checkForUpdates() }
  }

  func setAutoRestartCodex(_ enabled: Bool) {
    autoRestartCodex = enabled
    persistPreferences(successMessage: enabled ? "Automatic Codex restart enabled" : "Automatic Codex restart disabled")
  }

  func setAutoRestartBoth(_ enabled: Bool) {
    autoRestartBoth = enabled
    persistPreferences(successMessage: enabled ? "Automatic source and Codex restart enabled" : "Automatic source and Codex restart disabled")
  }

  func checkForUpdates(showAlert: Bool = false) {
    guard !isCheckingForUpdates, !isInstallingUpdate else { return }
    guard let url = URL(string: "https://api.github.com/repos/apoorvdarshan/browser-cookie-bridge/releases/latest") else { return }
    isCheckingForUpdates = true
    postUpdateState()
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.setValue("Browser-Cookie-Bridge/\(currentVersion)", forHTTPHeaderField: "User-Agent")
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      Task { @MainActor in
        guard let self else { return }
        self.isCheckingForUpdates = false
        let status = (response as? HTTPURLResponse)?.statusCode
        if let error {
          self.postUpdateState()
          if showAlert {
            self.postNativeAlert(title: "Could not check for updates", message: error.localizedDescription, kind: .error)
          }
          return
        }
        guard status == 200,
              let data,
              let release = try? JSONDecoder().decode(PackageRelease.self, from: data) else {
          self.postUpdateState()
          if showAlert {
            let message = status == 404
              ? "No public release is available yet. This development build is already installed."
              : "The update service returned an unexpected response. Try again later."
            self.postNativeAlert(title: "No update information", message: message, kind: status == 404 ? .information : .error)
          }
          return
        }
        if self.isVersion(release.version, newerThan: self.currentVersion) {
          self.availableUpdateVersion = release.version
          if !self.directTargetBlocked && !self.isSyncing {
            self.showResult(.ready, "Update \(release.version) available", "Install it now; the app will relaunch automatically")
          }
          if showAlert {
            self.postNativeAlert(
              title: "Update \(release.version) is available",
              message: "Choose Install Update in the menu bar or click Install in the app.",
              kind: .information
            )
          }
        } else {
          self.availableUpdateVersion = nil
          if showAlert {
            self.postNativeAlert(title: "Browser Cookie Bridge is up to date", message: "Version \(self.currentVersion) is the latest available release.", kind: .information)
          }
        }
        self.postUpdateState()
      }
    }.resume()
  }

  func installAvailableUpdate() {
    guard let version = availableUpdateVersion, !isInstallingUpdate else { return }
    isInstallingUpdate = true
    state = .syncing
    primaryStatus = "Preparing update \(version)"
    secondaryStatus = "The app will close, install the update, and relaunch automatically"
    postUpdateState()
    runCLI([
      "install-update",
      "--version", version,
      "--app-path", Bundle.main.bundlePath,
      "--app-pid", String(ProcessInfo.processInfo.processIdentifier)
    ]) { [weak self] success, output in
      guard let self else { return }
      if success {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { NSApp.terminate(nil) }
      } else {
        self.isInstallingUpdate = false
        self.state = .error
        self.primaryStatus = "Could not start the update"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Try again from the menu bar"
        self.postUpdateState()
        self.postNativeAlert(title: self.primaryStatus, message: self.secondaryStatus, kind: .error)
      }
    }
  }

  func setGrokBotOnlyDomains(_ value: String) {
    grokBotOnlyDomains = value
    persistPreferences(successMessage: "Grok Bot domain filter updated")
  }

  func openFullDiskAccessSettings() {
    guard !FullDiskAccess.openSettings() else { return }
    postNativeAlert(
      title: "Could not open System Settings",
      message: FullDiskAccess.instructions,
      kind: .warning
    )
  }

  func syncNow(showMenuBarAlert: Bool = false) {
    guard !isSyncing else {
      if isBrowserlessTarget {
        cancelSync()
        return
      }
      if showMenuBarAlert {
        postNativeAlert(title: "Sync already running", message: "Wait for the current transfer to finish.", kind: .information)
      }
      return
    }
    updateEndpointRunningStatus()
    guard !syncBlocked else {
      if showMenuBarAlert {
        postNativeAlert(
          title: primaryStatus,
          message: secondaryStatus,
          kind: .warning,
          secondaryButton: grokBotSourceAccessBlocked ? .openFullDiskAccessSettings : nil
        )
      }
      return
    }
    if isGrokBotTarget {
      startGrokBotExport(showMenuBarAlert: showMenuBarAlert)
      return
    }
    if selectedTargetID == "codex" && siteStorageEnabled && autoRestartBoth && (sourceBrowserRunning || codexRunning) {
      forceQuitBothThenSync(showMenuBarAlert: showMenuBarAlert)
      return
    }
    if selectedTargetID == "codex" && codexRunning && autoRestartCodex {
      forceQuitCodexThenSync(showMenuBarAlert: showMenuBarAlert)
      return
    }
    startSync(showMenuBarAlert: showMenuBarAlert, reopenCodexOnSuccess: false)
  }

  private func forceQuitBothThenSync(showMenuBarAlert: Bool) {
    let sourceApplications = NSWorkspace.shared.runningApplications.filter {
      $0.bundleIdentifier == selectedBrowser.bundleIdentifier
    }
    let codexApplications = NSWorkspace.shared.runningApplications.filter {
      $0.bundleIdentifier == "com.openai.codex"
    }
    let reopenSource = !sourceApplications.isEmpty
    let reopenCodex = !codexApplications.isEmpty
    let applications = sourceApplications + codexApplications

    isSyncing = true
    uploadCanceling = false
    state = .syncing
    primaryStatus = "Closing both apps for full sync"
    secondaryStatus = "Force quitting \(selectedBrowser.name) and ChatGPT Codex, then waiting for their browser storage to close…"
    guard applications.allSatisfy({ $0.forceTerminate() }) else {
      finishCodexPreparationFailure(
        message: "macOS could not force quit both apps. Close \(selectedBrowser.name) and ChatGPT Codex manually, then try again.",
        showMenuBarAlert: showMenuBarAlert
      )
      return
    }
    waitForBothToQuit(
      attemptsRemaining: 50,
      reopenSource: reopenSource,
      reopenCodex: reopenCodex,
      showMenuBarAlert: showMenuBarAlert
    )
  }

  private func waitForBothToQuit(
    attemptsRemaining: Int,
    reopenSource: Bool,
    reopenCodex: Bool,
    showMenuBarAlert: Bool
  ) {
    let runningBundleIDs = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
    let stillRunning = runningBundleIDs.contains(selectedBrowser.bundleIdentifier) || runningBundleIDs.contains("com.openai.codex")
    if !stillRunning {
      sourceBrowserRunning = false
      codexRunning = false
      secondaryStatus = "Both apps are closed — waiting briefly for browser storage to be released…"
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
        self?.startSync(
          showMenuBarAlert: showMenuBarAlert,
          reopenCodexOnSuccess: reopenCodex,
          reopenSourceOnSuccess: reopenSource
        )
      }
      return
    }
    guard attemptsRemaining > 0 else {
      finishCodexPreparationFailure(
        message: "The apps did not close within 10 seconds. Close both manually, then try again.",
        showMenuBarAlert: showMenuBarAlert
      )
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      self?.waitForBothToQuit(
        attemptsRemaining: attemptsRemaining - 1,
        reopenSource: reopenSource,
        reopenCodex: reopenCodex,
        showMenuBarAlert: showMenuBarAlert
      )
    }
  }

  private func forceQuitCodexThenSync(showMenuBarAlert: Bool) {
    isSyncing = true
    uploadCanceling = false
    state = .syncing
    primaryStatus = "Closing Codex for sync"
    secondaryStatus = "Force quitting ChatGPT Codex and waiting for its browser database to close…"
    let applications = NSWorkspace.shared.runningApplications.filter {
      $0.bundleIdentifier == "com.openai.codex"
    }
    guard !applications.isEmpty, applications.allSatisfy({ $0.forceTerminate() }) else {
      finishCodexPreparationFailure(
        message: "macOS could not force quit ChatGPT Codex. Quit it manually, then try again.",
        showMenuBarAlert: showMenuBarAlert
      )
      return
    }
    waitForCodexToQuit(attemptsRemaining: 50, showMenuBarAlert: showMenuBarAlert)
  }

  private func waitForCodexToQuit(attemptsRemaining: Int, showMenuBarAlert: Bool) {
    let stillRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == "com.openai.codex"
    }
    if !stillRunning {
      codexRunning = false
      secondaryStatus = "Codex is closed — waiting briefly for its database to be released…"
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
        self?.startSync(showMenuBarAlert: showMenuBarAlert, reopenCodexOnSuccess: true)
      }
      return
    }
    guard attemptsRemaining > 0 else {
      finishCodexPreparationFailure(
        message: "ChatGPT Codex did not close within 10 seconds. Quit it manually, then try again.",
        showMenuBarAlert: showMenuBarAlert
      )
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      self?.waitForCodexToQuit(attemptsRemaining: attemptsRemaining - 1, showMenuBarAlert: showMenuBarAlert)
    }
  }

  private func finishCodexPreparationFailure(message: String, showMenuBarAlert: Bool) {
    isSyncing = false
    state = .error
    primaryStatus = "Could not close Codex"
    secondaryStatus = message
    updateEndpointRunningStatus()
    if showMenuBarAlert {
      postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .error)
    }
  }

  private func startGrokBotExport(showMenuBarAlert: Bool) {
    let panel = NSSavePanel()
    panel.title = "Save Grok Bot transfer file"
    // Base name only: including ".bcbx" here plus allowedContentTypes often makes macOS append a second extension (GrokBot-Import.bcbx.bcbx) and breaks Replace on an existing file.
    panel.nameFieldStringValue = "GrokBot-Import"
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    panel.allowsOtherFileTypes = false
    if #available(macOS 12.0, *) {
      panel.allowedContentTypes = [UTType(filenameExtension: "bcbx") ?? .data]
    } else {
      panel.allowedFileTypes = ["bcbx"]
    }
    AppDiagnostics.log("grok-bot: presenting save panel")
    panel.begin { [weak self] response in
      guard let self else { return }
      guard response == .OK else {
        AppDiagnostics.log("grok-bot: save panel dismissed without saving (response \(response.rawValue))")
        return
      }
      guard let chosen = panel.url else {
        AppDiagnostics.log("grok-bot: save panel returned OK without a URL")
        self.showResult(
          .error,
          "Could not create the Grok Bot transfer file",
          "macOS did not return a save location. Try again and choose a folder such as Downloads."
        )
        self.postNativeAlert(title: self.primaryStatus, message: self.secondaryStatus, kind: .error)
        return
      }
      let url = Self.normalizedGrokBotOutputURL(chosen)
      AppDiagnostics.log("grok-bot: save panel OK → \(url.path)\(url.path == chosen.path ? "" : " (normalized from \(chosen.path))")")
      self.startSync(showMenuBarAlert: showMenuBarAlert, reopenCodexOnSuccess: false, grokBotOutputPath: url.path)
    }
  }

  /// The save panel is fed a base name plus a dynamic `.bcbx` UTType; depending on the macOS release it has
  /// returned `Name.bcbx`, `Name.bcbx.bcbx`, or `Name`. The CLI rejects anything that is not exactly `.bcbx`,
  /// so normalize here instead of letting the export fail after the user already confirmed Replace.
  static func normalizedGrokBotOutputURL(_ url: URL) -> URL {
    var path = url.path
    while path.lowercased().hasSuffix(".bcbx.bcbx") { path.removeLast(5) }
    if !path.lowercased().hasSuffix(".bcbx") { path += ".bcbx" }
    return URL(fileURLWithPath: path)
  }

  private static func fileWasWritten(atPath path: String, since startedAt: Date) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
          let modified = attributes[.modificationDate] as? Date else { return false }
    // Filesystem timestamps can be coarser than Date(); allow a small tolerance.
    return modified >= startedAt.addingTimeInterval(-2)
  }

  private func showResult(_ newState: State, _ primary: String, _ secondary: String) {
    state = newState
    primaryStatus = primary
    secondaryStatus = secondary
    showingOperationResult = true
  }

  private func startSync(showMenuBarAlert: Bool, reopenCodexOnSuccess: Bool, reopenSourceOnSuccess: Bool = false, grokBotOutputPath: String? = nil) {
    isSyncing = true
    uploadCanceling = false
    showingOperationResult = false
    state = .syncing
    primaryStatus = isGrokBotTarget
      ? "Creating Grok Bot transfer file"
      : isBrowserlessTarget ? "Uploading authenticated state" : "Transferring selected data"
    secondaryStatus = isGrokBotTarget
      ? "Encrypting selected cookie sessions from \(selectedBrowser.name)…"
      : isDirectTarget
      ? "Backing up \(targetName) and merging \(selectedBrowser.name) locally…"
      : isBrowserlessTarget
        ? "Sending \(selectedBrowser.name) to Browserless \(browserlessRegion.uppercased()) only for this request…"
        : "Waiting for \(selectedBrowser.name) and \(targetName)…"
    var environment: [String: String] = [:]
    var arguments = ["sync", "--timeout", isBrowserlessTarget ? "900" : "300"]
    if let grokBotOutputPath {
      activeGrokBotOutputPath = grokBotOutputPath
      arguments.append(contentsOf: ["--output", grokBotOutputPath])
    } else {
      activeGrokBotOutputPath = nil
    }
    if isBrowserlessTarget {
      guard let token = BrowserlessCredentialStore.read() else {
        isSyncing = false
        browserlessConfigured = false
        showResult(.error, "Browserless token is missing", "Reconnect Browserless from the Configure… button, then upload again.")
        postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .error)
        updateEndpointRunningStatus()
        return
      }
      environment["BROWSERLESS_TOKEN"] = token
      arguments.append("--allow-cloud-upload")
      beginUploadTracking()
    }
    let sourceSnapshot: SourceSnapshot?
    if isGrokBotTarget || isDirectTarget {
      switch takeSourceSnapshot() {
      case .taken(let snapshot):
        sourceSnapshot = snapshot
        environment[SourceSnapshot.environmentKey] = snapshot.directory.path
      case .unavailable:
        sourceSnapshot = nil
      case .denied(let detail):
        isSyncing = false
        activeGrokBotOutputPath = nil
        showResult(.error, FullDiskAccess.statusTitle(browserName: selectedBrowser.name), detail)
        updateEndpointRunningStatus()
        postNativeAlert(
          title: primaryStatus,
          message: "\(detail)\n\nDetails: \(AppDiagnostics.appLogURL.path)",
          kind: .error,
          secondaryButton: .openFullDiskAccessSettings
        )
        return
      }
    } else {
      sourceSnapshot = nil
    }
    let startedAt = Date()
    let target = selectedTargetID
    let launchArguments = arguments
    activeSyncProcess = runCLI(arguments, environment: environment, onLine: { [weak self] line in
      self?.handleBrowserlessProgress(line)
    }) { [weak self] success, output in
      sourceSnapshot?.discard()
      guard let self else { return }
      self.activeSyncProcess = nil
      self.isSyncing = false
      self.finishUploadTracking()
      let partial = success && (
        output.contains("Partially synced:")
          || output.contains("with warnings")
          || output.contains("omitted to fit")
          || output.contains("could not be captured")
      )
      if let grokBotOutputPath {
        self.finishGrokBotExport(
          success: success,
          partial: partial,
          output: output,
          requestedPath: grokBotOutputPath,
          startedAt: startedAt,
          arguments: launchArguments
        )
        return
      }
      let canceled = output.contains("Browserless upload canceled") || output.contains("Temporary profile data was removed")
      if canceled {
        self.showResult(.canceled, "Browserless upload canceled", "No cloud profile was changed; temporary profile data was removed")
      } else if success {
        let primary = self.isBrowserlessTarget
          ? (partial ? "Browserless profile uploaded with omissions" : "Browserless profile uploaded")
          : self.isDirectTarget
          ? (partial ? "\(self.targetName) sync completed with warnings" : "\(self.targetName) sessions updated")
          : (partial ? "Partially synced" : "Transfer complete")
        self.showResult(
          partial ? .warning : .success,
          primary,
          self.lastMeaningfulLine(output) ?? "\(self.selectedBrowser.name) and \(self.targetName) are up to date"
        )
      } else if self.noteFullDiskAccessDenial(in: output) {
        self.showResult(
          .error,
          FullDiskAccess.statusTitle(browserName: self.selectedBrowser.name),
          self.lastMeaningfulLine(output) ?? FullDiskAccess.statusDetail(browserName: self.selectedBrowser.name)
        )
      } else {
        self.showResult(
          .error,
          "Sync did not finish",
          self.lastMeaningfulLine(output) ?? (self.isDirectTarget
            ? "Quit \(self.targetName) completely, then try again"
            : self.isBrowserlessTarget
              ? "Check the API token, close the source browser, and try again"
            : "Keep both browsers open and check the extensions")
        )
      }
      AppDiagnostics.writeLastSyncResult(SyncResultRecord(
        startedAt: startedAt,
        finishedAt: Date(),
        target: target,
        arguments: launchArguments,
        exitStatus: self.lastCLIExit?.status,
        terminatedBySignal: self.lastCLIExit?.signaled ?? false,
        success: success,
        outputPath: nil,
        bundleWritten: nil,
        presented: false,
        lastLine: self.lastMeaningfulLine(output)
      ))
      self.updateEndpointRunningStatus()
      if success && (reopenCodexOnSuccess || reopenSourceOnSuccess) {
        self.reopenApplicationsAfterSuccessfulSync(
          partial: partial,
          syncSummary: self.secondaryStatus,
          reopenCodex: reopenCodexOnSuccess,
          reopenSource: reopenSourceOnSuccess,
          showMenuBarAlert: showMenuBarAlert
        )
      } else if showMenuBarAlert || (!success && !canceled) {
        // Failures always get a modal alert: a status line that can be missed is not an error report.
        let accessDenied = !success && FullDiskAccess.indicatesDenial(in: output)
        self.postNativeAlert(
          title: self.primaryStatus,
          message: !success && !canceled
            ? "\(self.secondaryStatus)\n\nDetails: \(AppDiagnostics.appLogURL.path)"
            : self.secondaryStatus,
          kind: canceled ? .information : success ? (partial ? .warning : .information) : .error,
          secondaryButton: accessDenied ? .openFullDiskAccessSettings : nil
        )
      }
    }
  }

  /// Completes a Grok Bot export. Presentation is driven by whether the `.bcbx` file was actually (re)written,
  /// not only by the exit status, so the result panel can never be skipped after a successful write and a
  /// failure can never end with just a status-line change.
  private func finishGrokBotExport(
    success: Bool,
    partial: Bool,
    output: String,
    requestedPath: String,
    startedAt: Date,
    arguments: [String]
  ) {
    let parsed = parseGrokBotResult(from: output)
    let outputPath = parsed?.outputPath ?? requestedPath
    let bundleWritten = Self.fileWasWritten(atPath: outputPath, since: startedAt)
    let fileName = URL(fileURLWithPath: outputPath).lastPathComponent
    let cliExit = lastCLIExit
    activeGrokBotOutputPath = nil
    AppDiagnostics.log(
      "grok-bot: CLI finished success=\(success) exit=\(cliExit.map { String($0.status) } ?? "nil") "
        + "signaled=\(cliExit?.signaled ?? false) resultLine=\(parsed != nil) bundleWritten=\(bundleWritten) path=\(outputPath)"
    )

    let treatAsSuccess = success || bundleWritten
    AppDiagnostics.writeLastSyncResult(SyncResultRecord(
      startedAt: startedAt,
      finishedAt: Date(),
      target: "grok-bot",
      arguments: arguments,
      exitStatus: cliExit?.status,
      terminatedBySignal: cliExit?.signaled ?? false,
      success: treatAsSuccess,
      outputPath: outputPath,
      bundleWritten: bundleWritten,
      presented: treatAsSuccess,
      lastLine: lastMeaningfulLine(output)
    ))
    if treatAsSuccess {
      if !success {
        AppDiagnostics.log("grok-bot: exit status was non-zero but \(fileName) was rewritten — presenting the result anyway")
      }
      showResult(
        partial ? .warning : .success,
        partial ? "Grok Bot transfer created with warnings" : "Grok Bot transfer file ready",
        lastMeaningfulLine(output) ?? "Attach \(fileName) to any Grok Bot and paste the prompt"
      )
      updateEndpointRunningStatus()
      presentGrokBotResultSheet(prompt: parsed?.prompt ?? Self.grokBotFallbackPrompt, outputPath: outputPath)
    } else if noteFullDiskAccessDenial(in: output) {
      // EPERM here is TCC, not a lock: the browser is already closed (the quit-browser gate ran before Create),
      // so telling the user to close it again would be wrong. Point at Full Disk Access instead.
      let detail = lastMeaningfulLine(output) ?? FullDiskAccess.statusDetail(browserName: selectedBrowser.name)
      showResult(.error, FullDiskAccess.statusTitle(browserName: selectedBrowser.name), detail)
      updateEndpointRunningStatus()
      postNativeAlert(
        title: primaryStatus,
        message: "\(detail)\n\n\(fileName) was not written. Details: \(AppDiagnostics.appLogURL.path)",
        kind: .error,
        secondaryButton: .openFullDiskAccessSettings
      )
    } else {
      let detail = lastMeaningfulLine(output)
        ?? "The local sync runtime exited (status \(cliExit.map { String($0.status) } ?? "unknown")) without writing \(fileName)."
      showResult(.error, "Could not create the Grok Bot transfer file", detail)
      updateEndpointRunningStatus()
      postNativeAlert(
        title: primaryStatus,
        message: "\(detail)\n\n\(fileName) was not written. Details: \(AppDiagnostics.appLogURL.path)",
        kind: .error
      )
    }
  }

  private enum SourceSnapshotOutcome {
    case taken(SourceSnapshot)
    /// Nothing to copy or a non-permission failure: the CLI falls back to reading the profile itself.
    case unavailable
    /// The app process itself was refused (TCC). Launching the CLI would only fail the same way.
    case denied(String)
  }

  /// Copies the source cookie store with the app's own Full Disk Access before the CLI starts, so a Homebrew
  /// Node binary never has to open the live database and the source browser can stay open.
  private func takeSourceSnapshot() -> SourceSnapshotOutcome {
    let includeHistory = isDirectTarget && historyEnabled
    do {
      guard let snapshot = try SourceSnapshot.take(
        browserID: selectedSourceID,
        includeHistory: includeHistory,
        support: support,
        home: home
      ) else {
        AppDiagnostics.log("snapshot: no cookie store found for \(selectedBrowser.name); the CLI will read the profile directly")
        return .unavailable
      }
      AppDiagnostics.log("snapshot: copied \(snapshot.files.joined(separator: ", ")) for \(selectedBrowser.name) into \(snapshot.directory.lastPathComponent)")
      return .taken(snapshot)
    } catch {
      if FullDiskAccess.isDenial(error) {
        AppDiagnostics.log("snapshot: macOS denied copying the \(selectedBrowser.name) cookie store — \(error.localizedDescription)")
        cliReportedAccessDenied = true
        sourceCookieAccessDenied = true
        return .denied(FullDiskAccess.statusDetail(browserName: selectedBrowser.name))
      }
      AppDiagnostics.log("snapshot: could not copy the \(selectedBrowser.name) cookie store (\(error.localizedDescription)); the CLI will read the profile directly")
      return .unavailable
    }
  }

  /// Records a Full Disk Access denial reported by the CLI so the in-app gate appears immediately, before the
  /// next native probe runs. Returns whether the output described such a denial.
  private func noteFullDiskAccessDenial(in output: String) -> Bool {
    guard FullDiskAccess.indicatesDenial(in: output) else { return false }
    AppDiagnostics.log("full-disk-access: CLI reported a TCC denial for \(selectedBrowser.name)")
    cliReportedAccessDenied = true
    sourceCookieAccessDenied = true
    return true
  }

  private func reopenApplicationsAfterSuccessfulSync(
    partial: Bool,
    syncSummary: String,
    reopenCodex: Bool,
    reopenSource: Bool,
    showMenuBarAlert: Bool
  ) {
    let transferResult = syncSummary.replacingOccurrences(
      of: "Reopen Codex to use the updated sessions. ",
      with: ""
    )
    var restartMessages: [String] = []
    var sourceRestartFailed = false
    if reopenSource {
      if let sourceURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: selectedBrowser.bundleIdentifier),
         NSWorkspace.shared.open(sourceURL) {
        sourceBrowserRunning = true
        restartMessages.append("\(selectedBrowser.name) reopened successfully.")
      } else {
        sourceRestartFailed = true
        restartMessages.append("\(selectedBrowser.name) could not be reopened; open it manually.")
      }
    }
    let completedRestartMessages = restartMessages
    let didSourceRestartFail = sourceRestartFailed
    guard reopenCodex else {
      state = partial || didSourceRestartFail ? .warning : .success
      primaryStatus = didSourceRestartFail ? "Sync complete, but the source did not reopen" : (partial ? "Codex sync completed with warnings" : "Full site-data sync complete")
      secondaryStatus = ([transferResult] + completedRestartMessages).joined(separator: "\n\n")
      if showMenuBarAlert {
        postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: state == .success ? .information : .warning)
      }
      return
    }
    guard let codexURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") else {
      state = .warning
      primaryStatus = "Codex sessions updated, but Codex was not reopened"
      secondaryStatus = ([transferResult] + completedRestartMessages + ["Codex could not be found. Open it manually to use the updated sessions."]).joined(separator: "\n\n")
      if showMenuBarAlert {
        postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .warning)
      }
      return
    }
    if NSWorkspace.shared.open(codexURL) {
      codexRunning = true
      state = partial || didSourceRestartFail ? .warning : .success
      primaryStatus = didSourceRestartFail ? "Sync complete, but the source did not reopen" : (partial ? "Codex sync completed with warnings" : "Codex sessions updated")
      secondaryStatus = ([transferResult] + completedRestartMessages + ["ChatGPT Codex reopened successfully."]).joined(separator: "\n\n")
    } else {
      state = .warning
      primaryStatus = "Codex sessions updated, but Codex was not reopened"
      secondaryStatus = ([transferResult] + completedRestartMessages + ["Codex could not be reopened. Open it manually to use the updated sessions."]).joined(separator: "\n\n")
    }
    if showMenuBarAlert {
      postNativeAlert(
        title: primaryStatus,
        message: secondaryStatus,
        kind: state == .success ? .information : .warning
      )
    }
  }

  func cancelSync() {
    guard isBrowserlessTarget, isSyncing, !uploadCanceling else { return }
    uploadCanceling = true
    primaryStatus = "Canceling Browserless upload"
    secondaryStatus = "Stopping the temporary browser and removing its isolated workspace…"
    postSyncState()
    activeSyncProcess?.terminate()
  }

  func refreshBrowserlessPreflight(force: Bool = false) {
    guard isBrowserlessTarget, selectedSourceID != "comet", !isInspectingBrowserlessProfile else { return }
    if !force, assessedBrowserID == selectedSourceID, browserlessAssessment != nil { return }
    isInspectingBrowserlessProfile = true
    let sourceAtStart = selectedSourceID
    runCLI(["browserless-preflight"]) { [weak self] success, output in
      guard let self else { return }
      self.isInspectingBrowserlessProfile = false
      guard self.selectedSourceID == sourceAtStart else { return }
      if success, let assessment = self.decodeLastJSON(BrowserlessProfileAssessment.self, from: output) {
        self.browserlessAssessment = assessment
        self.assessedBrowserID = sourceAtStart
      } else if force {
        self.browserlessAssessment = nil
        self.assessedBrowserID = nil
      }
    }
  }

  func setDailyEnabled(_ enabled: Bool) {
    guard !isBrowserlessTarget else {
      postNativeAlert(title: "Cloud uploads are manual-only", message: "Browser Cookie Bridge will never schedule Browserless uploads in the background.", kind: .information)
      return
    }
    dailyEnabled = enabled
    applySchedule(enabled)
  }

  func saveSchedule() {
    applySchedule(true)
  }

  func setLoginSyncEnabled(_ enabled: Bool) {
    guard !isBrowserlessTarget else {
      postNativeAlert(title: "Cloud uploads are manual-only", message: "Login sync does not send authenticated state to Browserless.", kind: .information)
      return
    }
    loginSyncEnabled = enabled
    isWorking = true
    runCLI([enabled ? "enable-login-sync" : "disable-login-sync"]) { [weak self] success, output in
      guard let self else { return }
      self.isWorking = false
      if success {
        self.showResult(
          .ready,
          enabled ? "Sync at login enabled" : "Sync at login disabled",
          enabled ? "A sync starts now and whenever you sign in" : "The fixed daily schedule is unchanged"
        )
      } else {
        self.loginSyncEnabled.toggle()
        self.showResult(.error, "Could not update login sync", self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI")
      }
      self.refresh()
    }
  }

  func setOpenAtLogin(_ enabled: Bool) {
    openAtLogin = enabled
    isWorking = true
    runCLI([enabled ? "enable-app-login" : "disable-app-login"]) { [weak self] success, output in
      guard let self else { return }
      self.isWorking = false
      if success {
        self.showResult(
          .ready,
          enabled ? "Opens at login" : "Login launch disabled",
          enabled ? "The app starts automatically after sign-in" : "Open the app manually when you need it"
        )
      } else {
        self.openAtLogin.toggle()
        self.showResult(.error, "Could not update login launch", self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI")
      }
      self.refresh()
    }
  }

  func openExtensions(for browserID: String) {
    guard let browser = browsers.first(where: { $0.id == browserID }) else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", browser.applicationName, browser.extensionURL]
    try? process.run()
  }

  func revealExtension(_ role: String) {
    let folder = support.appending(path: "extension-\(role)")
    NSWorkspace.shared.activateFileViewerSelecting([folder])
  }

  private func persistPreferences(successMessage: String) {
    isWorking = true
    let arguments = [
      "preferences",
      "--source", selectedSourceID,
      "--target", selectedTargetID,
      "--cookies", cookiesEnabled ? "on" : "off",
      "--history", historyEnabled ? "on" : "off",
      "--site-storage", siteStorageEnabled ? "on" : "off",
      "--menu-bar", menuBarEnabled ? "on" : "off",
      "--auto-check-updates", autoCheckUpdates ? "on" : "off",
      "--auto-restart-codex", autoRestartCodex ? "on" : "off",
      "--auto-restart-both", autoRestartBoth ? "on" : "off",
      "--browserless-profile", browserlessProfileName,
      "--browserless-region", browserlessRegion,
      "--browserless-domains", browserlessOnlyDomains,
      "--grok-bot-domains", grokBotOnlyDomains,
    ]
    runCLI(arguments) { [weak self] success, output in
      guard let self else { return }
      self.isWorking = false
      if success {
        self.showResult(
          .ready,
          successMessage,
          self.isBrowserlessTarget
            ? "Cloud uploads run only after you click Upload"
            : self.isGrokBotTarget
              ? "Transfer files are created only when you click Create transfer file"
            : "This choice is saved for manual and daily syncs"
        )
      } else {
        self.showResult(.error, "Could not save import settings", self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI")
        self.refresh()
      }
      self.extensionsReady = self.requiredExtensionIDs.allSatisfy {
        FileManager.default.fileExists(atPath: self.support.appending(path: "extension-\($0)/manifest.json").path)
      }
      self.updateEndpointRunningStatus()
      self.refreshBrowserlessPreflight()
    }
  }

  private func applySchedule(_ enabled: Bool) {
    isWorking = true
    let calendar = Calendar.current
    let hour = calendar.component(.hour, from: scheduleTime)
    let minute = calendar.component(.minute, from: scheduleTime)
    let arguments = enabled
      ? ["setup", "--hour", String(hour), "--minute", String(minute)]
      : ["remove-schedule"]
    runCLI(arguments) { [weak self] success, output in
      guard let self else { return }
      self.isWorking = false
      if success {
        self.showResult(
          .ready,
          enabled ? "Daily sync enabled" : "Daily sync disabled",
          enabled ? "Scheduled for \(self.formattedTime)" : "Use Sync now whenever you need it"
        )
      } else {
        self.dailyEnabled.toggle()
        self.showResult(.error, "Could not update schedule", self.lastMeaningfulLine(output) ?? "Run setup again from the CLI")
      }
      self.refresh()
    }
  }

  @discardableResult
  private func runCLI(
    _ arguments: [String],
    environment: [String: String] = [:],
    onLine: (@MainActor (String) -> Void)? = nil,
    completion: @escaping @MainActor (Bool, String) -> Void
  ) -> Process? {
    let command = arguments.first ?? "?"
    func failBeforeLaunch(_ message: String) -> Process? {
      AppDiagnostics.log("cli \(command): not started — \(message)")
      lastCLIExit = nil
      completion(false, message)
      return nil
    }
    guard let config = loadConfig() else {
      return failBeforeLaunch("Configuration missing or unreadable at \(support.appending(path: "config.json").path). Run install-app again.")
    }
    guard FileManager.default.isExecutableFile(atPath: config.nodePath) else {
      return failBeforeLaunch("Node runtime not found at \(config.nodePath). Run install-app again so config.json points at a working Node.")
    }
    guard FileManager.default.fileExists(atPath: runtimeCLI.path) else {
      return failBeforeLaunch("Local sync runtime missing at \(runtimeCLI.path). Run install-app (npm run build:app) again.")
    }
    let process = Process()
    let output = Pipe()
    let collector = ProcessOutputCollector()
    let drained = DispatchSemaphore(value: 0)
    process.executableURL = URL(fileURLWithPath: config.nodePath)
    process.arguments = [runtimeCLI.path] + arguments
    process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        // EOF: the child closed its side. Stop the handler and let the termination handler finish up.
        handle.readabilityHandler = nil
        drained.signal()
        return
      }
      let lines = collector.append(data)
      guard let onLine, !lines.isEmpty else { return }
      Task { @MainActor in lines.forEach(onLine) }
    }
    process.terminationHandler = { process in
      // Wait for the pipe to drain before snapshotting the output. Previously the termination handler
      // raced the readability handler for the final chunk, which could drop the last line (BCB_GROK_RESULT).
      if drained.wait(timeout: .now() + 5) == .timedOut {
        output.fileHandleForReading.readabilityHandler = nil
        _ = collector.append(output.fileHandleForReading.readDataToEndOfFile())
      }
      let lines = collector.append(Data(), finish: true)
      let status = process.terminationStatus
      let signaled = process.terminationReason == .uncaughtSignal
      var text = collector.text
      if signaled { text += "\nThe sync process was stopped by signal \(status)." }
      let snapshot = text
      let tail = snapshot.split(separator: "\n").suffix(6).joined(separator: " | ")
      AppDiagnostics.log("cli \(command): exit=\(status) signaled=\(signaled) tail=\(tail)")
      Task { @MainActor in
        if let onLine { lines.forEach(onLine) }
        self.lastCLIExit = (status: status, signaled: signaled)
        completion(status == 0 && !signaled, snapshot)
      }
    }
    do {
      AppDiagnostics.log("cli \(command): launching \(config.nodePath) \(runtimeCLI.path) \(arguments.joined(separator: " "))")
      try process.run()
      return process
    } catch {
      return failBeforeLaunch("Could not start \(config.nodePath): \(error.localizedDescription)")
    }
  }

  private func appIcon(bundleIdentifier: String, fallbackSymbol: String) -> NSImage {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) {
      return NSWorkspace.shared.icon(forFile: url.path)
    }
    return NSImage(systemSymbolName: fallbackSymbol, accessibilityDescription: nil) ?? NSImage()
  }

  private func chatGPTResource(_ filename: String) -> NSImage? {
    guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") else { return nil }
    return NSImage(contentsOf: appURL.appending(path: "Contents/Resources/\(filename)"))
  }

  private func loadConfig() -> AppConfig? {
    let url = support.appending(path: "config.json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(AppConfig.self, from: data)
  }

  private func lastMeaningfulLine(_ output: String) -> String? {
    // Skip machine-readable lines (BCB_GROK_RESULT, BCB_PROGRESS) so the status shows the human summary.
    guard let line = output.split(separator: "\n").map(String.init)
      .last(where: { !$0.isEmpty && !$0.hasPrefix("BCB_") }) else { return nil }
    return line.hasPrefix("Error: ") ? String(line.dropFirst(7)) : line
  }

  private func decodeLastJSON<T: Decodable>(_ type: T.Type, from output: String) -> T? {
    for line in output.split(separator: "\n").reversed() {
      guard let data = String(line).data(using: .utf8),
            let value = try? JSONDecoder().decode(type, from: data) else { continue }
      return value
    }
    return nil
  }

  private func beginUploadTracking() {
    uploadProgress = 0.01
    uploadElapsedSeconds = 0
    uploadStartedAt = Date()
    uploadTimer?.invalidate()
    uploadTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, let started = self.uploadStartedAt else { return }
        self.uploadElapsedSeconds = max(0, Int(Date().timeIntervalSince(started)))
      }
    }
    postSyncState()
  }

  private func finishUploadTracking() {
    uploadTimer?.invalidate()
    uploadTimer = nil
    uploadStartedAt = nil
    uploadCanceling = false
    postSyncState()
  }

  private func handleBrowserlessProgress(_ line: String) {
    guard line.hasPrefix("BCB_PROGRESS "),
          let data = String(line.dropFirst("BCB_PROGRESS ".count)).data(using: .utf8),
          let event = try? JSONDecoder().decode(BrowserlessProgressEvent.self, from: data) else { return }
    if let fraction = event.fraction { uploadProgress = min(max(fraction, uploadProgress), 1) }
    if let assessment = event.assessment {
      browserlessAssessment = assessment
      assessedBrowserID = selectedSourceID
    }
    guard !uploadCanceling else { return }
    primaryStatus = switch event.phase {
    case "preflight": "Inspecting the local profile"
    case "preflight-complete": "Profile preflight complete"
    case "validating": "Checking Browserless profile"
    case "copying": "Preparing an isolated profile copy"
    case "launching", "waiting": "Starting the temporary browser"
    case "capturing": "Capturing authenticated state"
    case "uploading": "Uploading fitted profile state"
    case "verifying": "Verifying the Browserless profile"
    case "complete": "Browserless profile uploaded"
    default: "Uploading authenticated state"
    }
    if let detail = event.detail { secondaryStatus = detail }
  }

  private func postSyncState() {
    NotificationCenter.default.post(
      name: .syncStateChanged,
      object: SyncMenuState(uploading: isBrowserlessTarget && isSyncing, canceling: uploadCanceling)
    )
  }

  private var formattedTime: String {
    scheduleTime.formatted(date: .omitted, time: .shortened)
  }

  private var requiredExtensionIDs: [String] {
    isDirectTarget || selectedTargetID == "browserless" || isGrokBotTarget ? [] : [selectedSourceID, selectedTargetID]
  }

  private struct GrokBotResultPayload: Decodable {
    let outputPath: String
    let prompt: String
  }

  private func parseGrokBotResult(from output: String) -> GrokBotResultPayload? {
    guard let line = output.split(separator: "\n").map(String.init).last(where: { $0.hasPrefix("BCB_GROK_RESULT ") }) else {
      return nil
    }
    let json = line.replacingOccurrences(of: "BCB_GROK_RESULT ", with: "")
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(GrokBotResultPayload.self, from: data)
  }

  private func presentGrokBotResultSheet(prompt: String, outputPath: String) {
    grokBotPrompt = prompt
    grokBotOutputPath = outputPath
    Self.copyGrokBotPromptToPasteboard(prompt)
    AppDiagnostics.log("grok-bot: prompt copied to pasteboard; posting presentGrokBotResult for \(outputPath)")
    let payload = GrokBotResultPresentation(prompt: prompt, outputPath: outputPath)
    NotificationCenter.default.post(name: .showMainWindow, object: nil)
    NotificationCenter.default.post(name: .presentGrokBotResult, object: payload)
  }

  static func copyGrokBotPromptToPasteboard(_ prompt: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(prompt, forType: .string)
  }

  private func updateEndpointRunningStatus() {
    let wasDirectTargetRunning = directTargetRunning
    codexRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == "com.openai.codex"
    }
    cursorRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == "com.todesktop.230313mzl4w4u92"
    }
    sourceBrowserRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == selectedBrowser.bundleIdentifier
    }
    guard !isSyncing else { return }
    refreshSourceCookieAccess()
    if !runtimeReady {
      state = .error
      primaryStatus = "Local sync runtime could not be refreshed"
      secondaryStatus = "Reopen the app or install the latest update before syncing"
    } else if selectedTargetID == "codex" && siteStorageEnabled && autoRestartBoth && (sourceBrowserRunning || codexRunning) {
      state = .ready
      primaryStatus = "Ready to sync and restart both apps"
      secondaryStatus = "Manual sync will force quit \(selectedBrowser.name) and Codex, then reopen only the apps that were running"
    } else if sourceSiteDataBlocked {
      state = .warning
      primaryStatus = "Quit \(selectedBrowser.name) before syncing"
      secondaryStatus = "Full site data uses live LevelDB files. Close the source browser completely so they can be copied safely"
    } else if cursorHasNoDataSelected {
      state = .warning
      primaryStatus = "Turn on Cookies to sync with Cursor"
      secondaryStatus = "Cursor import currently supports cookie sessions only"
    } else if selectedTargetID == "codex" && codexRunning && autoRestartCodex {
      if state == .ready || primaryStatus == "Quit Codex before syncing" {
        state = .ready
        primaryStatus = "Ready to sync and restart Codex"
        secondaryStatus = "Sync will force quit Codex and reopen it only after a successful transfer"
      }
    } else if isDirectTarget && directTargetRunning {
      state = .warning
      primaryStatus = "Quit \(targetName) before syncing"
      secondaryStatus = "Close \(targetName) completely so its local cookie database can be updated safely"
    } else if isDirectTarget && wasDirectTargetRunning && primaryStatus.hasPrefix("Quit ") {
      state = .ready
      primaryStatus = "Ready to sync directly"
      secondaryStatus = "\(targetName) is closed — a backup will be created before anything changes"
    } else if isGrokBotTarget {
      // This runs after every sync completion and again every 2 seconds from the status timer. Before 1.5.8 the
      // idle text below unconditionally replaced whatever the last Create transfer file attempt had reported, so a
      // failed export looked like nothing happened. Blocking conditions still win; results are kept otherwise.
      if grokBotHasNoDataSelected {
        showingOperationResult = false
        state = .warning
        primaryStatus = "Turn on Cookies to export for Grok Bot"
        secondaryStatus = "Grok Bot transfer files include cookie sessions only"
      } else if grokBotSourceAccessBlocked {
        showingOperationResult = false
        state = .warning
        primaryStatus = FullDiskAccess.statusTitle(browserName: selectedBrowser.name)
        secondaryStatus = FullDiskAccess.gateDetail(browserName: selectedBrowser.name)
      } else if !showingOperationResult {
        state = .ready
        primaryStatus = "Ready to create a Grok Bot transfer file"
        secondaryStatus = "Creates an encrypted .bcbx bundle with an embedded decryption key and bundled importer"
      }
    } else if isBrowserlessTarget {
      if selectedSourceID == "comet" {
        showingOperationResult = false
        state = .warning
        primaryStatus = "Comet capture is not supported"
        secondaryStatus = "Choose Brave, Chrome, Edge, Arc, Vivaldi, or Opera for Browserless"
      } else if !browserlessConfigured {
        showingOperationResult = false
        state = .warning
        primaryStatus = "Connect Browserless"
        secondaryStatus = "Your API token will be stored in macOS Keychain, never in the app configuration"
      } else if sourceBrowserRunning {
        showingOperationResult = false
        state = .warning
        primaryStatus = "Quit \(selectedBrowser.name) before uploading"
        secondaryStatus = "Browserless captures a temporary copy of the closed profile, including local storage and IndexedDB"
      } else if !showingOperationResult {
        state = .ready
        primaryStatus = "Ready for an explicit cloud upload"
        secondaryStatus = "Only this click sends authenticated state to Browserless \(browserlessRegion.uppercased())"
      }
    }
  }

  /// Runs from the 2-second status timer while Grok Bot is selected. The probe is a single open(2) on the
  /// cookie file (no SQLite, no child process), so it is cheap enough to poll and reflects a TCC change
  /// as soon as the relaunched app can read the file again.
  private func refreshSourceCookieAccess() {
    guard isGrokBotTarget else {
      sourceCookieAccessDenied = false
      cliReportedAccessDenied = false
      return
    }
    let denied = FullDiskAccess.isCookieStoreReadDenied(browserID: selectedSourceID)
    if denied != sourceCookieAccessDenied && !cliReportedAccessDenied {
      AppDiagnostics.log("full-disk-access: \(selectedBrowser.name) cookie store read \(denied ? "denied (EPERM/EACCES)" : "allowed")")
    }
    if !denied && cliReportedAccessDenied && FullDiskAccess.cookieDatabasePath(browserID: selectedSourceID, home: home) != nil {
      // The file is readable again from this process, so the earlier CLI denial is resolved.
      AppDiagnostics.log("full-disk-access: \(selectedBrowser.name) cookie store is readable again; clearing CLI-reported denial")
      cliReportedAccessDenied = false
    }
    sourceCookieAccessDenied = denied || cliReportedAccessDenied
  }

  private var currentVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
  }

  private func isVersion(_ candidate: String, newerThan installed: String) -> Bool {
    let lhs = candidate.split(separator: "-", maxSplits: 1)[0].split(separator: ".").map { Int($0) ?? 0 }
    let rhs = installed.split(separator: "-", maxSplits: 1)[0].split(separator: ".").map { Int($0) ?? 0 }
    for index in 0..<max(lhs.count, rhs.count) {
      let left = index < lhs.count ? lhs[index] : 0
      let right = index < rhs.count ? rhs[index] : 0
      if left != right { return left > right }
    }
    return false
  }

  private func consumeUpdateResultIfNeeded() {
    guard !didConsumeUpdateResult else { return }
    didConsumeUpdateResult = true
    let url = support.appending(path: "update-result.json")
    guard let data = try? Data(contentsOf: url),
          let result = try? JSONDecoder().decode(UpdateResult.self, from: data) else { return }
    try? FileManager.default.removeItem(at: url)
    if result.status == "success" {
      showResult(.success, "Updated to version \(result.version)", "Browser Cookie Bridge was installed and relaunched successfully")
    } else {
      showResult(.error, "Update \(result.version) failed", result.message ?? "The previous app has been reopened")
      postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .error)
    }
  }

  private func postUpdateState() {
    NotificationCenter.default.post(
      name: .updateStateChanged,
      object: UpdateMenuState(version: availableUpdateVersion, checking: isCheckingForUpdates, installing: isInstallingUpdate)
    )
  }

  private func postNativeAlert(
    title: String,
    message: String,
    kind: NativeAlert.Kind,
    secondaryButton: NativeAlert.SecondaryButton? = nil
  ) {
    NotificationCenter.default.post(
      name: .nativeAlert,
      object: NativeAlert(title: title, message: message, kind: kind, secondaryButton: secondaryButton)
    )
  }
}

private struct PackageRelease: Decodable {
  let version: String

  private enum CodingKeys: String, CodingKey {
    case tagName = "tag_name"
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let tag = try values.decode(String.self, forKey: .tagName)
    version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
  }
}

private struct UpdateResult: Decodable {
  let status: String
  let version: String
  let message: String?
}

private struct AppConfig: Decodable {
  let nodePath: String
  let schedule: Schedule
  let sourceBrowser: String?
  let targetBrowser: String?
  let imports: Imports?
  let rememberedImports: RememberedImports?
  let ui: UISettings?
  let browserless: BrowserlessSettings?
  let grokBot: GrokBotSettings?

  struct Schedule: Decodable {
    let hour: Int
    let minute: Int
  }

  struct Imports: Decodable {
    let cookies: Bool
    let history: Bool
    let siteStorage: Bool?
  }

  struct RememberedImports: Decodable {
    let history: Bool?
    let siteStorage: Bool?
  }

  struct UISettings: Decodable {
    let menuBar: Bool?
    let openAtLogin: Bool?
    let autoCheckUpdates: Bool?
    let autoRestartCodex: Bool?
    let autoRestartBoth: Bool?
  }

  struct BrowserlessSettings: Decodable {
    let profileName: String?
    let region: String?
    let onlyDomains: [String]?
  }

  struct GrokBotSettings: Decodable {
    let onlyDomains: [String]?
  }
}

private enum BrowserlessCredentialStore {
  private static let service = "com.apoorvdarshan.browser-cookie-bridge.browserless"
  private static let account = "api-token"

  static func save(_ token: String) throws {
    let identity: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let update: [String: Any] = [kSecValueData as String: Data(token.utf8)]
    let updateStatus = SecItemUpdate(identity as CFDictionary, update as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(updateStatus), userInfo: nil)
    }
    let item: [String: Any] = identity.merging([
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData as String: Data(token.utf8),
    ]) { _, new in new }
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
    }
  }

  static func read() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func delete() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}

private final class ProcessOutputCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var bytes = Data()
  private var pending = ""

  var text: String {
    lock.withLock { String(decoding: bytes, as: UTF8.self) }
  }

  func append(_ data: Data, finish: Bool = false) -> [String] {
    lock.withLock {
      bytes.append(data)
      pending += String(decoding: data, as: UTF8.self)
      var lines = pending.components(separatedBy: .newlines)
      if finish {
        pending = ""
        return lines.filter { !$0.isEmpty }
      }
      pending = lines.popLast() ?? ""
      return lines.filter { !$0.isEmpty }
    }
  }
}
