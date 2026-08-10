import AppKit
import SwiftUI

private enum ProjectLinks {
  static let repository = URL(string: "https://github.com/apoorvdarshan/browser-cookie-bridge")!
  static let issues = URL(string: "https://github.com/apoorvdarshan/browser-cookie-bridge/issues/new?template=bug_report.yml")!
  static let license = URL(string: "https://github.com/apoorvdarshan/browser-cookie-bridge/blob/main/LICENSE")!
  static let koFi = URL(string: "https://ko-fi.com/apoorvdarshan")!
  static let x = URL(string: "https://x.com/apoorvdarshan")!
  static let productHunt = URL(string: "https://www.producthunt.com/products/browser-cookie-bridge")!
}

@main
struct BraveCodexSyncApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var model = SyncModel()

  var body: some Scene {
    Window("Browser Cookie Bridge", id: "main") {
      ContentView(appDelegate: appDelegate)
        .environmentObject(model)
        .frame(width: 644, height: 730)
        .background(AppBackground())
    }
    .windowResizability(.contentSize)
    .commands { CommandGroup(replacing: .newItem) {} }

  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  weak var model: SyncModel?
  private weak var mainWindow: NSWindow?
  private var statusItem: NSStatusItem?
  private var updateMenuItem: NSMenuItem?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(menuBarVisibilityChanged(_:)),
      name: .menuBarVisibilityChanged,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(showNativeAlert(_:)),
      name: .nativeAlert,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(updateStateChanged(_:)),
      name: .updateStateChanged,
      object: nil
    )
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { showMainWindow() }
    return true
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    NSApp.setActivationPolicy(.accessory)
    return false
  }

  func attach(model: SyncModel) {
    self.model = model
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let candidate = NSApp.windows.first(where: { $0.canBecomeMain }) ?? NSApp.windows.first
      self.mainWindow = candidate
      candidate?.delegate = self
    }
  }

  func updateMenuBar(enabled: Bool) {
    if enabled {
      guard statusItem == nil else { return }
      let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
      let cookieIcon = Bundle.main.url(forResource: "MenuBarCookieTemplate", withExtension: "png")
        .flatMap(NSImage.init(contentsOf:))
      cookieIcon?.size = NSSize(width: 18, height: 18)
      cookieIcon?.isTemplate = true
      cookieIcon?.accessibilityDescription = "Browser Cookie Bridge"
      item.button?.image = cookieIcon
      item.button?.imageScaling = .scaleProportionallyDown
      let menu = NSMenu()
      menu.addItem(withTitle: "Show Browser Cookie Bridge", action: #selector(showMainWindowAction), keyEquivalent: "")
      menu.addItem(withTitle: "Sync now", action: #selector(syncNowAction), keyEquivalent: "")
      let updateItem = menu.addItem(withTitle: "Check for Updates…", action: #selector(updateAction), keyEquivalent: "")
      updateMenuItem = updateItem
      addProjectLinks(to: menu)
      menu.addItem(.separator())
      menu.addItem(withTitle: "Quit", action: #selector(quitAction), keyEquivalent: "q")
      for menuItem in menu.items { menuItem.target = self }
      item.menu = menu
      statusItem = item
    } else if let statusItem {
      NSStatusBar.system.removeStatusItem(statusItem)
      self.statusItem = nil
      updateMenuItem = nil
    }
  }

  @objc private func menuBarVisibilityChanged(_ notification: Notification) {
    guard let enabled = notification.object as? Bool else { return }
    updateMenuBar(enabled: enabled)
  }

  @objc private func showMainWindowAction() { showMainWindow() }
  @objc private func syncNowAction() { model?.syncNow(showMenuBarAlert: true) }
  @objc private func updateAction() {
    if model?.availableUpdateVersion != nil { model?.installAvailableUpdate() }
    else { model?.checkForUpdates(showAlert: true) }
  }
  @objc private func quitAction() { NSApp.terminate(nil) }

  @objc private func openProjectLink(_ sender: NSMenuItem) {
    guard let address = sender.representedObject as? String,
          let url = URL(string: address) else { return }
    NSWorkspace.shared.open(url)
  }

  @objc private func showNativeAlert(_ notification: Notification) {
    guard let payload = notification.object as? NativeAlert else { return }
    let alert = NSAlert()
    alert.messageText = payload.title
    alert.informativeText = payload.message
    alert.alertStyle = switch payload.kind {
    case .information: .informational
    case .warning: .warning
    case .error: .critical
    }
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }

  @objc private func updateStateChanged(_ notification: Notification) {
    guard let payload = notification.object as? UpdateMenuState else { return }
    if payload.installing {
      updateMenuItem?.title = "Installing Update…"
      updateMenuItem?.isEnabled = false
    } else if payload.checking {
      updateMenuItem?.title = "Checking for Updates…"
      updateMenuItem?.isEnabled = false
    } else if let version = payload.version {
      updateMenuItem?.title = "Install Update \(version)…"
      updateMenuItem?.isEnabled = true
    } else {
      updateMenuItem?.title = "Check for Updates…"
      updateMenuItem?.isEnabled = true
    }
  }

  private func showMainWindow() {
    NSApp.setActivationPolicy(.regular)
    mainWindow?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func addProjectLinks(to menu: NSMenu) {
    menu.addItem(.separator())
    addLink("Open-source repository", url: ProjectLinks.repository, to: menu)
    addLink("Report a bug…", url: ProjectLinks.issues, to: menu)
    addLink("MIT license", url: ProjectLinks.license, to: menu)
    menu.addItem(.separator())
    addLink("Support on Ko-fi", url: ProjectLinks.koFi, to: menu)
    addLink("Follow @apoorvdarshan on X", url: ProjectLinks.x, to: menu)
    addLink("View on Product Hunt", url: ProjectLinks.productHunt, to: menu)
  }

  private func addLink(_ title: String, url: URL, to menu: NSMenu) {
    let item = menu.addItem(withTitle: title, action: #selector(openProjectLink(_:)), keyEquivalent: "")
    item.target = self
    item.representedObject = url.absoluteString
  }
}

struct ContentView: View {
  @EnvironmentObject private var model: SyncModel
  @State private var showingSetup = false
  let appDelegate: AppDelegate

  var body: some View {
    VStack(spacing: 12) {
      header
      ScrollView {
        VStack(spacing: 12) {
          SyncPanel()
          PreferencesPanel()
        }
        .padding(.trailing, 2)
      }
      footer
    }
    .padding(18)
    .onAppear {
      appDelegate.attach(model: model)
      model.refresh()
      appDelegate.updateMenuBar(enabled: model.menuBarEnabled)
    }
    .sheet(isPresented: $showingSetup) {
      ExtensionSetupSheet().environmentObject(model)
    }
  }

  private var header: some View {
    HStack(spacing: 11) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .scaledToFill()
        .frame(width: 43, height: 43)
        .frame(width: 36, height: 36)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 1) {
        Text("Browser Cookie Bridge")
          .font(.system(size: 19, weight: .bold, design: .rounded))
        Text("Local cookie and session transfer")
          .font(.system(size: 11.5, weight: .medium))
          .foregroundStyle(.secondary)
      }
      Spacer()
      StatusIndicator(state: model.state)
    }
    .padding(.horizontal, 2)
  }

  private var footer: some View {
    HStack(spacing: 10) {
      Label("Data stays on this Mac", systemImage: "lock.shield.fill")
        .foregroundStyle(.secondary)
      Spacer()
      if let version = model.availableUpdateVersion {
        Button(model.isInstallingUpdate ? "Installing…" : "Install \(version)") {
          model.installAvailableUpdate()
        }
        .controlSize(.small)
        .disabled(model.isInstallingUpdate)
      } else {
        Button(model.isCheckingForUpdates ? "Checking…" : "Check for updates…") {
          model.checkForUpdates(showAlert: true)
        }
        .controlSize(.small)
        .disabled(model.isCheckingForUpdates || model.isInstallingUpdate)
      }
      Button {
        model.refresh()
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .help("Refresh status")
      if model.selectedTargetID != "codex" {
        Button("Extension setup…") { showingSetup = true }
          .controlSize(.small)
      }
    }
    .font(.system(size: 10.5, weight: .medium))
    .padding(.horizontal, 3)
  }
}

struct SyncPanel: View {
  @EnvironmentObject private var model: SyncModel

  var body: some View {
    Surface {
      VStack(spacing: 14) {
        HStack(spacing: 12) {
          SourcePicker()
          RelayPath(active: model.isSyncing)
          TargetPicker()
        }
        Divider().opacity(0.65)
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text(model.primaryStatus)
              .font(.system(size: 13, weight: .semibold))
            Text(model.secondaryStatus)
              .font(.system(size: 10.5))
              .foregroundStyle(.secondary)
              .lineLimit(2)
              .help(model.secondaryStatus)
          }
          Spacer()
          Button { model.syncNow() } label: {
            HStack(spacing: 7) {
              if model.isSyncing { ProgressView().controlSize(.small) }
              else { Image(systemName: model.codexBlocked ? "xmark.circle.fill" : "arrow.triangle.2.circlepath") }
              Text(model.isSyncing ? "Syncing…" : (model.codexBlocked ? "Close Codex first" : "Sync now"))
            }
            .frame(minWidth: model.codexBlocked ? 116 : 92)
          }
          .buttonStyle(.borderedProminent)
          .tint(Theme.accent)
          .disabled(model.isSyncing || model.codexBlocked)
          .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(model.codexBlocked ? 7 : 0)
        .background(
          model.codexBlocked ? Theme.active.opacity(0.10) : Color.clear,
          in: RoundedRectangle(cornerRadius: 9, style: .continuous)
        )
        .overlay {
          if model.codexBlocked {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .stroke(Theme.active.opacity(0.38), lineWidth: 1)
          }
        }
      }
    }
  }

}

struct SourcePicker: View {
  @EnvironmentObject private var model: SyncModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("EXPORT FROM")
          .tracking(0.65)
          .foregroundStyle(.tertiary)
        Spacer()
        Text(model.selectedBrowser.name)
          .foregroundStyle(Theme.accent)
      }
      .font(.system(size: 8, weight: .bold))
      VStack(spacing: 5) {
        HStack(spacing: 5) {
          ForEach(Array(model.browsers.prefix(4))) { browser in sourceButton(browser) }
        }
        HStack(spacing: 5) {
          ForEach(Array(model.browsers.dropFirst(4))) { browser in sourceButton(browser) }
        }
      }
    }
    .frame(width: 175)
  }

  private func sourceButton(_ browser: BrowserChoice) -> some View {
    EndpointButton(
      icon: model.browserIcon(browser),
      name: browser.name,
      selected: model.selectedSourceID == browser.id,
      disabled: model.isWorking || model.isSyncing || model.selectedTargetID == browser.id
    ) { model.selectSource(browser.id) }
  }
}

