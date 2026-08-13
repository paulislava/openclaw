import AppIntents
import SwiftUI
import WidgetKit
import OpenClawKit

struct LockToggleIntent: AppIntent {
    static let title: LocalizedStringResource = "Переключить блокировку ассистента"
    static let isDiscoverable = false

    @Parameter(title: "Заблокировать") var on: Bool

    init() {}
    init(on: Bool) { self.on = on }

    func perform() async throws -> some IntentResult {
        guard let config = LockSharedStore.loadConfig() else { return .result() }
        let client = LockGatewayClient(config: config)
        let state = try await client.set(on: self.on)
        LockSharedStore.saveState(state)
        return .result()
    }
}

struct LockEntry: TimelineEntry {
    let date: Date
    let state: LockState?
}

struct LockProvider: TimelineProvider {
    func placeholder(in context: Context) -> LockEntry {
        LockEntry(date: Date(), state: LockState(locked: false, code: nil))
    }
    func getSnapshot(in context: Context, completion: @escaping (LockEntry) -> Void) {
        completion(LockEntry(date: Date(), state: LockSharedStore.loadState()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LockEntry>) -> Void) {
        let entry = LockEntry(date: Date(), state: LockSharedStore.loadState())
        completion(Timeline(entries: [entry], policy: .never))
    }
}

struct LockControlWidgetView: View {
    let entry: LockEntry
    private var locked: Bool {
        self.entry.state?.locked ?? false
    }

    private var accent: Color {
        self.locked ? .orange : .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 11) {
                ZStack {
                    Circle().fill(self.accent.opacity(0.18))
                    Image(systemName: self.locked ? "lock.fill" : "lock.open.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(self.accent)
                }
                .frame(width: 38, height: 38)

                VStack(alignment: .leading, spacing: 1) {
                    Text("Ассистент")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(self.locked ? "Заблокирован" : "Открыт")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.primary)
                }
                Spacer(minLength: 4)
                Link(destination: URL(string: "openclaw://chat")!) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 34, height: 34)
                        .background(Color.primary.opacity(0.08), in: Circle())
                }
            }

            if self.locked, let code = entry.state?.code, !code.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "key.fill")
                        .font(.caption2)
                        .foregroundStyle(self.accent)
                    Text(code)
                        .font(.subheadline.weight(.semibold).monospaced())
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .background(self.accent.opacity(0.14), in: Capsule())
            } else {
                Spacer(minLength: 0)
            }

            HStack(spacing: 9) {
                self.actionButton(
                    title: "Заблокировать",
                    icon: "lock.fill",
                    on: true,
                    active: !self.locked,
                    color: .orange)
                self.actionButton(
                    title: "Снять",
                    icon: "lock.open.fill",
                    on: false,
                    active: self.locked,
                    color: .green)
            }
            .controlSize(.regular)
        }
        .padding(14)
        .widgetURL(URL(string: "openclaw://lock"))
    }

    @ViewBuilder
    private func actionButton(
        title: String,
        icon: String,
        on: Bool,
        active: Bool,
        color: Color) -> some View
    {
        let button = Button(intent: LockToggleIntent(on: on)) {
            Label(title, systemImage: icon)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
        }
        if active {
            button.buttonStyle(.borderedProminent).tint(color)
        } else {
            button.buttonStyle(.bordered).tint(.gray)
        }
    }
}

struct LockControlWidget: Widget {
    let kind = "LockControlWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LockProvider()) { entry in
            LockControlWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Блокировка ассистента")
        .description("Постановка/снятие блокировки и кодовое слово.")
        .supportedFamilies([.systemMedium])
    }
}
