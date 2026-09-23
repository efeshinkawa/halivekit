import Foundation
import Observation
import UserNotifications

struct AvailableAppUpdate: Identifiable, Equatable {
    var id: String { latestVersion }
    let installedVersion: String
    let latestVersion: String
}

enum ImportantNoticeSeverity: String, Decodable {
    case info
    case warning
    case critical
}

enum ImportantNoticeAction: String, Decodable {
    case none
    case appStore = "app_store"
    case hacsInstructions = "hacs_instructions"
}

struct ImportantNotice: Identifiable, Equatable {
    let id: String
    let revision: Int
    let severity: ImportantNoticeSeverity
    let title: String
    let message: String
    let publishedAt: Date
    let expiresAt: Date
    let minimumAppVersion: String?
    let maximumAppVersion: String?
    let action: ImportantNoticeAction
}

@MainActor
@Observable
final class AppUpdateService {
    static let appStoreURL = URL(string: "https://apps.apple.com/app/id6769399254")!
    static let hacsInstructionsURL = URL(
        string: "https://github.com/efeshinkawa/halivekit#installation-with-hacs"
    )!

    private(set) var availableUpdate: AvailableAppUpdate?
    private(set) var notices: [ImportantNotice] = []
    private(set) var isRefreshing = false
    private(set) var lastCheckedAt: Date?
    private(set) var lastNoticesError: String?
    private(set) var unreadNoticeCount = 0
    private(set) var importantNoticesEnabled: Bool

    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let notificationCenter: UNUserNotificationCenter
    @ObservationIgnored private let installedVersion: String
    @ObservationIgnored private var lastRefreshAttemptAt: Date?
    @ObservationIgnored private var seenNoticeRevisions: [String: Int]
    @ObservationIgnored private var notifiedNoticeRevisions: [String: Int]
    @ObservationIgnored private var notificationDeliveryDates: [Date]

    private static let appStoreLookupURL = URL(
        string: "https://itunes.apple.com/lookup?id=6769399254"
    )!
    private static let noticesFeedURL = URL(
        string: "https://raw.githubusercontent.com/efeshinkawa/halivekit/main/notices/v1.json"
    )!
    private static let expectedBundleIdentifier = "com.efeyesoylegelsin.HALiveKit"
    private nonisolated static let maximumResponseBytes = 64 * 1024
    private nonisolated static let maximumNotices = 20
    private static let maximumCriticalNotificationsPerRefresh = 1
    private static let maximumCriticalNotificationsPerDay = 3
    private static let refreshThrottle: TimeInterval = 15 * 60
    private static let remindLaterInterval: TimeInterval = 24 * 60 * 60
    private static let notificationQuotaWindow: TimeInterval = 24 * 60 * 60

    private enum DefaultsKey {
        static let noticesEnabled = "haLiveKit.importantNotices.enabled.v1"
        static let seenNoticeRevisions = "haLiveKit.importantNotices.seenRevisions.v1"
        static let notifiedNoticeRevisions = "haLiveKit.importantNotices.notifiedRevisions.v1"
        static let notificationDeliveryDates = "haLiveKit.importantNotices.deliveryDates.v1"
        static let remindedUpdateVersion = "haLiveKit.appUpdate.remindedVersion.v1"
        static let remindUpdateAfter = "haLiveKit.appUpdate.remindAfter.v1"
    }

    init(
        defaults: UserDefaults = .standard,
        notificationCenter: UNUserNotificationCenter = .current(),
        installedVersion: String = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "",
        bundledNoticesURL: URL? = Bundle.main.url(
            forResource: "v1",
            withExtension: "json",
            subdirectory: "notices"
        )
    ) {
        self.defaults = defaults
        self.notificationCenter = notificationCenter
        self.installedVersion = installedVersion
        self.importantNoticesEnabled = defaults.bool(forKey: DefaultsKey.noticesEnabled)
        self.seenNoticeRevisions = Self.revisionDictionary(
            defaults.dictionary(forKey: DefaultsKey.seenNoticeRevisions)
        )
        self.notifiedNoticeRevisions = Self.revisionDictionary(
            defaults.dictionary(forKey: DefaultsKey.notifiedNoticeRevisions)
        )
        self.notificationDeliveryDates = (defaults.array(
            forKey: DefaultsKey.notificationDeliveryDates
        ) as? [Date] ?? [])
        .sorted()
        .suffix(Self.maximumCriticalNotificationsPerDay)
        .map { $0 }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpAdditionalHeaders = [:]
        self.session = URLSession(configuration: configuration)

        if let bundledNoticesURL,
           let data = try? Data(contentsOf: bundledNoticesURL),
           data.count <= Self.maximumResponseBytes,
           let bundledNotices = try? Self.decodeNotices(
               from: data,
               now: .now,
               installedVersion: installedVersion
            ) {
            notices = bundledNotices
            lastCheckedAt = .now
            updateUnreadNoticeCount()
        }
    }

