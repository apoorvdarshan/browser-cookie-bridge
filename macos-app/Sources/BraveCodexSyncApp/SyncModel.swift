import AppKit
import Foundation
import Security

extension Notification.Name {
  static let menuBarVisibilityChanged = Notification.Name("BraveCodexSync.menuBarVisibilityChanged")
  static let nativeAlert = Notification.Name("BraveCodexSync.nativeAlert")
  static let updateStateChanged = Notification.Name("BraveCodexSync.updateStateChanged")
  static let syncStateChanged = Notification.Name("BraveCodexSync.syncStateChanged")
}

struct NativeAlert {
  enum Kind { case information, warning, error }
  let title: String
  let message: String
  let kind: Kind
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
  @Published var sourceBrowserRunning = false
  @Published var browserlessConfigured = false
  @Published var browserlessProfileName = "browser-cookie-bridge"
  @Published var browserlessRegion = "sfo"
  @Published var browserlessOnlyDomains = ""
  @Published var showingBrowserlessSetup = false
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
  private var didCheckAfterLaunch = false
  private var didConsumeUpdateResult = false
  private var assessedBrowserID: String?
  private var activeSyncProcess: Process?
  private var uploadTimer: Timer?
  private var uploadStartedAt: Date?
  private var runtimeReady = true

  var selectedBrowser: BrowserChoice {
    browsers.first(where: { $0.id == selectedSourceID }) ?? browsers[0]
  }

  var selectedTargetBrowser: BrowserChoice? {
    browsers.first(where: { $0.id == selectedTargetID })
  }

  var isBrowserlessTarget: Bool { selectedTargetID == "browserless" }
  var targetName: String {
    isBrowserlessTarget ? "Browserless Cloud" : selectedTargetBrowser?.name ?? "ChatGPT Codex"
  }
  var codexBlocked: Bool {
    selectedTargetID == "codex" && codexRunning && !autoRestartCodex && !(siteStorageEnabled && autoRestartBoth)
  }
  var sourceSiteDataBlocked: Bool {
    selectedTargetID == "codex" && siteStorageEnabled && sourceBrowserRunning && !autoRestartBoth
  }
  var browserlessBlocked: Bool {
    isBrowserlessTarget && (!browserlessConfigured || sourceBrowserRunning || selectedSourceID == "comet")
  }
  var syncBlocked: Bool { !runtimeReady || codexBlocked || sourceSiteDataBlocked || browserlessBlocked }
  var formattedUploadElapsed: String {
    let minutes = uploadElapsedSeconds / 60
    let seconds = uploadElapsedSeconds % 60
    return String(format: "%d:%02d", minutes, seconds)
  }
  var sourceIcon: NSImage { browserIcon(selectedBrowser) }
  var targetIcon: NSImage {
    isBrowserlessTarget ? browserlessIcon : selectedTargetBrowser.map(browserIcon) ?? codexIcon
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
      selectedTargetID = configuredTarget == "codex" || configuredTarget == "browserless" || browsers.contains(where: { $0.id == configuredTarget })
        ? configuredTarget
        : "codex"
      if selectedTargetID == selectedSourceID { selectedTargetID = "codex" }
      cookiesEnabled = config.imports?.cookies ?? true
      historyEnabled = config.imports?.history ?? false
      siteStorageEnabled = config.imports?.siteStorage ?? false
      menuBarEnabled = config.ui?.menuBar ?? true
      autoCheckUpdates = config.ui?.autoCheckUpdates ?? true
      autoRestartCodex = config.ui?.autoRestartCodex ?? false
      autoRestartBoth = config.ui?.autoRestartBoth ?? false
      browserlessProfileName = config.browserless?.profileName ?? "browser-cookie-bridge"
      browserlessRegion = config.browserless?.region ?? "sfo"
      browserlessOnlyDomains = (config.browserless?.onlyDomains ?? []).joined(separator: ", ")
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
    let validTarget = id == "codex" || id == "browserless" || browsers.contains(where: { $0.id == id })
    guard validTarget, id != selectedTargetID, id != selectedSourceID else { return }
    selectedTargetID = id
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
    historyEnabled = enabled
    persistPreferences(successMessage: enabled ? "History URL import enabled" : "History import disabled")
  }

  func setSiteStorageEnabled(_ enabled: Bool) {
    siteStorageEnabled = enabled
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
    guard let url = URL(string: "https://api.github.com/repos/aopv/browser-cookie-bridge/releases/latest") else { return }
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
          if !self.codexBlocked && !self.isSyncing {
            self.state = .ready
            self.primaryStatus = "Update \(release.version) available"
            self.secondaryStatus = "Install it now; the app will relaunch automatically"
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
        postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .warning)
      }
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

