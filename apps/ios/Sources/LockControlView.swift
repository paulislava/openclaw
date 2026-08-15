import SwiftUI
import OpenClawKit
import WidgetKit
import UserNotifications

enum WidgetCenterReloader {
    static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: "LockControlWidget")
    }
}

struct LockControlView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var busy = false
    @State private var error: String?

    private var client: LockGatewayClient? {
        LockSharedStore.loadConfig().map(LockGatewayClient.init(config:))
    }

    /// Живое состояние из общего источника; при первом показе — мгновенно из кеша App Group.
    private var state: LockState? {
        self.appModel.lockState ?? LockSharedStore.loadState()
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                statusBadge
                buttons
                codeWord
                if self.client == nil, self.state == nil {
                    Text("Нет данных gateway — откройте приложение при подключении")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Spacer()
            }
            .padding()
            .navigationTitle("Блокировка")
            .task {
                _ = try? await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound])
            }
        }
    }

    private var statusBadge: some View {
        let locked = self.state?.locked ?? false
        return Label(locked ? "Заблокировано" : "Открыто",
                     systemImage: locked ? "lock.fill" : "lock.open.fill")
            .font(.title2.bold())
            .foregroundStyle(locked ? .orange : .green)
    }

    private var buttons: some View {
        HStack(spacing: 16) {
            lockButton(title: "Заблокировать", on: true,
                       active: self.state?.locked == false, tint: .orange)
            lockButton(title: "Снять", on: false,
                       active: self.state?.locked == true, tint: .green)
        }
        .disabled(self.busy || self.client == nil)
    }

    private func lockButton(title: String, on: Bool, active: Bool, tint: Color) -> some View {
        Button { Task { await self.toggle(on: on) } } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(active ? tint : Color.gray.opacity(0.3))
    }

    @ViewBuilder private var codeWord: some View {
        if self.state?.locked == true, let code = self.state?.code, !code.isEmpty {
            VStack(spacing: 4) {
                Text("Кодовое слово").font(.caption).foregroundStyle(.secondary)
                Text(code).font(.title3.monospaced().bold()).textSelection(.enabled)
            }
        }
    }

    private func toggle(on: Bool) async {
        guard let client else { self.error = "Нет данных gateway"; return }
        self.busy = true; defer { self.busy = false }
        do {
            let st = try await client.set(on: on)
            // Немедленно обновляем общий источник для отзывчивости (SSE тоже пришлёт это же).
            self.appModel.lockState = st
            LockSharedStore.saveState(st)
            WidgetCenterReloader.reload()
            LockNotifier.notify(locked: st.locked, code: st.code)
        } catch { self.error = "Не удалось переключить" }
    }
}
