import Foundation
import CryptoKit
import UserNotifications

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

    private static var defaults: UserDefaults? { UserDefaults(suiteName: OpenClawAppGroup.identifier) }

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

/// URLSessionDelegate: доверяем сертификату gateway по SHA-256 fingerprint (если задан),
/// иначе — системному доверию. Самодостаточен, без зависимостей от WS-пиннинга.
final class LockPinningDelegate: NSObject, URLSessionDelegate {
    private let expected: String?
    init(expectedFingerprint: String?) {
        self.expected = expectedFingerprint?
            .replacingOccurrences(of: ":", with: "")
            .lowercased()
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let systemOk = SecTrustEvaluateWithError(trust, nil)
        if let expected {
            guard let fp = Self.leafFingerprint(trust) else {
                // pin configured but leaf cert unreadable -> fail closed, never downgrade
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            if fp == expected {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
            return
        }
        if systemOk {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    static func leafFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first
        else { return nil }
        let der = SecCertificateCopyData(leaf) as Data
        return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }
}

public enum LockGatewayError: Error { case badResponse(Int), invalidURL }

public actor LockGatewayClient {
    private let config: LockGatewayConfig
    private let session: URLSession

    public init(config: LockGatewayConfig) {
        self.config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 12
        self.session = URLSession(
            configuration: cfg,
            delegate: LockPinningDelegate(expectedFingerprint: config.fingerprint),
            delegateQueue: nil)
    }

    public func status() async throws -> LockState { try await self.send(method: "GET", body: nil) }

    public func set(on: Bool) async throws -> LockState {
        try await self.send(method: "POST", body: ["action": on ? "on" : "off"])
    }

    private func send(method: String, body: [String: String]?) async throws -> LockState {
        guard let url = URL(string: self.config.baseURL.hasSuffix("/")
            ? self.config.baseURL + "api/lock"
            : self.config.baseURL + "/api/lock")
        else { throw LockGatewayError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(self.config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await self.session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw LockGatewayError.badResponse(code) }
        return try JSONDecoder().decode(LockState.self, from: data)
    }
}

public enum LockNotifier {
    /// Local phone notification on a successful lock/unlock.
    public static func notify(locked: Bool, code: String?) {
        let center = UNUserNotificationCenter.current()
        let content = UNMutableNotificationContent()
        content.title = locked ? "🔒 Ассистент заблокирован" : "🔓 Ассистент разблокирован"
        if locked, let code, !code.isEmpty {
            content.body = "Кодовое слово: \(code)"
        }
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(request)
    }
}
