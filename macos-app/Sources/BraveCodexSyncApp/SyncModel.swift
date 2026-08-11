import AppKit
import Foundation

extension Notification.Name {
  static let menuBarVisibilityChanged = Notification.Name("BraveCodexSync.menuBarVisibilityChanged")
  static let nativeAlert = Notification.Name("BraveCodexSync.nativeAlert")
  static let updateStateChanged = Notification.Name("BraveCodexSync.updateStateChanged")
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

struct BrowserChoice: Identifiable, Hashable {
  let id: String
  let name: String
  let bundleIdentifier: String
  let applicationName: String
  let extensionURL: String
}

@MainActor
final class SyncModel: ObservableObject {
  enum State { case ready, syncing, success, warning, error }

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
  @Published var isCheckingForUpdates = false
  @Published var isInstallingUpdate = false
  @Published var availableUpdateVersion: String?
  @Published var scheduleTime = Date()
  @Published var extensionsReady = false
  @Published var cookiesEnabled = true
  @Published var historyEnabled = false
  @Published var selectedSourceID = "brave"
  @Published var selectedTargetID = "codex"
  @Published var codexRunning = false
  @Published var primaryStatus = "Ready to sync"
  @Published var secondaryStatus = "Choose what to move, then start a transfer"

  private let home = FileManager.default.homeDirectoryForCurrentUser
  private var support: URL { home.appending(path: "Library/Application Support/BraveCodexCookieSync") }
  private var runtimeCLI: URL { support.appending(path: "runtime/bin/brave-codex-cookie-sync.js") }
  private var launchAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.plist") }
  private var loginSyncAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.login-sync.plist") }
  private var appLoginAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.app-login.plist") }
  private var codexStatusTimer: Timer?
  private var updateTimer: Timer?
  private var didCheckAfterLaunch = false
  private var didConsumeUpdateResult = false

  var selectedBrowser: BrowserChoice {
    browsers.first(where: { $0.id == selectedSourceID }) ?? browsers[0]
  }

  var selectedTargetBrowser: BrowserChoice? {
    browsers.first(where: { $0.id == selectedTargetID })
  }

