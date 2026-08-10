import AppKit
import SwiftUI

@main
struct BraveCodexSyncApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var model = SyncModel()

  var body: some Scene {
    WindowGroup("Brave Codex Sync", id: "main") {
      ContentView()
        .environmentObject(model)
        .frame(width: 548, height: 650)
        .background(Color(nsColor: .windowBackgroundColor))
    }
    .windowResizability(.contentSize)
    .commands { CommandGroup(replacing: .newItem) {} }

    MenuBarExtra("Brave Codex Sync", systemImage: "arrow.left.arrow.right.circle.fill") {
      MenuBarContent()
        .environmentObject(model)
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

struct MenuBarContent: View {
  @EnvironmentObject private var model: SyncModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Button("Show Brave Codex Sync") {
      openWindow(id: "main")
      NSApp.activate(ignoringOtherApps: true)
    }
    Button(model.isSyncing ? "Syncing…" : "Sync now") { model.syncNow() }
      .disabled(model.isSyncing)
    Divider()
    Text(model.primaryStatus)
    Divider()
    Button("Quit") { NSApp.terminate(nil) }
  }
}

struct ContentView: View {
  @EnvironmentObject private var model: SyncModel

  var body: some View {
    VStack(spacing: 14) {
      header
      relayCard
      importCard
      scheduleCard
      setupCard
      footer
    }
    .padding(22)
    .onAppear { model.refresh() }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Image(systemName: "arrow.left.arrow.right.circle.fill")
        .font(.system(size: 30, weight: .semibold))
        .symbolRenderingMode(.palette)
        .foregroundStyle(Theme.relayBlue, Theme.relayBlue.opacity(0.16))
      VStack(alignment: .leading, spacing: 2) {
        Text("Brave Codex Sync")
          .font(.system(size: 21, weight: .bold, design: .rounded))
        Text("Browser data relay · local to this Mac")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(.secondary)
      }
      Spacer()
      StatusPill(state: model.state)
    }
  }

  private var relayCard: some View {
    Card {
      VStack(spacing: 14) {
        HStack(spacing: 12) {
          Menu {
            ForEach(model.browsers) { browser in
              Button {
                model.selectSource(browser.id)
              } label: {
                HStack {
                  Image(nsImage: model.browserIcon(browser))
                  Text(browser.name)
                  if browser.id == model.selectedSourceID {
                    Image(systemName: "checkmark")
                  }
                }
              }
            }
          } label: {
            LogoBadge(icon: model.sourceIcon, label: model.selectedBrowser.name, showsChevron: true)
          }
          .menuStyle(.borderlessButton)
          .fixedSize()
          .disabled(model.isWorking || model.isSyncing)

          RelayRail(active: model.isSyncing)
          LogoBadge(icon: model.codexIcon, label: "Codex")
        }

        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 3) {
            Text(model.primaryStatus)
              .font(.system(size: 13, weight: .semibold))
            Text(model.secondaryStatus)
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
          Spacer()
          Button {
            model.syncNow()
          } label: {
            HStack(spacing: 7) {
              if model.isSyncing { ProgressView().controlSize(.small) }
              else { Image(systemName: "arrow.triangle.2.circlepath") }
              Text(model.isSyncing ? "Syncing…" : "Sync now")
            }
            .frame(minWidth: 92)
          }
          .buttonStyle(.borderedProminent)
          .tint(Theme.relayBlue)
          .disabled(model.isSyncing)
          .keyboardShortcut(.return, modifiers: .command)
        }
      }
    }
  }

  private var importCard: some View {
    Card {
      VStack(spacing: 9) {
        HStack {
          Label("Import into Codex", systemImage: "square.and.arrow.down")
            .font(.system(size: 13, weight: .semibold))
          Spacer()
          Text("Preferences are saved")
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(.secondary)
        }
        Divider()
        ImportRow(
          icon: "network",
          title: "Cookies",
          detail: "Site sessions and sign-ins",
          isOn: Binding(get: { model.cookiesEnabled }, set: { model.setCookiesEnabled($0) }),
          tint: Theme.relayBlue,
          disabled: model.isWorking
        )
        ImportRow(
          icon: "clock.arrow.circlepath",
          title: "History URLs",
          detail: "Visit times and titles are not preserved",
          isOn: Binding(get: { model.historyEnabled }, set: { model.setHistoryEnabled($0) }),
          tint: Theme.codexTeal,
          disabled: model.isWorking
        )
        HStack(spacing: 12) {
          Image(systemName: "key.slash")
            .foregroundStyle(.tertiary)
            .frame(width: 22)
          VStack(alignment: .leading, spacing: 2) {
            Text("Passwords")
              .font(.system(size: 12.5, weight: .semibold))
              .foregroundStyle(.secondary)
            Text("Unavailable to browser extensions")
              .font(.system(size: 10.5))
              .foregroundStyle(.tertiary)
          }
          Spacer()
          Text("Unavailable")
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.secondary.opacity(0.08), in: Capsule())
        }
      }
    }
  }

  private var scheduleCard: some View {
    Card {
      VStack(spacing: 10) {
        HStack(spacing: 12) {
          Image(systemName: "clock.badge.checkmark")
            .font(.system(size: 19, weight: .medium))
            .foregroundStyle(Theme.relayBlue)
            .frame(width: 24)
          VStack(alignment: .leading, spacing: 2) {
            Text("Daily sync").font(.system(size: 13, weight: .semibold))
            Text(model.dailyEnabled ? "Runs when both apps are open" : "Manual sync only")
              .font(.system(size: 10.5)).foregroundStyle(.secondary)
          }
          Spacer()
          DatePicker("", selection: $model.scheduleTime, displayedComponents: .hourAndMinute)
            .labelsHidden().disabled(!model.dailyEnabled || model.isWorking).frame(width: 82)
          Button("Save") { model.saveSchedule() }
            .controlSize(.small).disabled(!model.dailyEnabled || model.isWorking)
          Toggle("", isOn: Binding(get: { model.dailyEnabled }, set: { model.setDailyEnabled($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.codexTeal).disabled(model.isWorking)
        }
        Divider()
        HStack(spacing: 12) {
          Image(systemName: "power")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(Theme.codexTeal)
            .frame(width: 24)
          VStack(alignment: .leading, spacing: 2) {
            Text("Open at login").font(.system(size: 13, weight: .semibold))
            Text("Keep the menu-bar helper running in the background")
              .font(.system(size: 10.5)).foregroundStyle(.secondary)
          }
          Spacer()
          Toggle("", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
            .labelsHidden().toggleStyle(.switch).tint(Theme.codexTeal).disabled(model.isWorking)
        }
      }
    }
  }

  private var setupCard: some View {
    Card {
      VStack(spacing: 9) {
        HStack {
          Label("Browser extensions", systemImage: "puzzlepiece.extension")
            .font(.system(size: 13, weight: .semibold))
          Spacer()
          Text(model.extensionsReady ? "Folders ready" : "Setup required")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(model.extensionsReady ? Theme.codexTeal : .secondary)
        }
        Divider()
        HStack(spacing: 8) {
          Button("Open \(model.selectedBrowser.name) Extensions") { model.openSourceExtensions() }
          Button("Show source folder") { model.revealExtension(model.selectedSourceID) }
          Button("Show Codex folder") { model.revealExtension("codex") }
          Spacer()
        }
        .controlSize(.small)
      }
    }
  }

  private var footer: some View {
    HStack {
      Image(systemName: "lock.shield")
      Text("Selected data stays local. Password access is unavailable.")
      Spacer()
      Button("Refresh") { model.refresh() }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.relayBlue)
    }
    .font(.system(size: 10.5, weight: .medium))
    .foregroundStyle(.secondary)
  }
}

struct ImportRow: View {
  let icon: String
  let title: String
  let detail: String
  @Binding var isOn: Bool
  let tint: Color
  let disabled: Bool

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: icon).foregroundStyle(tint).frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 12.5, weight: .semibold))
        Text(detail).font(.system(size: 10.5)).foregroundStyle(.secondary)
      }
      Spacer()
      Toggle("", isOn: $isOn)
        .labelsHidden().toggleStyle(.switch).tint(tint).disabled(disabled)
    }
  }
}