  private func startSync(showMenuBarAlert: Bool, reopenCodexOnSuccess: Bool, reopenSourceOnSuccess: Bool = false) {
    isSyncing = true
    uploadCanceling = false
    state = .syncing
    primaryStatus = isBrowserlessTarget ? "Uploading authenticated state" : "Transferring selected data"
    secondaryStatus = selectedTargetID == "codex"
      ? "Backing up Codex and merging \(selectedBrowser.name) locally…"
      : isBrowserlessTarget
        ? "Sending \(selectedBrowser.name) to Browserless \(browserlessRegion.uppercased()) only for this request…"
        : "Waiting for \(selectedBrowser.name) and \(targetName)…"
    var environment: [String: String] = [:]
    var arguments = ["sync", "--timeout", isBrowserlessTarget ? "900" : "300"]
    if isBrowserlessTarget {
      guard let token = BrowserlessCredentialStore.read() else {
        isSyncing = false
        browserlessConfigured = false
        updateEndpointRunningStatus()
        return
      }
      environment["BROWSERLESS_TOKEN"] = token
      arguments.append("--allow-cloud-upload")
      beginUploadTracking()
    }
    activeSyncProcess = runCLI(arguments, environment: environment, onLine: { [weak self] line in
      self?.handleBrowserlessProgress(line)
    }) { [weak self] success, output in
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
      let canceled = output.contains("Browserless upload canceled") || output.contains("Temporary profile data was removed")
      if canceled {
        self.state = .canceled
        self.primaryStatus = "Browserless upload canceled"
        self.secondaryStatus = "No cloud profile was changed; temporary profile data was removed"
      } else if success {
        self.state = partial ? .warning : .success
        self.primaryStatus = self.isBrowserlessTarget
          ? (partial ? "Browserless profile uploaded with omissions" : "Browserless profile uploaded")
          : self.selectedTargetID == "codex"
          ? (partial ? "Codex sync completed with warnings" : "Codex sessions updated")
          : (partial ? "Partially synced" : "Transfer complete")
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "\(self.selectedBrowser.name) and \(self.targetName) are up to date"
      } else {
        self.state = .error
        self.primaryStatus = "Sync did not finish"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? (self.selectedTargetID == "codex"
          ? "Quit Codex completely, then try again"
          : self.isBrowserlessTarget
            ? "Check the API token, close the source browser, and try again"
          : "Keep both browsers open and check the extensions")
      }
      self.updateEndpointRunningStatus()
      if success && (reopenCodexOnSuccess || reopenSourceOnSuccess) {
        self.reopenApplicationsAfterSuccessfulSync(
          partial: partial,
          syncSummary: self.secondaryStatus,
          reopenCodex: reopenCodexOnSuccess,
          reopenSource: reopenSourceOnSuccess,
          showMenuBarAlert: showMenuBarAlert
        )
      } else if showMenuBarAlert {
        self.postNativeAlert(
          title: self.primaryStatus,
          message: self.secondaryStatus,
          kind: canceled ? .information : success ? (partial ? .warning : .information) : .error
        )
      }
    }
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
        self.state = .ready
        self.primaryStatus = enabled ? "Sync at login enabled" : "Sync at login disabled"
        self.secondaryStatus = enabled
          ? "A sync starts now and whenever you sign in"
          : "The fixed daily schedule is unchanged"
      } else {
        self.loginSyncEnabled.toggle()
        self.state = .error
        self.primaryStatus = "Could not update login sync"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI"
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
        self.state = .ready
        self.primaryStatus = enabled ? "Opens at login" : "Login launch disabled"
        self.secondaryStatus = enabled ? "The app starts automatically after sign-in" : "Open the app manually when you need it"
      } else {
        self.openAtLogin.toggle()
        self.state = .error
        self.primaryStatus = "Could not update login launch"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI"
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
    ]
    runCLI(arguments) { [weak self] success, output in
      guard let self else { return }
      self.isWorking = false
      if success {
        self.state = .ready
        self.primaryStatus = successMessage
        self.secondaryStatus = self.isBrowserlessTarget
          ? "Cloud uploads run only after you click Upload"
          : "This choice is saved for manual and daily syncs"
      } else {
        self.state = .error
        self.primaryStatus = "Could not save import settings"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI"
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
        self.state = .ready
        self.primaryStatus = enabled ? "Daily sync enabled" : "Daily sync disabled"
        self.secondaryStatus = enabled ? "Scheduled for \(self.formattedTime)" : "Use Sync now whenever you need it"
      } else {
        self.dailyEnabled.toggle()
        self.state = .error
        self.primaryStatus = "Could not update schedule"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Run setup again from the CLI"
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
    guard let config = loadConfig() else {
      completion(false, "Configuration missing. Run install-app again.")
      return nil
    }
    let process = Process()
    let output = Pipe()
    let collector = ProcessOutputCollector()
    process.executableURL = URL(fileURLWithPath: config.nodePath)
    process.arguments = [runtimeCLI.path] + arguments
    process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      let lines = collector.append(data)
      guard let onLine, !lines.isEmpty else { return }
      Task { @MainActor in lines.forEach(onLine) }
    }
    process.terminationHandler = { process in
      output.fileHandleForReading.readabilityHandler = nil
      let remainder = output.fileHandleForReading.readDataToEndOfFile()
      let lines = collector.append(remainder, finish: true)
      let text = collector.text
      Task { @MainActor in
        if let onLine { lines.forEach(onLine) }
        completion(process.terminationStatus == 0, text)
      }
    }
    do {
      try process.run()
      return process
    } catch {
      completion(false, error.localizedDescription)
      return nil
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
    guard let line = output.split(separator: "\n").map(String.init).last(where: { !$0.isEmpty }) else { return nil }
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
    selectedTargetID == "codex" || selectedTargetID == "browserless" ? [] : [selectedSourceID, selectedTargetID]
  }

  private func updateEndpointRunningStatus() {
    let wasRunning = codexRunning
    codexRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == "com.openai.codex"
    }
    sourceBrowserRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == selectedBrowser.bundleIdentifier
    }
    guard !isSyncing else { return }
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
    } else if selectedTargetID == "codex" && codexRunning && autoRestartCodex {
      if state == .ready || primaryStatus == "Quit Codex before syncing" {
        state = .ready
        primaryStatus = "Ready to sync and restart Codex"
        secondaryStatus = "Sync will force quit Codex and reopen it only after a successful transfer"
      }
    } else if selectedTargetID == "codex" && codexRunning {
      state = .warning
      primaryStatus = "Quit Codex before syncing"
      secondaryStatus = "Close ChatGPT Codex completely so its local cookie database can be updated safely"
    } else if selectedTargetID == "codex" && wasRunning && primaryStatus == "Quit Codex before syncing" {
      state = .ready
      primaryStatus = "Ready to sync directly"
      secondaryStatus = "Codex is closed — a backup will be created before anything changes"
    } else if isBrowserlessTarget {
      if selectedSourceID == "comet" {
        state = .warning
        primaryStatus = "Comet capture is not supported"
        secondaryStatus = "Choose Brave, Chrome, Edge, Arc, Vivaldi, or Opera for Browserless"
      } else if !browserlessConfigured {
        state = .warning
        primaryStatus = "Connect Browserless"
        secondaryStatus = "Your API token will be stored in macOS Keychain, never in the app configuration"
      } else if sourceBrowserRunning {
        state = .warning
        primaryStatus = "Quit \(selectedBrowser.name) before uploading"
        secondaryStatus = "Browserless captures a temporary copy of the closed profile, including local storage and IndexedDB"
      } else {
        state = .ready
        primaryStatus = "Ready for an explicit cloud upload"
        secondaryStatus = "Only this click sends authenticated state to Browserless \(browserlessRegion.uppercased())"
      }
    }
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
      state = .success
      primaryStatus = "Updated to version \(result.version)"
      secondaryStatus = "Browser Cookie Bridge was installed and relaunched successfully"
    } else {
      state = .error
      primaryStatus = "Update \(result.version) failed"
      secondaryStatus = result.message ?? "The previous app has been reopened"
      postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .error)
    }
  }

  private func postUpdateState() {
    NotificationCenter.default.post(
      name: .updateStateChanged,
      object: UpdateMenuState(version: availableUpdateVersion, checking: isCheckingForUpdates, installing: isInstallingUpdate)
    )
  }

  private func postNativeAlert(title: String, message: String, kind: NativeAlert.Kind) {
    NotificationCenter.default.post(
      name: .nativeAlert,
      object: NativeAlert(title: title, message: message, kind: kind)
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
  let ui: UISettings?
  let browserless: BrowserlessSettings?

  struct Schedule: Decodable {
    let hour: Int
    let minute: Int
  }

  struct Imports: Decodable {
    let cookies: Bool
    let history: Bool
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