    func refresh(force: Bool = false) async {
        guard !isRefreshing else { return }

        let now = Date()
        pruneExpiredNotices(now: now)
        if !force,
           let lastRefreshAttemptAt,
           now.timeIntervalSince(lastRefreshAttemptAt) < Self.refreshThrottle {
            return
        }

        lastRefreshAttemptAt = now
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let update = try await fetchAvailableUpdate()
            availableUpdate = shouldDefer(update, now: now) ? nil : update
        } catch {
            // Update checks are advisory. Preserve any previously verified banner
            // and never surface or log a raw network response.
        }

        do {
            let fetchedNotices = try await fetchNotices(now: now)
            notices = fetchedNotices
            pruneRevisionState(activeNotices: fetchedNotices)
            lastCheckedAt = now
            lastNoticesError = nil
            updateUnreadNoticeCount()
            await scheduleCriticalNotificationsIfNeeded(for: fetchedNotices)
        } catch {
            // Keep the last valid feed. Error details can contain transport or
            // server-controlled text, so Settings receives only this fixed copy.
            lastNoticesError = notices.isEmpty
                ? "Important Notices could not be checked. Try again later."
                : nil
            if !notices.isEmpty {
                await scheduleCriticalNotificationsIfNeeded(for: notices)
            }
        }
    }

    func remindLater() {
        guard let availableUpdate else { return }
        defaults.set(availableUpdate.latestVersion, forKey: DefaultsKey.remindedUpdateVersion)
        defaults.set(
            Date().addingTimeInterval(Self.remindLaterInterval),
            forKey: DefaultsKey.remindUpdateAfter
        )
        self.availableUpdate = nil
    }

    func setImportantNoticesEnabled(_ enabled: Bool) async {
        importantNoticesEnabled = enabled
        defaults.set(enabled, forKey: DefaultsKey.noticesEnabled)

        guard enabled else {
            let pendingIdentifiers = notices.map {
                Self.notificationIdentifier(id: $0.id, revision: $0.revision)
            }
            notificationCenter.removePendingNotificationRequests(withIdentifiers: pendingIdentifiers)
            return
        }

        let settings = await notificationCenter.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await notificationCenter.requestAuthorization(options: [.alert, .sound])
        }
        await scheduleCriticalNotificationsIfNeeded(for: notices)
    }

    func markNoticeRead(_ notice: ImportantNotice) {
        let notificationID = Self.notificationIdentifier(
            id: notice.id,
            revision: notice.revision
        )
        notificationCenter.removePendingNotificationRequests(withIdentifiers: [notificationID])
        notificationCenter.removeDeliveredNotifications(withIdentifiers: [notificationID])

        guard (seenNoticeRevisions[notice.id] ?? 0) < notice.revision else { return }
        seenNoticeRevisions[notice.id] = notice.revision
        defaults.set(seenNoticeRevisions, forKey: DefaultsKey.seenNoticeRevisions)
        updateUnreadNoticeCount()
    }

    func isNoticeUnread(_ notice: ImportantNotice) -> Bool {
        (seenNoticeRevisions[notice.id] ?? 0) < notice.revision
    }

    func actionURL(for action: ImportantNoticeAction) -> URL? {
        switch action {
        case .none:
            nil
        case .appStore:
            Self.appStoreURL
        case .hacsInstructions:
            Self.hacsInstructionsURL
        }
    }

    nonisolated static func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult? {
        guard let left = versionComponents(lhs), let right = versionComponents(rhs) else {
            return nil
        }
        let count = max(left.count, right.count)
        for index in 0..<count {
            let leftValue = index < left.count ? left[index] : 0
            let rightValue = index < right.count ? right[index] : 0
            if leftValue < rightValue { return .orderedAscending }
            if leftValue > rightValue { return .orderedDescending }
        }
        return .orderedSame
    }

    private func fetchAvailableUpdate() async throws -> AvailableAppUpdate? {
        var request = Self.publicRequest(url: Self.appStoreLookupURL)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data = try await fetchBoundedData(for: request)
        let envelope = try JSONDecoder().decode(AppStoreLookupEnvelope.self, from: data)
        guard envelope.resultCount == 1,
              envelope.results.count == 1,
              envelope.results[0].bundleIdentifier == Self.expectedBundleIdentifier,
              envelope.results[0].version.count <= 32,
              Self.compareVersions(envelope.results[0].version, installedVersion) == .orderedDescending
        else {
            return nil
        }
        return AvailableAppUpdate(
            installedVersion: installedVersion,
            latestVersion: envelope.results[0].version
        )
    }

    private func fetchNotices(now: Date) async throws -> [ImportantNotice] {
        var request = Self.publicRequest(url: Self.noticesFeedURL)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data = try await fetchBoundedData(for: request)
        return try Self.decodeNotices(
            from: data,
            now: now,
            installedVersion: installedVersion
        )
    }

    private nonisolated static func decodeNotices(
        from data: Data,
        now: Date,
        installedVersion: String
    ) throws -> [ImportantNotice] {
        guard data.count <= maximumResponseBytes else {
            throw PublicFeedError.responseTooLarge
        }
        let feed = try JSONDecoder().decode(ImportantNoticesFeed.self, from: data)
        guard feed.schemaVersion == 1, feed.notices.count <= maximumNotices else {
            throw PublicFeedError.invalidPayload
        }

        var identifiers = Set<String>()
        var activeNotices: [ImportantNotice] = []
        activeNotices.reserveCapacity(feed.notices.count)

        for raw in feed.notices {
            guard identifiers.insert(raw.id).inserted else {
                throw PublicFeedError.invalidPayload
            }
            let notice = try Self.validatedNotice(raw)
            guard notice.publishedAt <= now.addingTimeInterval(5 * 60),
                  notice.expiresAt > now,
                  versionIsEligible(
                    installedVersion,
                    minimum: notice.minimumAppVersion,
                    maximum: notice.maximumAppVersion
                  )
            else {
                continue
            }
            activeNotices.append(notice)
        }

        return activeNotices.sorted {
            if $0.severity != $1.severity {
                return $0.severity.sortPriority > $1.severity.sortPriority
            }
            return $0.publishedAt > $1.publishedAt
        }
    }

    private func fetchBoundedData(for request: URLRequest) async throws -> Data {
        guard request.value(forHTTPHeaderField: "Authorization") == nil,
              request.value(forHTTPHeaderField: "X-HA-LiveKit-App-Secret") == nil,
              request.value(forHTTPHeaderField: "X-HA-LiveKit-Secret") == nil,
              request.value(forHTTPHeaderField: "X-HA-LiveKit-Device-Credential") == nil
        else {
            throw PublicFeedError.invalidRequest
        }

        let (bytes, response) = try await session.bytes(
            for: request,
            delegate: PublicFeedRedirectRejectingDelegate.shared
        )
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              response.expectedContentLength <= 0
                || response.expectedContentLength <= Int64(Self.maximumResponseBytes)
        else {
            throw PublicFeedError.invalidResponse
        }

        var data = Data()
        data.reserveCapacity(
            response.expectedContentLength > 0
                ? min(Int(response.expectedContentLength), Self.maximumResponseBytes)
                : 1024
        )
        for try await byte in bytes {
            guard data.count < Self.maximumResponseBytes else {
                throw PublicFeedError.responseTooLarge
            }
            data.append(byte)
        }
        return data
    }

    private func shouldDefer(_ update: AvailableAppUpdate?, now: Date) -> Bool {
        guard let update,
              defaults.string(forKey: DefaultsKey.remindedUpdateVersion) == update.latestVersion,
              let remindAfter = defaults.object(forKey: DefaultsKey.remindUpdateAfter) as? Date
        else {
            return false
        }
        return remindAfter > now
    }

    private func updateUnreadNoticeCount() {
        unreadNoticeCount = notices.reduce(into: 0) { count, notice in
            if (seenNoticeRevisions[notice.id] ?? 0) < notice.revision {
                count += 1
            }
        }
    }

    private func scheduleCriticalNotificationsIfNeeded(
        for notices: [ImportantNotice]
    ) async {
        guard importantNoticesEnabled else { return }
        let settings = await notificationCenter.notificationSettings()
        guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else {
            return
        }

        let now = Date()
        let quotaCutoff = now.addingTimeInterval(-Self.notificationQuotaWindow)
        notificationDeliveryDates.removeAll { $0 < quotaCutoff || $0 > now }
        guard notificationDeliveryDates.count < Self.maximumCriticalNotificationsPerDay else {
            defaults.set(
                notificationDeliveryDates,
                forKey: DefaultsKey.notificationDeliveryDates
            )
            return
        }

        var scheduledThisRefresh = 0
        for notice in notices where notice.severity == .critical {
            guard scheduledThisRefresh < Self.maximumCriticalNotificationsPerRefresh,
                  notificationDeliveryDates.count < Self.maximumCriticalNotificationsPerDay
            else {
                break
            }
            guard (seenNoticeRevisions[notice.id] ?? 0) < notice.revision,
                  (notifiedNoticeRevisions[notice.id] ?? 0) < notice.revision
            else {
                continue
            }

            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.message
            content.sound = .default
            content.userInfo = [
                "notice_id": notice.id,
                "notice_revision": notice.revision,
                "notice_action": notice.action.rawValue
            ]
            let request = UNNotificationRequest(
                identifier: Self.notificationIdentifier(
                    id: notice.id,
                    revision: notice.revision
                ),
                content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
            )
            do {
                try await notificationCenter.add(request)
                notifiedNoticeRevisions[notice.id] = notice.revision
                notificationDeliveryDates.append(now)
                scheduledThisRefresh += 1
            } catch {
                continue
            }
        }
        defaults.set(notifiedNoticeRevisions, forKey: DefaultsKey.notifiedNoticeRevisions)
        defaults.set(notificationDeliveryDates, forKey: DefaultsKey.notificationDeliveryDates)
    }

    private func pruneExpiredNotices(now: Date) {
        let valid = notices.filter {
            $0.expiresAt > now
                && Self.versionIsEligible(
                    installedVersion,
                    minimum: $0.minimumAppVersion,
                    maximum: $0.maximumAppVersion
                )
        }
        guard valid != notices else { return }
        notices = valid
        updateUnreadNoticeCount()
    }

    private func pruneRevisionState(activeNotices: [ImportantNotice]) {
        let preferredIDs = Set(activeNotices.map(\.id))
        seenNoticeRevisions = Self.boundedRevisionDictionary(
            seenNoticeRevisions,
            preferredIDs: preferredIDs
        )
        notifiedNoticeRevisions = Self.boundedRevisionDictionary(
            notifiedNoticeRevisions,
            preferredIDs: preferredIDs
        )
        defaults.set(seenNoticeRevisions, forKey: DefaultsKey.seenNoticeRevisions)
        defaults.set(notifiedNoticeRevisions, forKey: DefaultsKey.notifiedNoticeRevisions)
    }

    private nonisolated static func publicRequest(url: URL) -> URLRequest {
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 10
        )
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        return request
    }

    private nonisolated static func validatedNotice(
        _ raw: RawImportantNotice
    ) throws -> ImportantNotice {
        guard !LogSanitizer.containsCredentialShapedValue(raw.id),
              raw.id.range(
                of: #"^[a-z0-9][a-z0-9._-]{0,63}$"#,
                options: .regularExpression
              ) != nil,
              (1...1_000_000).contains(raw.revision),
              let title = strictPlainText(raw.title, maximumLength: 120, allowsLineBreaks: false),
              let message = strictPlainText(raw.message, maximumLength: 1_200, allowsLineBreaks: true),
              !LogSanitizer.containsCredentialShapedValue(title),
              !LogSanitizer.containsCredentialShapedValue(message),
              let publishedAt = parseISO8601(raw.publishedAt),
              let expiresAt = parseISO8601(raw.expiresAt),
              publishedAt < expiresAt,
              raw.minimumAppVersion.map({ versionComponents($0) != nil }) ?? true,
              raw.maximumAppVersion.map({ versionComponents($0) != nil }) ?? true
        else {
            throw PublicFeedError.invalidPayload
        }

        return ImportantNotice(
            id: raw.id,
            revision: raw.revision,
            severity: raw.severity,
            title: title,
            message: message,
            publishedAt: publishedAt,
            expiresAt: expiresAt,
            minimumAppVersion: raw.minimumAppVersion,
            maximumAppVersion: raw.maximumAppVersion,
            action: raw.action
        )
    }

    private nonisolated static func strictPlainText(
        _ value: String,
        maximumLength: Int,
        allowsLineBreaks: Bool
    ) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maximumLength else { return nil }
        for scalar in trimmed.unicodeScalars where CharacterSet.controlCharacters.contains(scalar) {
            if allowsLineBreaks, scalar == "\n" || scalar == "\t" {
                continue
            }
            return nil
        }
        if !allowsLineBreaks, trimmed.contains("\n") || trimmed.contains("\r") {
            return nil
        }
        return trimmed
    }

    private nonisolated static func versionIsEligible(
        _ installed: String,
        minimum: String?,
        maximum: String?
    ) -> Bool {
        if let minimum,
           compareVersions(installed, minimum) == .orderedAscending {
            return false
        }
        if let maximum,
           compareVersions(installed, maximum) == .orderedDescending {
            return false
        }
        return compareVersions(installed, installed) != nil
    }

    private nonisolated static func versionComponents(_ value: String) -> [Int]? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 32 else { return nil }
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...5).contains(parts.count) else { return nil }
        var components: [Int] = []
        components.reserveCapacity(parts.count)
        for part in parts {
            guard !part.isEmpty,
                  part.allSatisfy({ $0.isNumber }),
                  let value = Int(part),
                  value <= 1_000_000
            else {
                return nil
            }
            components.append(value)
        }
        return components
    }

    private nonisolated static func parseISO8601(_ value: String) -> Date? {
        guard value.count <= 40 else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let regular = ISO8601DateFormatter()
        regular.formatOptions = [.withInternetDateTime]
        return fractional.date(from: value) ?? regular.date(from: value)
    }

    private nonisolated static func revisionDictionary(
        _ raw: [String: Any]?
    ) -> [String: Int] {
        guard let raw else { return [:] }
        let sanitized: [String: Int] = raw.reduce(into: [:]) { result, entry in
            guard entry.key.range(
                of: #"^[a-z0-9][a-z0-9._-]{0,63}$"#,
                options: .regularExpression
            ) != nil,
            let number = entry.value as? NSNumber,
            (1...1_000_000).contains(number.intValue)
            else {
                return
            }
            result[entry.key] = number.intValue
        }
        return boundedRevisionDictionary(sanitized, preferredIDs: [])
    }

    private nonisolated static func boundedRevisionDictionary(
        _ source: [String: Int],
        preferredIDs: Set<String>
    ) -> [String: Int] {
        let maximumCount = 64
        guard source.count > maximumCount else { return source }

        let preferred = source.keys.filter(preferredIDs.contains).sorted()
        let remaining = source.keys.filter { !preferredIDs.contains($0) }.sorted()
        let selected = Array(
            (preferred + remaining).prefix(maximumCount)
        )
        return selected.reduce(into: [:]) { result, id in
            result[id] = source[id]
        }
    }

    private nonisolated static func notificationIdentifier(
        id: String,
        revision: Int
    ) -> String {
        "haLiveKit.importantNotice.\(id).\(revision)"
    }
}

