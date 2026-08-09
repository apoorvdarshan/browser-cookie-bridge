import AppKit
import Foundation
import ServiceManagement

@MainActor
final class SyncModel: ObservableObject {
  enum State { case ready, syncing, success, error }

  @Published var state: State = .ready
  @Published var isSyncing = false
  @Published var isWorking = false
  @Published var dailyEnabled = false
  @Published var openAtLogin = false
  @Published var scheduleTime = Date()
  @Published var extensionsReady = false
  @Published var primaryStatus = "Ready to sync"
  @Published var secondaryStatus = "Open Brave and Codex, then start a transfer"

  private let home = FileManager.default.homeDirectoryForCurrentUser
  private var support: URL { home.appending(path: "Library/Application Support/BraveCodexCookieSync") }
  private var runtimeCLI: URL { support.appending(path: "runtime/bin/brave-codex-cookie-sync.js") }
  private var launchAgent: URL { home.appending(path: "Library/LaunchAgents/com.apoorvdarshan.brave-codex-cookie-sync.plist") }

  init() {
    let calendar = Calendar.current
    scheduleTime = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
  }

  func refresh() {
    dailyEnabled = FileManager.default.fileExists(atPath: launchAgent.path)
    openAtLogin = SMAppService.mainApp.status == .enabled
    extensionsReady = ["brave", "codex"].allSatisfy {
      FileManager.default.fileExists(atPath: support.appending(path: "extension-\($0)/manifest.json").path)
    }
    if let config = loadConfig() {
      let calendar = Calendar.current
      scheduleTime = calendar.date(
        bySettingHour: config.schedule.hour,
        minute: config.schedule.minute,
        second: 0,
        of: Date()
      ) ?? scheduleTime
    }
  }

  func syncNow() {
    guard !isSyncing else { return }
    isSyncing = true
    state = .syncing
    primaryStatus = "Transferring cookies"
    secondaryStatus = "Waiting for both browser extensions…"
    runCLI(["sync", "--timeout", "300"]) { [weak self] success, output in
      guard let self else { return }
      self.isSyncing = false
      if success {
        self.state = .success
        self.primaryStatus = "Cookie sync complete"
        self.secondaryStatus = self.lastMeaningfulLine(output) ?? "Brave and Codex are up to date"
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
        if SMAppService.mainApp.status != .enabled {
          try SMAppService.mainApp.register()
        }
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

  func openBraveExtensions() {
    guard let url = URL(string: "brave://extensions") else { return }
    NSWorkspace.shared.open(url)
  }

  func revealExtension(_ role: String) {
    let folder = support.appending(path: "extension-\(role)")
    NSWorkspace.shared.activateFileViewerSelecting([folder])
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

  struct Schedule: Decodable {
    let hour: Int
    let minute: Int
  }
}
