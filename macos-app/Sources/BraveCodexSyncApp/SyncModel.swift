import AppKit
import Foundation
import ServiceManagement

struct BrowserChoice: Identifiable, Hashable {
  let id: String
  let name: String
  let bundleIdentifier: String
  let applicationName: String
  let extensionURL: String
}

@MainActor
final class SyncModel: ObservableObject {
  enum State { case ready, syncing, success, error }

  let browsers = [
    BrowserChoice(id: "brave", name: "Brave", bundleIdentifier: "com.brave.Browser", applicationName: "Brave Browser", extensionURL: "brave://extensions"),
    BrowserChoice(id: "chrome", name: "Chrome", bundleIdentifier: "com.google.Chrome", applicationName: "Google Chrome", extensionURL: "chrome://extensions"),
    BrowserChoice(id: "edge", name: "Edge", bundleIdentifier: "com.microsoft.edgemac", applicationName: "Microsoft Edge", extensionURL: "edge://extensions"),
    BrowserChoice(id: "arc", name: "Arc", bundleIdentifier: "company.thebrowser.Browser", applicationName: "Arc", extensionURL: "chrome://extensions"),
    BrowserChoice(id: "vivaldi", name: "Vivaldi", bundleIdentifier: "com.vivaldi.Vivaldi", applicationName: "Vivaldi", extensionURL: "vivaldi://extensions"),
    BrowserChoice(id: "opera", name: "Opera", bundleIdentifier: "com.operasoftware.Opera", applicationName: "Opera", extensionURL: "opera://extensions")
  ]

  @Published var state: State = .ready
  @Published var isSyncing = false
  @Published var isWorking = false
  @Published var dailyEnabled = false
  @Published var openAtLogin = false
  @Published var scheduleTime = Date()
  @Published var extensionsReady = false
  @Published var cookiesEnabled = true
  @Published var historyEnabled = false
  @Published var selectedSourceID = "brave"
  @Published var primaryStatus = "Ready to sync"
  @Published var secondaryStatus = "Choose what to import, then start a transfer"

  private let home = FileManager.default.homeDirectoryForCurrentUser
  private var support: URL { home.appending(path: "Library/Application Support/BraveCodexCookieSync") }
  private var runtimeCLI: URL { support.appending(path: "runtime/bin/brave-codex-cookie-sync.js") }
  private var launchAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.plist") }

  var selectedBrowser: BrowserChoice {
    browsers.first(where: { $0.id == selectedSourceID }) ?? browsers[0]
  }

  var sourceIcon: NSImage { appIcon(bundleIdentifier: selectedBrowser.bundleIdentifier, fallbackSymbol: "globe") }
  var codexIcon: NSImage { appIcon(bundleIdentifier: "com.openai.codex", fallbackSymbol: "sparkles") }

  func browserIcon(_ browser: BrowserChoice) -> NSImage {
    appIcon(bundleIdentifier: browser.bundleIdentifier, fallbackSymbol: "globe")
  }

  init() {
    let calendar = Calendar.current
    scheduleTime = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
  }

  func refresh() {
    dailyEnabled = FileManager.default.fileExists(atPath: launchAgent.path)
    openAtLogin = SMAppService.mainApp.status == .enabled
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
      cookiesEnabled = config.imports?.cookies ?? true
      historyEnabled = config.imports?.history ?? false
    }
    extensionsReady = [selectedSourceID, "codex"].allSatisfy {
      FileManager.default.fileExists(atPath: support.appending(path: "extension-\($0)/manifest.json").path)
    }
  }

  func selectSource(_ id: String) {
    guard browsers.contains(where: { $0.id == id }), id != selectedSourceID else { return }
    selectedSourceID = id
    persistPreferences(successMessage: "Source changed to \(selectedBrowser.name)")
  }

  func setCookiesEnabled(_ enabled: Bool) {
    cookiesEnabled = enabled
    persistPreferences(successMessage: enabled ? "Cookie import enabled" : "Cookie import disabled")
  }

  func setHistoryEnabled(_ enabled: Bool) {
    historyEnabled = enabled
    persistPreferences(successMessage: enabled ? "History URL import enabled" : "History import disabled")
  }

  func syncNow() {
    guard !isSyncing else { return }
    isSyncing = true
    state = .syncing
    primaryStatus = "Transferring selected data"
    secondaryStatus = "Waiting for \(selectedBrowser.name) and Codex extensions…"
    runCLI(["sync", "--timeout", "300"]) { [weak self] success, output in
      guard let self else { return }
      self.isSyncing = false
      if success {
        self.state = .success
        self.primaryStatus = "Browser sync complete"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "\(self.selectedBrowser.name) and Codex are up to date"
      } else {
        self.state = .error
        self.primaryStatus = "Sync did not finish"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Keep both apps open and check the extensions"
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

  func setOpenAtLogin(_ enabled: Bool) {
    isWorking = true
    do {
      if enabled {
        if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
      } else if SMAppService.mainApp.status != .notRegistered {
        try SMAppService.mainApp.unregister()
      }
      openAtLogin = SMAppService.mainApp.status == .enabled
      state = .ready
      primaryStatus = openAtLogin ? "Opens at login" : "Login launch disabled"
      secondaryStatus = openAtLogin ? "Closing the window leaves the menu-bar helper running" : "Open the app manually when you need it"
    } catch {
      openAtLogin = SMAppService.mainApp.status == .enabled
      state = .error
      primaryStatus = "Could not update Login Items"
      secondaryStatus = error.localizedDescription
    }
    isWorking = false
  }

  func openSourceExtensions() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", selectedBrowser.applicationName, selectedBrowser.extensionURL]
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
      "--cookies", cookiesEnabled ? "on" : "off",
      "--history", historyEnabled ? "on" : "off"
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
      self.extensionsReady = [self.selectedSourceID, "codex"].allSatisfy {
        FileManager.default.fileExists(atPath: self.support.appending(path: "extension-\($0)/manifest.json").path)
      }
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

  private func loadConfig() -> AppConfig? {
    let url = support.appending(path: "config.json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(AppConfig.self, from: data)
  }

  private func lastMeaningfulLine(_ output: String) -> String? {
    output.split(separator: "\n").map(String.init).last(where: { !$0.isEmpty })
  }

  private var formattedTime: String {
    scheduleTime.formatted(date: .omitted, time: .shortened)
  }
}

private struct AppConfig: Decodable {
  let nodePath: String
  let schedule: Schedule
  let sourceBrowser: String?
  let imports: Imports?

  struct Schedule: Decodable {
    let hour: Int
    let minute: Int
  }

  struct Imports: Decodable {
    let cookies: Bool
    let history: Bool
  }
}