private struct AppStoreLookupEnvelope: Decodable {
    let resultCount: Int
    let results: [AppStoreLookupResult]
}

private struct AppStoreLookupResult: Decodable {
    let bundleIdentifier: String
    let version: String

    enum CodingKeys: String, CodingKey {
        case bundleIdentifier = "bundleId"
        case version
    }
}

private struct ImportantNoticesFeed: Decodable {
    let schemaVersion: Int
    let notices: [RawImportantNotice]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case notices
    }
}

private struct RawImportantNotice: Decodable {
    let id: String
    let revision: Int
    let severity: ImportantNoticeSeverity
    let title: String
    let message: String
    let publishedAt: String
    let expiresAt: String
    let minimumAppVersion: String?
    let maximumAppVersion: String?
    let action: ImportantNoticeAction

    enum CodingKeys: String, CodingKey {
        case id
        case revision
        case severity
        case title
        case message
        case publishedAt = "published_at"
        case expiresAt = "expires_at"
        case minimumAppVersion = "minimum_app_version"
        case maximumAppVersion = "maximum_app_version"
        case action
    }
}

private enum PublicFeedError: Error {
    case invalidRequest
    case invalidResponse
    case responseTooLarge
    case invalidPayload
}

private extension ImportantNoticeSeverity {
    var sortPriority: Int {
        switch self {
        case .info: 0
        case .warning: 1
        case .critical: 2
        }
    }
}

private final class PublicFeedRedirectRejectingDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = PublicFeedRedirectRejectingDelegate()

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
