import SwiftUI
import OpenClawKit
import WidgetKit

enum WidgetCenterReloader {
    static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: "LockControlWidget")
    }
}

struct LockControlView: View {
    @State private var state: LockState?
    @State private var busy = false
    @State private var error: String?

    private var client: LockGatewayClient? {
        LockSharedStore.loadConfig().map(LockGatewayClient.init(config:))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                statusBadge
                buttons
                codeWord
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Spacer()
            }
            .padding()
            .navigationTitle("Блокировка")
            .task { await self.refresh() }
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
                       active: self.state?.locked == true, tint: .orange)
            lockButton(title: "Снять", on: false,
                       active: self.state?.locked == false, tint: .green)
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
        if let code = self.state?.code, !code.isEmpty {
            VStack(spacing: 4) {
                Text("Кодовое слово").font(.caption).foregroundStyle(.secondary)
                Text(code).font(.title3.monospaced().bold()).textSelection(.enabled)
            }
        }
    }

    private func refresh() async {
        guard let client else { self.error = "Нет данных gateway — откройте приложение при подключении"; return }
        do {
            let st = try await client.status()
            self.state = st
            LockSharedStore.saveState(st)
        } catch { self.error = "Не удалось получить состояние" }
    }

    private func toggle(on: Bool) async {
        guard let client else { return }
        self.busy = true; defer { self.busy = false }
        do {
            let st = try await client.set(on: on)
            self.state = st
            LockSharedStore.saveState(st)
            WidgetCenterReloader.reload()
        } catch { self.error = "Не удалось переключить" }
    }
}