struct Card<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .padding(14)
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.78))
      .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(Color.primary.opacity(0.07), lineWidth: 1))
  }
}

struct LogoBadge: View {
  let icon: NSImage
  let label: String
  var showsChevron = false

  var body: some View {
    HStack(spacing: 8) {
      Image(nsImage: icon)
        .resizable()
        .scaledToFit()
        .frame(width: 30, height: 30)
      Text(label).font(.system(size: 13, weight: .semibold, design: .rounded))
      if showsChevron {
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
  }
}

struct RelayRail: View {
  let active: Bool

  var body: some View {
    ZStack {
      Capsule()
        .fill(LinearGradient(colors: [Theme.braveCoral.opacity(0.28), Theme.relayBlue.opacity(0.5), Theme.codexTeal.opacity(0.28)], startPoint: .leading, endPoint: .trailing))
        .frame(height: 4)
      Image(systemName: active ? "ellipsis" : "arrow.right")
        .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
        .frame(width: 24, height: 24).background(Theme.relayBlue, in: Circle())
        .shadow(color: Theme.relayBlue.opacity(0.25), radius: 5, y: 2)
    }
    .frame(maxWidth: .infinity)
  }
}

struct StatusPill: View {
  let state: SyncModel.State

  var body: some View {
    HStack(spacing: 6) { Circle().fill(color).frame(width: 7, height: 7); Text(label) }
      .font(.system(size: 11, weight: .semibold))
      .padding(.horizontal, 10).padding(.vertical, 6)
      .background(color.opacity(0.12), in: Capsule()).foregroundStyle(color)
  }

  private var label: String {
    switch state { case .ready: "Ready"; case .syncing: "Syncing"; case .success: "Synced"; case .error: "Needs attention" }
  }

  private var color: Color {
    switch state { case .ready: Theme.relayBlue; case .syncing: Theme.braveCoral; case .success: Theme.codexTeal; case .error: .red }
  }
}

enum Theme {
  static let braveCoral = Color(red: 0.98, green: 0.33, blue: 0.19)
  static let codexTeal = Color(red: 0.06, green: 0.64, blue: 0.50)
  static let relayBlue = Color(red: 0.20, green: 0.49, blue: 0.96)
}
