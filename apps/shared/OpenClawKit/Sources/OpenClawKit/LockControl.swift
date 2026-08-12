import Foundation

public struct LockState: Codable, Sendable, Equatable {
    public let locked: Bool
    public let code: String?
    public init(locked: Bool, code: String?) {
        self.locked = locked
        self.code = code
    }
}

public struct LockGatewayConfig: Codable, Sendable, Equatable {
    public let baseURL: String
    public let token: String
    public let fingerprint: String?
    public init(baseURL: String, token: String, fingerprint: String?) {
        self.baseURL = baseURL
        self.token = token
        self.fingerprint = fingerprint
    }
}

public enum LockSharedStore {
    public static let appGroupID = "group.ai.openclawfoundation.app.shared"
    private static let configKey = "lock.gateway.config"
    private static let stateKey = "lock.state"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroupID) }

    public static func saveConfig(_ config: LockGatewayConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        defaults?.set(data, forKey: configKey)
    }

    public static func loadConfig() -> LockGatewayConfig? {
        guard let data = defaults?.data(forKey: configKey) else { return nil }
        return try? JSONDecoder().decode(LockGatewayConfig.self, from: data)
    }

    public static func saveState(_ state: LockState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults?.set(data, forKey: stateKey)
    }

    public static func loadState() -> LockState? {
        guard let data = defaults?.data(forKey: stateKey) else { return nil }
        return try? JSONDecoder().decode(LockState.self, from: data)
    }
}