struct TargetPicker: View {
  @EnvironmentObject private var model: SyncModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("IMPORT INTO")
          .tracking(0.65)
          .foregroundStyle(.tertiary)
        Spacer()
        Text(model.targetName)
          .foregroundStyle(Theme.accent)
      }
      .font(.system(size: 8, weight: .bold))
      VStack(spacing: 5) {
        HStack(spacing: 5) {
          ForEach(Array(model.browsers.prefix(4))) { browser in targetButton(browser) }
          Color.clear.frame(width: 19, height: 40)
        }
        HStack(spacing: 5) {
          ForEach(Array(model.browsers.dropFirst(4))) { browser in targetButton(browser) }
          EndpointButton(
            icon: model.codexIcon,
            name: "ChatGPT Codex",
            selected: model.selectedTargetID == "codex",
            disabled: model.isWorking || model.isSyncing,
            buttonWidth: 64,
            iconWidth: 66,
            iconHeight: 38
          ) { model.selectTarget("codex") }
        }
      }
    }
    .frame(width: 199)
  }

  private func targetButton(_ browser: BrowserChoice) -> some View {
    EndpointButton(
      icon: model.browserIcon(browser),
      name: browser.name,
      selected: model.selectedTargetID == browser.id,
      disabled: model.isWorking || model.isSyncing || model.selectedSourceID == browser.id
    ) { model.selectTarget(browser.id) }
  }
}

