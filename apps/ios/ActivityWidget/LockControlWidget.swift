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
    private var locked: Bool { entry.state?.locked ?? false }

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Label(locked ? "Заблокировано" : "Открыто",
                      systemImage: locked ? "lock.fill" : "lock.open.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(locked ? .orange : .green)
                if let code = entry.state?.code, !code.isEmpty, locked {
                    Text("Код: \(code)").font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Link(destination: URL(string: "openclaw://chat")!) {
                    Label("Чат", systemImage: "bubble.left.and.bubble.right")
                        .font(.caption)
                }
            }
            Spacer()
            VStack(spacing: 8) {
                Button(intent: LockToggleIntent(on: true)) {
                    Text("Заблокировать").font(.caption.bold()).frame(maxWidth: .infinity)
                }
                .tint(locked ? .orange : .gray)
                Button(intent: LockToggleIntent(on: false)) {
                    Text("Снять").font(.caption.bold()).frame(maxWidth: .infinity)
                }
                .tint(locked ? .gray : .green)
            }
            .buttonStyle(.borderedProminent)
            .frame(width: 130)
        }
        .padding()
        .widgetURL(URL(string: "openclaw://lock"))
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
