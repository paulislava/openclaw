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