  var targetName: String { selectedTargetBrowser?.name ?? "ChatGPT Codex" }
  var codexBlocked: Bool { selectedTargetID == "codex" && codexRunning }
  var sourceIcon: NSImage { browserIcon(selectedBrowser) }
  var targetIcon: NSImage { selectedTargetBrowser.map(browserIcon) ?? codexIcon }
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
    bootstrapBundledRuntimeIfNeeded()
    let calendar = Calendar.current
    scheduleTime = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    updateCodexRunningStatus()
    codexStatusTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.updateCodexRunningStatus() }
    }
    updateTimer = Timer.scheduledTimer(withTimeInterval: 24 * 60 * 60, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.autoCheckUpdates else { return }
        self.checkForUpdates()
      }
    }
  }

  private func bootstrapBundledRuntimeIfNeeded() {
    guard let resources = Bundle.main.resourceURL else { return }
    let bundledRuntime = resources.appending(path: "runtime")
    let bundledNode = bundledRuntime.appending(path: "node/bin/node")
    let bundledCLI = bundledRuntime.appending(path: "bin/brave-codex-cookie-sync.js")
    guard FileManager.default.isExecutableFile(atPath: bundledNode.path),
          FileManager.default.fileExists(atPath: bundledCLI.path) else { return }

    if Bundle.main.bundlePath.hasPrefix("/Volumes/") {
      state = .warning
      primaryStatus = "Move the app to Applications"
      secondaryStatus = "Drag Browser Cookie Bridge onto Applications in the DMG window, then open it there"
      return
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
      guard process.terminationStatus != 0 else { return }
      let data = output.fileHandleForReading.readDataToEndOfFile()
      let message = String(decoding: data, as: UTF8.self)
        .split(separator: "\n")
        .map(String.init)
        .last(where: { !$0.isEmpty })
      state = .error
      primaryStatus = "Could not prepare the local runtime"
      secondaryStatus = message ?? "Move the app to Applications and reopen it"
    } catch {
      state = .error
      primaryStatus = "Could not prepare the local runtime"
      secondaryStatus = error.localizedDescription
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
      selectedTargetID = configuredTarget == "codex" || browsers.contains(where: { $0.id == configuredTarget })
        ? configuredTarget
        : "codex"
      if selectedTargetID == selectedSourceID { selectedTargetID = "codex" }
      cookiesEnabled = config.imports?.cookies ?? true
      historyEnabled = config.imports?.history ?? false
      menuBarEnabled = config.ui?.menuBar ?? true
      autoCheckUpdates = config.ui?.autoCheckUpdates ?? true
    }
    NotificationCenter.default.post(name: .menuBarVisibilityChanged, object: menuBarEnabled)
    extensionsReady = requiredExtensionIDs.allSatisfy {
      FileManager.default.fileExists(atPath: support.appending(path: "extension-\($0)/manifest.json").path)
    }
    updateCodexRunningStatus()
    consumeUpdateResultIfNeeded()
    if autoCheckUpdates && !didCheckAfterLaunch {
      didCheckAfterLaunch = true
      checkForUpdates()
    }
  }

  func selectSource(_ id: String) {
    guard browsers.contains(where: { $0.id == id }), id != selectedSourceID, id != selectedTargetID else { return }
    selectedSourceID = id
    persistPreferences(successMessage: "Export source changed to \(selectedBrowser.name)")
  }

  func selectTarget(_ id: String) {
    let validTarget = id == "codex" || browsers.contains(where: { $0.id == id })
    guard validTarget, id != selectedTargetID, id != selectedSourceID else { return }
    selectedTargetID = id
    persistPreferences(successMessage: "Import destination changed to \(targetName)")
    updateCodexRunningStatus()
  }

  func setCookiesEnabled(_ enabled: Bool) {
    cookiesEnabled = enabled
    persistPreferences(successMessage: enabled ? "Cookie import enabled" : "Cookie import disabled")
  }

  func setHistoryEnabled(_ enabled: Bool) {
    historyEnabled = enabled
    persistPreferences(successMessage: enabled ? "History URL import enabled" : "History import disabled")
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
      if showMenuBarAlert {
        postNativeAlert(title: "Sync already running", message: "Wait for the current transfer to finish.", kind: .information)
      }
      return
    }
    updateCodexRunningStatus()
    guard !codexBlocked else {
      if showMenuBarAlert {
        postNativeAlert(title: primaryStatus, message: secondaryStatus, kind: .warning)
      }
      return
    }
    isSyncing = true
    state = .syncing
    primaryStatus = "Transferring selected data"
    secondaryStatus = selectedTargetID == "codex"
      ? "Backing up Codex and merging \(selectedBrowser.name) locally…"
      : "Waiting for \(selectedBrowser.name) and \(targetName)…"
    runCLI(["sync", "--timeout", "300"]) { [weak self] success, output in
      guard let self else { return }
      self.isSyncing = false
      let partial = success && (output.contains("Partially synced:") || output.contains("with warnings"))
      if success {
        self.state = partial ? .warning : .success
        self.primaryStatus = self.selectedTargetID == "codex"
          ? (partial ? "Codex sync completed with warnings" : "Codex sessions updated")
          : (partial ? "Partially synced" : "Transfer complete")
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "\(self.selectedBrowser.name) and \(self.targetName) are up to date"
      } else {
        self.state = .error
        self.primaryStatus = "Sync did not finish"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? (self.selectedTargetID == "codex"
          ? "Quit Codex completely, then try again"
          : "Keep both browsers open and check the extensions")
      }
      self.updateCodexRunningStatus()
      if showMenuBarAlert {
        self.postNativeAlert(
          title: self.primaryStatus,
          message: self.secondaryStatus,
          kind: success ? (partial ? .warning : .information) : .error
        )
      }
    }
  }

  func setDailyEnabled(_ enabled: Bool) {
    dailyEnabled = enabled
    applySchedule(enabled)
  }

  func saveSchedule() {
    applySchedule(true)
  }

  func setLoginSyncEnabled(_ enabled: Bool) {
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
      "--menu-bar", menuBarEnabled ? "on" : "off",
      "--auto-check-updates", autoCheckUpdates ? "on" : "off"
    ]
    runCLI(arguments) { [weak self] success, output in
      guard let self else { return }
      self.isWorking = false
      if success {
        self.state = .ready
        self.primaryStatus = successMessage
        self.secondaryStatus = "This choice is saved for manual and daily syncs"
      } else {
        self.state = .error
        self.primaryStatus = "Could not save import settings"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Run install-app again from the CLI"
        self.refresh()
      }
      self.extensionsReady = self.requiredExtensionIDs.allSatisfy {
        FileManager.default.fileExists(atPath: self.support.appending(path: "extension-\($0)/manifest.json").path)
      }
      self.updateCodexRunningStatus()
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

  private func runCLI(_ arguments: [String], completion: @escaping @MainActor (Bool, String) -> Void) {
    guard let config = loadConfig() else {
      completion(false, "Configuration missing. Run install-app again.")
      return
    }
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: config.nodePath)
    process.arguments = [runtimeCLI.path] + arguments
    process.standardOutput = output
    process.standardError = output
    process.terminationHandler = { process in
      let data = output.fileHandleForReading.readDataToEndOfFile()
      let text = String(decoding: data, as: UTF8.self)
      Task { @MainActor in completion(process.terminationStatus == 0, text) }
    }
    do {
      try process.run()
    } catch {
      completion(false, error.localizedDescription)
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

  private var formattedTime: String {
    scheduleTime.formatted(date: .omitted, time: .shortened)
  }

  private var requiredExtensionIDs: [String] {
    selectedTargetID == "codex" ? [] : [selectedSourceID, selectedTargetID]
  }

  private func updateCodexRunningStatus() {
    let wasRunning = codexRunning
    codexRunning = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == "com.openai.codex"
    }
    guard selectedTargetID == "codex", !isSyncing else { return }
    if codexRunning {
      state = .warning
      primaryStatus = "Quit Codex before syncing"
      secondaryStatus = "Close ChatGPT Codex completely so its local cookie database can be updated safely"
    } else if wasRunning && primaryStatus == "Quit Codex before syncing" {
      state = .ready
      primaryStatus = "Ready to sync directly"
      secondaryStatus = "Codex is closed — a backup will be created before anything changes"
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

  struct Schedule: Decodable {
    let hour: Int
    let minute: Int
  }

  struct Imports: Decodable {
    let cookies: Bool
    let history: Bool
  }

  struct UISettings: Decodable {
    let menuBar: Bool?
    let openAtLogin: Bool?
    let autoCheckUpdates: Bool?
  }
}