struct EndpointButton: View {
  let icon: NSImage
  let name: String
  let selected: Bool
  let disabled: Bool
  var buttonWidth: CGFloat = 40
  var iconWidth: CGFloat = 31
  var iconHeight: CGFloat = 31
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(nsImage: icon)
        .resizable()
        .scaledToFit()
        .frame(width: iconWidth, height: iconHeight)
        .frame(width: buttonWidth, height: 40)
        .background(
          selected ? Theme.accent.opacity(0.13) : Color.primary.opacity(0.025),
          in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(selected ? Theme.accent.opacity(0.85) : Color.primary.opacity(0.07), lineWidth: selected ? 1.25 : 1)
        )
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled && !selected ? 0.52 : 1)
    .help(disabled && !selected ? "Already selected on the other side" : name)
    .accessibilityLabel(name)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

struct PreferencesPanel: View {
  @EnvironmentObject private var model: SyncModel

  var body: some View {
    Surface(padding: 0) {
      VStack(spacing: 0) {
        SectionLabel(title: "Sync data", detail: "Saved automatically")
        PreferenceRow(icon: "network", color: Theme.accent, title: "Cookies", detail: "Site sessions and sign-ins") {
          Toggle("", isOn: Binding(get: { model.cookiesEnabled }, set: { model.setCookiesEnabled($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
        }
        RowDivider()
        PreferenceRow(icon: "clock.arrow.circlepath", color: Theme.accent, title: "History URLs", detail: "Original visit times are not preserved") {
          Toggle("", isOn: Binding(get: { model.historyEnabled }, set: { model.setHistoryEnabled($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
        }
        RowDivider()
        PreferenceRow(icon: "key.slash", color: .secondary, title: "Passwords", detail: "Browser extensions cannot access passwords", muted: true) {
          Text("Unavailable")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Color.secondary.opacity(0.08), in: Capsule())
        }

        SectionLabel(title: "Automation", detail: "Runs in the background", separated: true)
        PreferenceRow(icon: "clock.badge.checkmark", color: Theme.accent, title: "Daily sync", detail: model.dailyEnabled ? "At the selected local time" : "Off") {
          HStack(spacing: 8) {
            DatePicker("", selection: $model.scheduleTime, displayedComponents: .hourAndMinute)
              .labelsHidden()
              .datePickerStyle(.field)
              .controlSize(.regular)
              .disabled(!model.dailyEnabled || model.isWorking)
              .frame(width: 112, alignment: .center)
              .onChange(of: model.scheduleTime) { _ in
                if model.dailyEnabled && !model.isWorking { model.saveSchedule() }
              }
            Toggle("", isOn: Binding(get: { model.dailyEnabled }, set: { model.setDailyEnabled($0) }))
              .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
          }
        }
        RowDivider()
        PreferenceRow(icon: "sunrise.fill", color: Theme.accent, title: "Sync at login", detail: model.loginSyncEnabled ? "Once whenever you sign in" : "Off") {
          Toggle("", isOn: Binding(get: { model.loginSyncEnabled }, set: { model.setLoginSyncEnabled($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
        }
        RowDivider()
        PreferenceRow(icon: "power", color: Theme.accent, title: "Open at login", detail: "Start the app after you sign in") {
          Toggle("", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
        }
        RowDivider()
        PreferenceRow(icon: "menubar.rectangle", color: Theme.accent, title: "Show in menu bar", detail: "Quick access while the app is running") {
          Toggle("", isOn: Binding(get: { model.menuBarEnabled }, set: { model.setMenuBarEnabled($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
        }
        RowDivider()
        PreferenceRow(icon: "arrow.triangle.2.circlepath.circle", color: Theme.accent, title: "Automatically check for updates", detail: model.autoCheckUpdates ? "Once a day while the app is running" : "Manual checks only") {
          Toggle("", isOn: Binding(get: { model.autoCheckUpdates }, set: { model.setAutoCheckUpdates($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.active).disabled(model.isWorking)
        }

        SectionLabel(title: "Project & support", detail: "Open source", separated: true)
        ProjectLinkRow(icon: "chevron.left.forwardslash.chevron.right", title: "Open-source repository", detail: "View the code on GitHub", url: ProjectLinks.repository)
        RowDivider()
        ProjectLinkRow(icon: "ladybug", title: "Report a bug", detail: "Open a GitHub issue", url: ProjectLinks.issues)
        RowDivider()
        ProjectLinkRow(icon: "doc.text", title: "MIT license", detail: "Read the open-source license", url: ProjectLinks.license)
        RowDivider()
        ProjectLinkRow(icon: "heart", title: "Support on Ko-fi", detail: "Sponsor development", url: ProjectLinks.koFi)
        RowDivider()
        ProjectLinkRow(icon: "person.crop.circle.badge.plus", title: "Follow @apoorvdarshan on X", detail: "Developer updates", url: ProjectLinks.x)
        RowDivider()
        ProjectLinkRow(icon: "megaphone", title: "View on Product Hunt", detail: "Follow the launch and leave feedback", url: ProjectLinks.productHunt)
      }
    }
  }
}

struct ExtensionSetupSheet: View {
  @EnvironmentObject private var model: SyncModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "puzzlepiece.extension.fill")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(Theme.accent)
          .frame(width: 38, height: 38)
          .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        VStack(alignment: .leading, spacing: 3) {
          Text("Extension setup").font(.system(size: 18, weight: .bold, design: .rounded))
          Text("Load the folders for the two selected endpoints once.")
            .font(.system(size: 11.5)).foregroundStyle(.secondary)
        }
        Spacer()
        SetupStateBadge(ready: model.extensionsReady)
      }

      VStack(spacing: 0) {
        SetupEndpointRow(icon: model.sourceIcon, title: model.selectedBrowser.name, detail: "Load the source extension") {
          Button("Open page") { model.openExtensions(for: model.selectedSourceID) }
          Button("Show folder") { model.revealExtension(model.selectedSourceID) }
        }
        if model.selectedTargetID != "codex" {
          Divider().padding(.leading, 58)
          SetupEndpointRow(icon: model.targetIcon, title: model.targetName, detail: "Load the destination extension") {
            Button("Open page") { model.openExtensions(for: model.selectedTargetID) }
            Button("Show folder") { model.revealExtension(model.selectedTargetID) }
          }
        }
      }
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.07)))

      Text(model.selectedTargetID == "codex"
        ? "Codex uses a direct local merge, so no extension is required. Quit Codex before syncing. Password access is never requested."
        : "In both endpoints, enable Developer mode and choose Load unpacked. Password access is never requested.")
        .font(.system(size: 10.5))
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      HStack {
        Button("Refresh") { model.refresh() }
        Spacer()
        Button("Done") { dismiss() }
          .keyboardShortcut(.defaultAction)
      }
    }
    .padding(22)
    .frame(width: 460)
  }
}

struct AppBackground: View {
  var body: some View {
    ZStack {
      Color(nsColor: .windowBackgroundColor)
      LinearGradient(
        colors: [Theme.accent.opacity(0.035), Color.clear, Theme.accent.opacity(0.012)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    }
  }
}

struct Surface<Content: View>: View {
  var padding: CGFloat = 14
  @ViewBuilder var content: Content

  var body: some View {
    content
      .padding(padding)
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.74))
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.075)))
  }
}

struct RelayPath: View {
  let active: Bool

  var body: some View {
    ZStack {
      Capsule()
        .fill(Theme.accent.opacity(0.38))
        .frame(height: 3)
      Image(systemName: active ? "ellipsis" : "arrow.right")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(.white)
        .frame(width: 24, height: 24)
        .background(Theme.accent, in: Circle())
        .shadow(color: Theme.accent.opacity(0.22), radius: 5, y: 2)
    }
    .frame(maxWidth: .infinity)
    .accessibilityLabel(active ? "Transfer in progress" : "Transfers from the selected source to the selected destination")
  }
}

struct SectionLabel: View {
  let title: String
  let detail: String
  var separated = false

  var body: some View {
    HStack {
      Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
      Spacer()
      Text(detail).font(.system(size: 9.5, weight: .medium)).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, 14)
    .padding(.top, separated ? 12 : 11)
    .padding(.bottom, 7)
    .overlay(alignment: .top) {
      if separated { Divider() }
    }
  }
}

struct PreferenceRow<Trailing: View>: View {
  let icon: String
  let color: Color
  let title: String
  let detail: String
  var muted = false
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 11) {
      Image(systemName: icon)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(muted ? Color.secondary : color)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.system(size: 12.5, weight: .semibold))
        Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
      }
      .opacity(muted ? 0.62 : 1)
      Spacer()
      trailing
    }
    .padding(.horizontal, 14)
    .frame(height: 42)
  }
}

struct ProjectLinkRow: View {
  let icon: String
  let title: String
  let detail: String
  let url: URL?

  var body: some View {
    Group {
      if let url {
        Link(destination: url) { row }
          .buttonStyle(.plain)
      } else {
        row.opacity(0.45)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(url == nil ? "\(title), \(detail)" : title)
  }

  private var row: some View {
    HStack(spacing: 11) {
      Image(systemName: icon)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(url == nil ? Color.secondary : Theme.accent)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.system(size: 12.5, weight: .semibold))
        Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: url == nil ? "hourglass" : "arrow.up.right")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(.tertiary)
    }
    .padding(.horizontal, 14)
    .frame(height: 42)
    .contentShape(Rectangle())
  }
}

struct RowDivider: View {
  var body: some View { Divider().padding(.leading, 48) }
}

struct StatusIndicator: View {
  let state: SyncModel.State

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(label)
    }
    .font(.system(size: 10.5, weight: .semibold))
    .foregroundStyle(color)
    .padding(.horizontal, 9).padding(.vertical, 5)
    .background(color.opacity(0.1), in: Capsule())
  }

  private var label: String {
    switch state { case .ready: "Ready"; case .syncing: "Syncing"; case .success: "Synced"; case .warning: "Partial"; case .error: "Needs action" }
  }

  private var color: Color {
    switch state { case .ready, .syncing, .success: Theme.accent; case .warning: .orange; case .error: .red }
  }
}

struct SetupEndpointRow<Actions: View>: View {
  let icon: NSImage
  let title: String
  let detail: String
  @ViewBuilder var actions: Actions

  var body: some View {
    HStack(spacing: 12) {
      Image(nsImage: icon).resizable().scaledToFit().frame(width: 34, height: 34)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold))
        Text(detail).font(.system(size: 10.5)).foregroundStyle(.secondary)
      }
      Spacer()
      HStack(spacing: 7) { actions }.controlSize(.small)
    }
    .padding(13)
  }
}

struct SetupStateBadge: View {
  let ready: Bool

  var body: some View {
    Text(ready ? "Folders ready" : "Setup needed")
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(ready ? Theme.accent : .secondary)
      .padding(.horizontal, 8).padding(.vertical, 5)
      .background((ready ? Theme.accent : Color.secondary).opacity(0.1), in: Capsule())
  }
}

enum Theme {
  static let accent = Color(red: 0.46, green: 0.46, blue: 0.48)
  static let active = Color(red: 0.54, green: 0.12, blue: 0.18)
}
