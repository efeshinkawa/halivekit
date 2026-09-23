import ActivityKit
import Foundation
import UserNotifications

@MainActor
final class LiveActivityRelayRegistrar {
    var onDiagnosticsChanged: ((APNsRelayDiagnostics) -> Void)?
    var onManagedRelayCredentialReceived: ((ManagedRelayCredential) -> Void)?
    var onManagedRelayPairingRequested: ((ManagedRelayPairingRequest) async throws -> ManagedRelayPairingGrant)?
    var onLog: ((String) -> Void)?

    private let client: APNsLiveActivityRelayClient
    private let deviceCredentialStore: RelayDeviceCredentialStore
    private let instanceIDStore: ManagedRelayInstanceIDStore
    private let pendingRevocationStore: RelayPendingRevocationStore
    private let tenantBindingStore = LiveActivityTenantBindingStore()
    private var settings: APNsRelaySettings
    private var deviceID: String
    private var localHomeAssistantInstanceID: String?
    private var relayHomeAssistantInstanceID: String?
    private var friendlyDeviceName: String?
    private var pushToStartTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    private var activityTokenTasks: [String: Task<Void, Never>] = [:]
    private var activityStateTasks: [String: Task<Void, Never>] = [:]
    private let registeredRouteStore = LiveActivityRegisteredRouteStore()
    private var registeredActivityTokens: Set<String> = []
    private var publishedManagedRelayCredentialInstanceIDs: Set<String> = []
    private var latestPushToStartToken: String?
    private var registrationInProgress = false
    private var activeRegistrationGeneration: UInt64?
    private var pendingRegistrationRequested = false
    private var scheduledRegistrationTask: Task<Void, Never>?
    private var scheduledRegistrationID: UUID?
    private var revocationRetryTask: Task<Void, Never>?
    private var credentialRefreshTask: Task<Void, Error>?
    private var credentialRefreshID: UUID?
    private var credentialRefreshGeneration: UInt64?
    private var contextGeneration: UInt64 = 0
    private var pendingActivityTokens: [String: PendingActivityToken] = [:]
    private var notificationAuthorizationStatus: UNAuthorizationStatus = .notDetermined
    private var diagnostics: APNsRelayDiagnostics

    init(
        client: APNsLiveActivityRelayClient = APNsLiveActivityRelayClient(),
        deviceCredentialStore: RelayDeviceCredentialStore = RelayDeviceCredentialStore(),
        instanceIDStore: ManagedRelayInstanceIDStore = ManagedRelayInstanceIDStore(),
        pendingRevocationStore: RelayPendingRevocationStore = RelayPendingRevocationStore()
    ) {
        self.client = client
        self.deviceCredentialStore = deviceCredentialStore
        self.instanceIDStore = instanceIDStore
        self.pendingRevocationStore = pendingRevocationStore
        self.settings = .disabled
        self.deviceID = ""
        self.localHomeAssistantInstanceID = nil
        self.relayHomeAssistantInstanceID = nil
        self.friendlyDeviceName = nil
        self.diagnostics = .disabled
    }

    func start(deviceID: String, settings: APNsRelaySettings) {
        invalidateRegistrationContext()
        self.deviceID = deviceID
        self.settings = settings
        diagnostics.mode = settings.effectiveMode
        publishDiagnostics()
        observePushToStartToken()
        observeActivityUpdates()
        observeActiveActivities()
        retryPendingRevocations()
    }

    func updateHomeAssistantContext(instanceID: String?, friendlyDeviceName: String?) throws {
        let normalizedInstanceID = instanceID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextInstanceID = normalizedInstanceID?.isEmpty == false ? normalizedInstanceID : nil
        let normalizedFriendlyName = friendlyDeviceName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextFriendlyName = normalizedFriendlyName?.isEmpty == false ? normalizedFriendlyName : nil
        let identityChanged = nextInstanceID != self.localHomeAssistantInstanceID
        if identityChanged,
           self.localHomeAssistantInstanceID != nil,
           nextInstanceID != nil {
            // A direct switch from one Home Assistant connection to another is
            // also a logout boundary for the old relay tenant. Queue revocation
            // while the old canonical identity and credential are still known.
            try enqueueCurrentCredentialForRevocation(using: settings)
        }
        if identityChanged || nextFriendlyName != self.friendlyDeviceName {
            invalidateRegistrationContext()
        }
        if identityChanged {
            cancelActivityTokenObservation()
            publishedManagedRelayCredentialInstanceIDs.removeAll()
            pendingActivityTokens.removeAll()
            registeredActivityTokens.removeAll()
            diagnostics.relayRegistered = false
            diagnostics.authenticationProtocol = .none
            diagnostics.homeAssistantPairingTicketStatus = .notRequested
            diagnostics.workerDeviceCredentialAvailable = false
        }
        self.localHomeAssistantInstanceID = nextInstanceID
        self.relayHomeAssistantInstanceID = nextInstanceID.flatMap {
            instanceIDStore.canonicalInstanceID(for: $0) ?? $0
        }
        self.friendlyDeviceName = nextFriendlyName
        if identityChanged {
            // Re-scan after cancellation, but only immutable tenant-matching
            // activities can install a new observer. This is not a rebind.
            observeActiveActivities()
        }

        refreshRegistration()
    }

    func updateSettings(_ settings: APNsRelaySettings) throws {
        let settingsChanged = self.settings != settings
        if settingsChanged, shouldRevokeManagedCredential(from: self.settings, to: settings) {
            try enqueueCurrentCredentialForRevocation(using: self.settings)
        }
        if settingsChanged {
            invalidateRegistrationContext()
        }
        self.settings = settings
        diagnostics.mode = settings.effectiveMode
        if settingsChanged {
            registeredActivityTokens.removeAll()
            publishedManagedRelayCredentialInstanceIDs.removeAll()
            diagnostics.relayRegistered = false
            diagnostics.authenticationProtocol = .none
            diagnostics.homeAssistantPairingTicketStatus = .notRequested
            diagnostics.workerDeviceCredentialAvailable = false
            diagnostics.registrationEnvironmentMismatch = false
        }

        if settings.effectiveMode == .disabled {
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationError = nil
            diagnostics.registrationEnvironmentMismatch = false
            diagnostics.authenticationProtocol = .none
        } else if !settings.isRegistrationReady {
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationError = settings.relayConfigurationIssue
            diagnostics.registrationEnvironmentMismatch = false
            diagnostics.authenticationProtocol = .none
        }

        publishDiagnostics()

        refreshRegistration()
    }

    func updateNotificationAuthorizationStatus(_ status: UNAuthorizationStatus) {
        if notificationAuthorizationStatus != status {
            invalidateRegistrationContext()
        }
        notificationAuthorizationStatus = status
        refreshRegistration()
    }

    func currentDiagnostics() -> APNsRelayDiagnostics {
        diagnostics
    }

    func refreshRegistration() {
        observePushToStartToken()
        observeActiveActivities()
        retryPendingRevocations()

        if notificationsAllowed, let latestPushToStartToken {
            schedulePushRegistration(latestPushToStartToken)
        }
    }

    func registerAgain() async {
        observePushToStartToken()
        observeActiveActivities()
        if let relayHomeAssistantInstanceID {
            publishedManagedRelayCredentialInstanceIDs.remove(relayHomeAssistantInstanceID)
        }

        guard let token = latestPushToStartToken else {
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationAttemptAt = .now
            diagnostics.lastRegistrationStatusCode = nil
            diagnostics.lastRegistrationResponseSummary = nil
            diagnostics.lastRegistrationError = L10n.string("No push-to-start token is available yet.")
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            return
        }

        guard let context = registrationContext() else { return }
        await registerPushToStartToken(token, context: context)
    }

    func testStart(activityID: String) async {
        guard let context = registrationContext() else {
            diagnostics.lastAPNsAttemptAt = .now
            diagnostics.lastAPNsStatusCode = nil
            diagnostics.lastAPNsResponseSummary = nil
            diagnostics.lastAPNSError = L10n.string("Connect Home Assistant before testing background updates.")
            publishDiagnostics()
            return
        }

        guard context.settings.isRegistrationReady else {
            diagnostics.lastAPNsAttemptAt = .now
            diagnostics.lastAPNsStatusCode = nil
            diagnostics.lastAPNsResponseSummary = nil
            diagnostics.lastAPNSError = context.settings.relayConfigurationIssue ?? L10n.string("Background relay is not configured.")
            publishDiagnostics()
            return
        }

        do {
            diagnostics.lastAPNsAttemptAt = .now
            publishDiagnostics()
            let result = try await performTestStart(
                activityID: activityID,
                context: context,
                mayReauthorize: true
            )
            guard isCurrent(context) else { return }
            diagnostics.lastAPNsStatusCode = result.statusCode
            diagnostics.lastAPNsResponseSummary = result.responseSummary
            diagnostics.lastAPNSError = nil
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            onLog?("APNs relay test start succeeded: HTTP \(result.statusCode).")
        } catch {
            guard isCurrent(context), !(error is CancellationError) else { return }
            diagnostics.lastAPNsStatusCode = (error as? APNsRelayClientError)?.statusCode
            diagnostics.lastAPNsResponseSummary = nil
            diagnostics.lastAPNSError = userFacingMessage(error)
            if (error as? APNsRelayClientError)?.isEnvironmentMismatch == true {
                diagnostics.relayRegistered = false
                diagnostics.lastRegistrationError = userFacingMessage(error)
                diagnostics.registrationEnvironmentMismatch = true
            }
            publishDiagnostics()
            onLog?("APNs relay test start failed: \(userFacingMessage(error))")
        }
    }

    func testRelayHealth() async {
        let generation = contextGeneration
        let settingsSnapshot = settings
        guard settingsSnapshot.effectiveMode != .disabled, settingsSnapshot.hasRelayURL else {
            diagnostics.lastHealthCheckedAt = .now
            diagnostics.lastHealthStatusCode = nil
            diagnostics.lastHealthResponseSummary = nil
            diagnostics.lastHealthError = settingsSnapshot.relayConfigurationIssue ?? L10n.string("Background relay is not configured.")
            publishDiagnostics()
            return
        }

        do {
            let result = try await client.testHealth(settings: settingsSnapshot)
            guard generation == contextGeneration, settingsSnapshot == settings else { return }
            diagnostics.lastHealthCheckedAt = .now
            diagnostics.lastHealthStatusCode = result.statusCode
            diagnostics.lastHealthResponseSummary = result.responseSummary
            diagnostics.lastHealthError = nil
            publishDiagnostics()
            onLog?("APNs relay health check succeeded: HTTP \(result.statusCode).")
        } catch {
            guard generation == contextGeneration,
                  settingsSnapshot == settings,
                  !(error is CancellationError)
            else { return }
            diagnostics.lastHealthCheckedAt = .now
            diagnostics.lastHealthStatusCode = (error as? APNsRelayClientError)?.statusCode
            diagnostics.lastHealthResponseSummary = nil
            diagnostics.lastHealthError = userFacingMessage(error)
            publishDiagnostics()
            onLog?("APNs relay health check failed: \(userFacingMessage(error))")
        }
    }

    func unregisterAndClearManagedDeviceCredential() throws {
        try enqueueCurrentCredentialForRevocation(using: settings)
        invalidateRegistrationContext()
        pendingActivityTokens.removeAll()
        registeredActivityTokens.removeAll()
        diagnostics.relayRegistered = false
        diagnostics.authenticationProtocol = .none
        diagnostics.workerDeviceCredentialAvailable = false
        publishDiagnostics()
        retryPendingRevocations()
    }

    func observeActiveActivities() {
        let activities = Activity<HALiveActivityAttributes>.activities
        let activeActivityKitIDs = Set(activities.map(\.id))

        // Reconcile dismissals that happened while the app was not running: any
        // registered route whose activity vanished from the system is retired at
        // the relay so Home Assistant stops "delivering" to a dead update token.
        // The record is removed only after the relay confirms, so a failed call
        // is retried on the next pass; the relay endpoint is idempotent.
        for vanished in registeredRouteStore.vanishedRoutes(
            keepingActivityKitIDs: activeActivityKitIDs
        ) {
            Task { [weak self] in
                await self?.retireVanishedRoute(vanished)
            }
        }

        tenantBindingStore.prune(keepingActivityKitIDs: activeActivityKitIDs)

        let staleActivityKitIDs = activityTokenTasks.keys.filter { !activeActivityKitIDs.contains($0) }
        for activityKitID in staleActivityKitIDs {
            activityTokenTasks[activityKitID]?.cancel()
            activityTokenTasks.removeValue(forKey: activityKitID)
            activityStateTasks[activityKitID]?.cancel()
            activityStateTasks.removeValue(forKey: activityKitID)
            pendingActivityTokens = pendingActivityTokens.filter {
                $0.value.activityKitID != activityKitID
            }
        }

        for activity in activities {
            observeActivity(activity)
        }
    }

    private func cancelActivityTokenObservation() {
        for (_, task) in activityTokenTasks {
            task.cancel()
        }
        activityTokenTasks.removeAll()
        for (_, task) in activityStateTasks {
            task.cancel()
        }
        activityStateTasks.removeAll()
    }

    private func observePushToStartToken() {
        pushToStartTask?.cancel()
        pushToStartTask = nil

        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            diagnostics.isObservingPushToStartToken = false
            diagnostics.pushToStartTokenAvailable = false
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationError = HALiveKitError.liveActivitiesDisabled.errorDescription
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            return
        }

        guard notificationsAllowed else {
            diagnostics.isObservingPushToStartToken = false
            diagnostics.pushToStartTokenAvailable = false
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationError = notificationUnavailableMessage
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            return
        }

        guard #available(iOS 17.2, *) else {
            diagnostics.isObservingPushToStartToken = false
            diagnostics.pushToStartTokenAvailable = false
            diagnostics.lastRegistrationError = L10n.string("Push-to-start tokens require iOS 17.2 or newer.")
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            return
        }

        if let currentToken = Activity<HALiveActivityAttributes>.pushToStartToken {
            let token = currentToken.haLiveKitHexString
            latestPushToStartToken = token
            diagnostics.pushToStartTokenAvailable = true
            diagnostics.redactedPushToStartToken = token.redactedToken
            diagnostics.lastPushToStartTokenUpdateAt = .now
            publishDiagnostics()
            schedulePushRegistration(token)
        }

        diagnostics.isObservingPushToStartToken = true
        publishDiagnostics()
        pushToStartTask = Task { [weak self] in
            for await tokenData in Activity<HALiveActivityAttributes>.pushToStartTokenUpdates {
                let token = tokenData.haLiveKitHexString
                await self?.handlePushToStartToken(token)
            }
        }
    }

    private func observeActivityUpdates() {
        activityUpdatesTask?.cancel()
        activityUpdatesTask = Task { [weak self] in
            for await activity in Activity<HALiveActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observeActivity(activity)
            }
        }
    }

    private func observeActivity(_ activity: Activity<HALiveActivityAttributes>) {
        guard activityTokenTasks[activity.id] == nil else { return }

        let activityID = activity.attributes.activityId
        let activityKitID = activity.id
        guard let originHomeAssistantInstanceID = activityOriginHomeAssistantInstanceID(
            for: activity
        ) else {
            return
        }
        guard let context = registrationContext() else { return }
        guard originMatchesContext(
            originHomeAssistantInstanceID,
            context: context
        ) else {
            onLog?("Ignored Live Activity update token for a different Home Assistant tenant.")
            return
        }
        // A dismissed or ended Live Activity keeps an update token APNs still answers
        // with HTTP 200, so Home Assistant would keep reporting delivered updates that
        // can never appear. ActivityKit only tells the device, so report it to the relay
        // and let the next Set start a fresh, visible activity.
        if activityStateTasks[activityKitID] == nil {
            activityStateTasks[activityKitID] = Task { [weak self] in
                for await state in activity.activityStateUpdates {
                    guard !Task.isCancelled else { return }
                    switch state {
                    case .dismissed:
                        await self?.retireActivityRoute(
                            activityID: activityID,
                            activityKitID: activityKitID,
                            originHomeAssistantInstanceID: originHomeAssistantInstanceID,
                            activityState: "dismissed"
                        )
                        return
                    case .ended:
                        await self?.retireActivityRoute(
                            activityID: activityID,
                            activityKitID: activityKitID,
                            originHomeAssistantInstanceID: originHomeAssistantInstanceID,
                            activityState: "ended"
                        )
                        return
                    default:
                        continue
                    }
                }
            }
        }

        activityTokenTasks[activityKitID] = Task { [weak self] in
            guard !Task.isCancelled else { return }
            if let currentToken = activity.pushToken {
                await self?.registerActivityToken(
                    currentToken.haLiveKitHexString,
                    activityID: activityID,
                    activityKitID: activityKitID,
                    contentState: activity.content.state,
                    originHomeAssistantInstanceID: originHomeAssistantInstanceID
                )
            }
            for await tokenData in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                await self?.registerActivityToken(
                    tokenData.haLiveKitHexString,
                    activityID: activityID,
                    activityKitID: activityKitID,
                    contentState: activity.content.state,
                    originHomeAssistantInstanceID: originHomeAssistantInstanceID
                )
            }
        }
    }

    private func activityOriginHomeAssistantInstanceID(
        for activity: Activity<HALiveActivityAttributes>
    ) -> String? {
        let activityKitID = activity.id
        let generalOrigin = activity.attributes.homeAssistantInstanceId
        let legacyControlOrigin = activity.attributes.entityControlHomeAssistantInstanceId

        if let generalOrigin,
           !HomeAssistantInstanceIdentity.isSafeIdentifier(generalOrigin) {
            onLog?("Ignored Live Activity with an invalid Home Assistant tenant binding.")
            return nil
        }
        if let legacyControlOrigin,
           !HomeAssistantInstanceIdentity.isSafeIdentifier(legacyControlOrigin) {
            onLog?("Ignored Live Activity with an invalid legacy tenant binding.")
            return nil
        }
        if let generalOrigin,
           let legacyControlOrigin,
           generalOrigin != legacyControlOrigin {
            onLog?("Ignored Live Activity with conflicting Home Assistant tenant bindings.")
            return nil
        }

        if let taggedOrigin = generalOrigin ?? legacyControlOrigin {
            guard tenantBindingStore.bind(
                activityKitID: activityKitID,
                tenantID: taggedOrigin
            ) else {
                onLog?("Ignored Live Activity whose persisted tenant binding conflicts with its attributes.")
                return nil
            }
            return taggedOrigin
        }

        // An untagged activity could have been started by any previously
        // registered Home Assistant tenant. Never infer ownership from the
        // mutable current connection, including during a cold restore.
        return tenantBindingStore.tenantID(for: activityKitID)
    }

    private func originMatchesContext(
        _ originHomeAssistantInstanceID: String,
        context: RegistrationContext
    ) -> Bool {
        guard HomeAssistantInstanceIdentity.isSafeIdentifier(
            originHomeAssistantInstanceID
        ) else {
            return false
        }
        if originHomeAssistantInstanceID == context.localInstanceID
            || originHomeAssistantInstanceID == context.relayInstanceID {
            return true
        }
        return instanceIDStore.canonicalInstanceID(
            for: originHomeAssistantInstanceID
        ) == context.relayInstanceID
    }

    private func handlePushToStartToken(_ token: String) async {
        latestPushToStartToken = token
        diagnostics.pushToStartTokenAvailable = true
        diagnostics.redactedPushToStartToken = token.redactedToken
        diagnostics.lastPushToStartTokenUpdateAt = .now
        diagnostics.lastRegistrationError = nil
        diagnostics.registrationEnvironmentMismatch = false
        publishDiagnostics()
        onLog?("APNs push-to-start token available.")
        guard let context = registrationContext() else { return }
        await registerPushToStartToken(token, context: context)
    }

    private func registerPushToStartToken(
        _ token: String,
        context: RegistrationContext
    ) async {
        guard isCurrent(context), !Task.isCancelled else { return }
        guard !registrationInProgress else {
            pendingRegistrationRequested = true
            return
        }
        registrationInProgress = true
        activeRegistrationGeneration = context.generation
        defer {
            if activeRegistrationGeneration == context.generation {
                registrationInProgress = false
                activeRegistrationGeneration = nil
                if pendingRegistrationRequested, isCurrent(context) {
                    pendingRegistrationRequested = false
                    if let latestPushToStartToken {
                        schedulePushRegistration(latestPushToStartToken)
                    }
                }
            }
        }

        guard notificationsAllowed else {
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationAttemptAt = .now
            diagnostics.lastRegistrationStatusCode = nil
            diagnostics.lastRegistrationResponseSummary = nil
            diagnostics.lastRegistrationError = notificationUnavailableMessage
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            return
        }

        guard context.settings.isRegistrationReady else {
            if context.settings.effectiveMode != .disabled {
                diagnostics.relayRegistered = false
                diagnostics.lastRegistrationAttemptAt = .now
                diagnostics.lastRegistrationStatusCode = nil
                diagnostics.lastRegistrationResponseSummary = nil
                diagnostics.lastRegistrationError = context.settings.relayConfigurationIssue
                diagnostics.registrationEnvironmentMismatch = false
                publishDiagnostics()
            }
            return
        }

        do {
            diagnostics.lastRegistrationAttemptAt = .now
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            let result = try await performPushRegistration(
                token: token,
                context: context
            )
            try Task.checkCancellation()
            guard isCurrent(context) else { return }
            diagnostics.relayRegistered = true
            diagnostics.lastRegistrationStatusCode = result.statusCode
            diagnostics.lastRegistrationResponseSummary = result.responseSummary
            diagnostics.lastRegistrationError = nil
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            let didPublishCredential = diagnostics.authenticationProtocol == .legacyV1
                ? publishManagedRelayCredentialIfNeeded(result)
                : false
            if context.settings.useManagedRelay,
               diagnostics.authenticationProtocol == .legacyV1,
               !didPublishCredential {
                onLog?("APNs relay register succeeded, but response did not include a Home Assistant relay credential.")
            }
            onLog?("Relay \(diagnostics.authenticationProtocol.rawValue) registration succeeded: HTTP \(result.statusCode).")
            if let refreshedContext = registrationContext() {
                await drainPendingActivityTokens(context: refreshedContext)
            }
        } catch {
            guard isCurrent(context), !(error is CancellationError) else { return }
            diagnostics.relayRegistered = false
            diagnostics.authenticationProtocol = .none
            diagnostics.lastRegistrationStatusCode = (error as? APNsRelayClientError)?.statusCode
            diagnostics.lastRegistrationResponseSummary = nil
            diagnostics.lastRegistrationError = userFacingMessage(error)
            diagnostics.registrationEnvironmentMismatch = (error as? APNsRelayClientError)?.isEnvironmentMismatch == true
            publishDiagnostics()
            onLog?("APNs relay push-to-start registration failed: \(userFacingMessage(error))")
        }
    }

    private func performPushRegistration(
        token: String,
        context: RegistrationContext
    ) async throws -> APNsRelayHTTPResult {
        try requireCurrent(context)
        guard context.settings.useManagedRelay else {
            let result = try await registerPushTokenLegacy(
                token: token,
                homeAssistantInstanceID: context.relayInstanceID,
                context: context
            )
            try requireCurrent(context)
            diagnostics.authenticationProtocol = .legacyV1
            return result
        }

        try await validateManagedRelayEnvironment(context: context)

        do {
            if let existingCredential = try loadDeviceCredential(
                homeAssistantInstanceID: context.relayInstanceID,
                context: context
            ) {
                diagnostics.workerDeviceCredentialAvailable = true
                do {
                    let result = try await client.registerPushToStartTokenV2(
                        settings: context.settings,
                        deviceID: context.deviceID,
                        homeAssistantInstanceID: context.relayInstanceID,
                        friendlyDeviceName: context.friendlyDeviceName,
                        token: token,
                        bundleIdentifier: context.bundleIdentifier,
                        appVersion: context.appVersion,
                        deviceCredential: existingCredential
                    )
                    try requireCurrent(context)
                    try persistValidatedDeviceCredential(
                        from: result,
                        fallbackCredential: existingCredential,
                        homeAssistantInstanceID: context.relayInstanceID,
                        context: context
                    )
                    diagnostics.authenticationProtocol = .deviceV2
                    diagnostics.workerDeviceCredentialAvailable = true
                    return result
                } catch let error as APNsRelayClientError where error.statusCode == 401 {
                    try requireCurrent(context)
                    try clearDeviceCredential(
                        homeAssistantInstanceID: context.relayInstanceID,
                        context: context
                    )
                    diagnostics.authenticationProtocol = .none
                    diagnostics.workerDeviceCredentialAvailable = false
                    onLog?("Stored relay device credential was rejected; requesting a fresh secure pairing ticket.")
                }
            }

            let result = try await registerWithFreshPairingTicket(
                token: token,
                context: context
            )
            diagnostics.authenticationProtocol = .deviceV2
            diagnostics.workerDeviceCredentialAvailable = true
            return result
        } catch let error as ManagedRelayPairingError where error.isV2Unavailable {
            try requireCurrent(context)
            diagnostics.homeAssistantPairingTicketStatus = .unavailable
            let fallbackInstanceID: String
            if let recoveryInstanceID = error.recoveryInstanceID {
                try adoptCanonicalInstanceID(recoveryInstanceID, context: context)
                fallbackInstanceID = recoveryInstanceID
            } else {
                fallbackInstanceID = context.relayInstanceID
            }
            return try await fallbackToLegacyRegistration(
                token: token,
                homeAssistantInstanceID: fallbackInstanceID,
                context: context,
                unavailableError: error
            )
        } catch let error as APNsRelayClientError where Self.isV2UnavailableStatus(error.statusCode) {
            try requireCurrent(context)
            diagnostics.homeAssistantPairingTicketStatus = .unavailable
            return try await fallbackToLegacyRegistration(
                token: token,
                homeAssistantInstanceID: relayHomeAssistantInstanceID ?? context.relayInstanceID,
                context: context,
                unavailableError: error
            )
        } catch ManagedRelayPairingError.administratorRequired {
            try requireCurrent(context)
            diagnostics.homeAssistantPairingTicketStatus = .administratorRequired
            throw ManagedRelayPairingError.administratorRequired
        } catch {
            if isCurrent(context), !(error is CancellationError) {
                diagnostics.homeAssistantPairingTicketStatus = .failed
            }
            throw error
        }
    }

    private func registerWithFreshPairingTicket(
        token: String,
        context: RegistrationContext
    ) async throws -> APNsRelayHTTPResult {
        guard let onManagedRelayPairingRequested else {
            throw ManagedRelayPairingError.invalidResponse
        }

        for attempt in 0..<2 {
            try requireCurrent(context)
            let pairingInstanceID = relayHomeAssistantInstanceID ?? context.relayInstanceID
            diagnostics.homeAssistantPairingTicketStatus = .requesting
            publishDiagnostics()
            let grant = try await onManagedRelayPairingRequested(
                ManagedRelayPairingRequest(
                    homeAssistantInstanceID: pairingInstanceID,
                    deviceID: context.deviceID,
                    pushToStartToken: token,
                    environment: context.settings.effectiveMode,
                    bundleIdentifier: context.bundleIdentifier,
                    appVersion: context.appVersion
                )
            )
            try requireCurrent(context)
            guard grant.deviceID == context.deviceID,
                  grant.environment == context.settings.effectiveMode.rawValue,
                  HomeAssistantInstanceIdentity.isSafeIdentifier(grant.homeAssistantInstanceID)
            else {
                throw ManagedRelayPairingError.invalidResponse
            }
            try adoptCanonicalInstanceID(grant.homeAssistantInstanceID, context: context)
            diagnostics.homeAssistantPairingTicketStatus = .authorized

            do {
                let result = try await client.registerPushToStartTokenV2(
                    settings: context.settings,
                    deviceID: context.deviceID,
                    homeAssistantInstanceID: grant.homeAssistantInstanceID,
                    friendlyDeviceName: context.friendlyDeviceName,
                    token: token,
                    bundleIdentifier: context.bundleIdentifier,
                    appVersion: context.appVersion,
                    pairingToken: grant.pairingToken
                )
                try requireCurrent(context)
                try persistValidatedDeviceCredential(
                    from: result,
                    fallbackCredential: nil,
                    homeAssistantInstanceID: grant.homeAssistantInstanceID,
                    context: context
                )
                return result
            } catch let error as APNsRelayClientError
                where error.statusCode == 401 && attempt == 0 {
                onLog?("Relay rejected the first pairing ticket; requesting one fresh ticket before retrying.")
            }
        }
        throw ManagedRelayPairingError.invalidResponse
    }

    private func fallbackToLegacyRegistration(
        token: String,
        homeAssistantInstanceID: String,
        context: RegistrationContext,
        unavailableError: Error
    ) async throws -> APNsRelayHTTPResult {
        guard context.settings.hasRegistrationSecret else {
            throw unavailableError
        }
        let result = try await registerPushTokenLegacy(
            token: token,
            homeAssistantInstanceID: homeAssistantInstanceID,
            context: context
        )
        try requireCurrent(context)
        diagnostics.authenticationProtocol = .legacyV1
        onLog?("Secure relay pairing is unavailable; compatibility registration succeeded.")
        return result
    }

    private func registerPushTokenLegacy(
        token: String,
        homeAssistantInstanceID: String,
        context: RegistrationContext
    ) async throws -> APNsRelayHTTPResult {
        try await client.registerPushToStartToken(
            settings: context.settings,
            deviceID: context.deviceID,
            homeAssistantInstanceID: homeAssistantInstanceID,
            friendlyDeviceName: context.friendlyDeviceName,
            token: token,
            bundleIdentifier: context.bundleIdentifier,
            appVersion: context.appVersion
        )
    }

    private func loadDeviceCredential(
        homeAssistantInstanceID: String,
        context: RegistrationContext
    ) throws -> String? {
        guard let relayURL = context.settings.relayURL else { return nil }
        return try deviceCredentialStore.load(
            relayURL: relayURL,
            environment: context.settings.effectiveMode,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: context.deviceID
        )
    }

    private func clearDeviceCredential(
        homeAssistantInstanceID: String,
        context: RegistrationContext
    ) throws {
        guard let relayURL = context.settings.relayURL else { return }
        try deviceCredentialStore.clear(
            relayURL: relayURL,
            environment: context.settings.effectiveMode,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: context.deviceID
        )
    }

    private func persistValidatedDeviceCredential(
        from result: APNsRelayHTTPResult,
        fallbackCredential: String?,
        homeAssistantInstanceID: String,
        context: RegistrationContext
    ) throws {
        try validateV2RegistrationResponse(
            result,
            homeAssistantInstanceID: homeAssistantInstanceID,
            context: context
        )
        let credential = (result.deviceCredential ?? fallbackCredential)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard credential.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              let relayURL = context.settings.relayURL
        else {
            throw ManagedRelayPairingError.invalidResponse
        }
        try deviceCredentialStore.save(
            credential,
            relayURL: relayURL,
            environment: context.settings.effectiveMode,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: context.deviceID
        )
    }

    private func validateV2RegistrationResponse(
        _ result: APNsRelayHTTPResult,
        homeAssistantInstanceID: String,
        context: RegistrationContext
    ) throws {
        guard result.ok == true,
              result.registered == true,
              result.authenticationProtocol == RelayAuthenticationProtocol.deviceV2.rawValue,
              result.deviceID == context.deviceID,
              result.homeAssistantInstanceID == homeAssistantInstanceID,
              result.environment == context.settings.effectiveMode.rawValue
        else {
            throw ManagedRelayPairingError.invalidResponse
        }
    }

    private func validateV2ActivityResponse(
        _ result: APNsRelayHTTPResult,
        pending: PendingActivityToken,
        context: RegistrationContext
    ) throws {
        guard result.ok == true,
              result.authenticationProtocol == RelayAuthenticationProtocol.deviceV2.rawValue,
              result.deviceID == context.deviceID,
              result.homeAssistantInstanceID == context.relayInstanceID,
              result.environment == context.settings.effectiveMode.rawValue,
              result.activityID == pending.activityID,
              originMatchesContext(
                  pending.originHomeAssistantInstanceID,
                  context: context
              )
        else {
            throw ManagedRelayPairingError.invalidResponse
        }
    }

    private static func isV2UnavailableStatus(_ statusCode: Int?) -> Bool {
        guard let statusCode else { return false }
        return [404, 405, 501].contains(statusCode)
    }

    private func retireVanishedRoute(_ route: LiveActivityRegisteredRouteStore.Route) async {
        await retireActivityRoute(
            activityID: route.activityID,
            activityKitID: route.activityKitID,
            originHomeAssistantInstanceID: route.tenantID,
            activityState: "dismissed"
        )
    }

    /// Tells the relay that a Live Activity reached a terminal ActivityKit state.
    ///
    /// Without this the relay keeps a route whose update token APNs still accepts, so
    /// Home Assistant reports a delivered update while nothing is on screen.
    private func retireActivityRoute(
        activityID: String,
        activityKitID: String,
        originHomeAssistantInstanceID: String,
        activityState: String
    ) async {
        guard let context = registrationContext(),
              originMatchesContext(
                  originHomeAssistantInstanceID,
                  context: context
              ),
              context.settings.isRegistrationReady
        else {
            return
        }

        registeredActivityTokens = Set(
            registeredActivityTokens.filter {
                !$0.hasPrefix("\(originHomeAssistantInstanceID):\(activityKitID):")
            }
        )
        pendingActivityTokens = pendingActivityTokens.filter {
            $0.value.activityKitID != activityKitID
        }

        do {
            if context.settings.useManagedRelay,
               let deviceCredential = try loadDeviceCredential(
                   homeAssistantInstanceID: context.relayInstanceID,
                   context: context
               ) {
                _ = try await client.retireActivityV2(
                    settings: context.settings,
                    deviceCredential: deviceCredential,
                    deviceID: context.deviceID,
                    homeAssistantInstanceID: context.relayInstanceID,
                    activityID: activityID,
                    activityState: activityState
                )
            } else {
                _ = try await client.retireActivity(
                    settings: context.settings,
                    deviceID: context.deviceID,
                    homeAssistantInstanceID: context.relayInstanceID,
                    activityID: activityID,
                    activityState: activityState
                )
            }
            registeredRouteStore.remove(activityKitID: activityKitID)
            onLog?("Live Activity \(activityState); relay route retired.")
        } catch {
            onLog?(
                "Live Activity \(activityState); relay route retirement failed: "
                    + userFacingMessage(error)
            )
        }
    }

    private func registerActivityToken(
        _ token: String,
        activityID: String,
        activityKitID: String,
        contentState: HALiveActivityAttributes.ContentState,
        originHomeAssistantInstanceID: String,
        mayReauthorize: Bool = true
    ) async {
        guard !Task.isCancelled,
              let context = registrationContext(),
              originMatchesContext(
                  originHomeAssistantInstanceID,
                  context: context
              ),
              context.settings.isRegistrationReady
        else {
            return
        }

        let fingerprint = "\(originHomeAssistantInstanceID):\(activityKitID):\(token)"
        if registeredActivityTokens.contains(fingerprint) {
            pendingActivityTokens.removeValue(forKey: fingerprint)
            return
        }
        pendingActivityTokens = pendingActivityTokens.filter {
            $0.value.activityKitID != activityKitID
        }
        registeredActivityTokens = Set(
            registeredActivityTokens.filter {
                !$0.hasPrefix("\(originHomeAssistantInstanceID):\(activityKitID):")
            }
        )
        let pending = PendingActivityToken(
            id: fingerprint,
            token: token,
            activityID: activityID,
            activityKitID: activityKitID,
            contentState: contentState,
            originHomeAssistantInstanceID: originHomeAssistantInstanceID
        )
        pendingActivityTokens[fingerprint] = pending
        guard !Task.isCancelled,
              isCurrent(context),
              originMatchesContext(
                  pending.originHomeAssistantInstanceID,
                  context: context
              )
        else {
            return
        }
        diagnostics.lastActivityTokenUpdateAt = .now
        publishDiagnostics()

        do {
            try Task.checkCancellation()
            guard originMatchesContext(
                originHomeAssistantInstanceID,
                context: context
            ) else {
                throw CancellationError()
            }
            try await validateManagedRelayEnvironment(context: context)
            try requireCurrent(context)
            guard originMatchesContext(
                originHomeAssistantInstanceID,
                context: context
            ) else {
                throw CancellationError()
            }
            let result: APNsRelayHTTPResult
            if context.settings.useManagedRelay,
               let deviceCredential = try loadDeviceCredential(
                   homeAssistantInstanceID: context.relayInstanceID,
                   context: context
               ) {
                result = try await client.registerActivityTokenV2(
                    settings: context.settings,
                    deviceCredential: deviceCredential,
                    deviceID: context.deviceID,
                    homeAssistantInstanceID: context.relayInstanceID,
                    activityID: activityID,
                    activityKitID: activityKitID,
                    token: token,
                    contentState: contentState,
                    bundleIdentifier: context.bundleIdentifier,
                    appVersion: context.appVersion
                )
                try requireCurrent(context)
                try validateV2ActivityResponse(result, pending: pending, context: context)
                diagnostics.authenticationProtocol = .deviceV2
                diagnostics.workerDeviceCredentialAvailable = true
            } else {
                if context.settings.useManagedRelay,
                   diagnostics.authenticationProtocol != .legacyV1 {
                    if let latestPushToStartToken {
                        schedulePushRegistration(latestPushToStartToken)
                    }
                    return
                }
                result = try await client.registerActivityToken(
                    settings: context.settings,
                    deviceID: context.deviceID,
                    homeAssistantInstanceID: context.relayInstanceID,
                    activityID: activityID,
                    activityKitID: activityKitID,
                    token: token,
                    contentState: contentState,
                    bundleIdentifier: context.bundleIdentifier,
                    appVersion: context.appVersion
                )
                try requireCurrent(context)
                diagnostics.authenticationProtocol = .legacyV1
            }
            registeredActivityTokens.insert(fingerprint)
            registeredRouteStore.record(
                activityKitID: activityKitID,
                activityID: activityID,
                tenantID: originHomeAssistantInstanceID
            )
            pendingActivityTokens.removeValue(forKey: fingerprint)
            diagnostics.relayRegistered = true
            diagnostics.lastRegistrationAttemptAt = .now
            diagnostics.lastRegistrationStatusCode = result.statusCode
            diagnostics.lastRegistrationResponseSummary = result.responseSummary
            diagnostics.lastRegistrationError = nil
            diagnostics.registrationEnvironmentMismatch = false
            publishDiagnostics()
            if diagnostics.authenticationProtocol == .legacyV1 {
                publishManagedRelayCredentialIfNeeded(result)
            }
            onLog?("Registered Live Activity update token for \(activityID) with relay: HTTP \(result.statusCode).")
        } catch {
            guard isCurrent(context), !(error is CancellationError) else { return }
            if (error as? APNsRelayClientError)?.statusCode == 401,
               context.settings.useManagedRelay,
               mayReauthorize,
               let pushToken = latestPushToStartToken {
                do {
                    try await refreshDeviceCredential(
                        pushToken: pushToken,
                        context: context
                    )
                    try requireCurrent(context)
                    await registerActivityToken(
                        token,
                        activityID: activityID,
                        activityKitID: activityKitID,
                        contentState: contentState,
                        originHomeAssistantInstanceID: originHomeAssistantInstanceID,
                        mayReauthorize: false
                    )
                    return
                } catch {
                    guard isCurrent(context), !(error is CancellationError) else { return }
                }
            }
            diagnostics.relayRegistered = false
            diagnostics.lastRegistrationAttemptAt = .now
            diagnostics.lastRegistrationStatusCode = (error as? APNsRelayClientError)?.statusCode
            diagnostics.lastRegistrationResponseSummary = nil
            diagnostics.lastRegistrationError = userFacingMessage(error)
            diagnostics.registrationEnvironmentMismatch = (error as? APNsRelayClientError)?.isEnvironmentMismatch == true
            publishDiagnostics()
            onLog?("APNs relay activity-token registration failed for \(activityID): \(userFacingMessage(error))")
        }
    }

    private func performTestStart(
        activityID: String,
        context: RegistrationContext,
        mayReauthorize: Bool
    ) async throws -> APNsRelayHTTPResult {
        try requireCurrent(context)
        if context.settings.useManagedRelay {
            try await validateManagedRelayEnvironment(context: context)
            if let deviceCredential = try loadDeviceCredential(
                homeAssistantInstanceID: context.relayInstanceID,
                context: context
            ) {
                do {
                    let result = try await client.sendTestStartV2(
                        settings: context.settings,
                        deviceCredential: deviceCredential,
                        deviceID: context.deviceID,
                        homeAssistantInstanceID: context.relayInstanceID,
                        activityID: activityID,
                        bundleIdentifier: context.bundleIdentifier,
                        appVersion: context.appVersion
                    )
                    try requireCurrent(context)
                    guard result.ok == true else {
                        throw ManagedRelayPairingError.invalidResponse
                    }
                    diagnostics.authenticationProtocol = .deviceV2
                    diagnostics.workerDeviceCredentialAvailable = true
                    return result
                } catch let error as APNsRelayClientError
                    where error.statusCode == 401 && mayReauthorize {
                    guard let pushToken = latestPushToStartToken else { throw error }
                    try await refreshDeviceCredential(
                        pushToken: pushToken,
                        context: context
                    )
                    try requireCurrent(context)
                    guard let refreshedContext = registrationContext() else {
                        throw CancellationError()
                    }
                    return try await performTestStart(
                        activityID: activityID,
                        context: refreshedContext,
                        mayReauthorize: false
                    )
                }
            }

            guard diagnostics.authenticationProtocol == .legacyV1 else {
                guard mayReauthorize, let pushToken = latestPushToStartToken else {
                    throw ManagedRelayPairingError.invalidResponse
                }
                try await refreshDeviceCredential(
                    pushToken: pushToken,
                    context: context
                )
                try requireCurrent(context)
                guard let refreshedContext = registrationContext() else {
                    throw CancellationError()
                }
                return try await performTestStart(
                    activityID: activityID,
                    context: refreshedContext,
                    mayReauthorize: false
                )
            }
        }

        let result = try await client.sendTestStart(
            settings: context.settings,
            deviceID: context.deviceID,
            homeAssistantInstanceID: context.relayInstanceID,
            activityID: activityID,
            bundleIdentifier: context.bundleIdentifier,
            appVersion: context.appVersion
        )
        try requireCurrent(context)
        diagnostics.authenticationProtocol = .legacyV1
        return result
    }

    /// The public managed relay is production-only. Sandbox builds validate
    /// the relay before every credential- or APNs-token-bearing mutation. A
    /// production build skips this probe to preserve the existing v1 fallback
    /// when an older compatible relay has no health environment field.
    private func validateManagedRelayEnvironment(
        context: RegistrationContext
    ) async throws {
        guard context.settings.useManagedRelay,
              context.settings.effectiveMode == .sandbox
        else {
            return
        }

        let health = try await client.testHealth(settings: context.settings)
        try requireCurrent(context)
        let relayEnvironment = health.environment ?? APNsRelayMode.production.rawValue
        guard relayEnvironment == APNsRelayMode.sandbox.rawValue else {
            throw APNsRelayClientError.environmentMismatch(
                relay: relayEnvironment,
                build: APNsRelayMode.sandbox.rawValue
            )
        }
    }

    private func drainPendingActivityTokens(context: RegistrationContext) async {
        guard isCurrent(context), !pendingActivityTokens.isEmpty else { return }
        let pending = Array(pendingActivityTokens.values)
        for entry in pending {
            guard isCurrent(context), !Task.isCancelled else { return }
            guard originMatchesContext(
                entry.originHomeAssistantInstanceID,
                context: context
            ) else {
                pendingActivityTokens.removeValue(forKey: entry.id)
                continue
            }
            await registerActivityToken(
                entry.token,
                activityID: entry.activityID,
                activityKitID: entry.activityKitID,
                contentState: entry.contentState,
                originHomeAssistantInstanceID: entry.originHomeAssistantInstanceID
            )
        }
    }

    private func registrationContext() -> RegistrationContext? {
        guard let localInstanceID = localHomeAssistantInstanceID,
              let relayInstanceID = relayHomeAssistantInstanceID,
              !deviceID.isEmpty
        else {
            return nil
        }
        return RegistrationContext(
            generation: contextGeneration,
            settings: settings,
            deviceID: deviceID,
            localInstanceID: localInstanceID,
            relayInstanceID: relayInstanceID,
            friendlyDeviceName: friendlyDeviceName,
            bundleIdentifier: bundleIdentifier,
            appVersion: appVersion
        )
    }

    private func isCurrent(_ context: RegistrationContext) -> Bool {
        context.generation == contextGeneration
            && context.deviceID == deviceID
            && context.localInstanceID == localHomeAssistantInstanceID
            && context.settings == settings
    }

    private func requireCurrent(_ context: RegistrationContext) throws {
        try Task.checkCancellation()
        guard isCurrent(context) else { throw CancellationError() }
    }

    private func invalidateRegistrationContext() {
        contextGeneration &+= 1
        scheduledRegistrationTask?.cancel()
        scheduledRegistrationTask = nil
        scheduledRegistrationID = nil
        registrationInProgress = false
        activeRegistrationGeneration = nil
        pendingRegistrationRequested = false
        credentialRefreshTask?.cancel()
        credentialRefreshTask = nil
        credentialRefreshID = nil
        credentialRefreshGeneration = nil
    }

    private func refreshDeviceCredential(
        pushToken: String,
        context: RegistrationContext
    ) async throws {
        try requireCurrent(context)
        if let credentialRefreshTask,
           credentialRefreshGeneration == context.generation {
            try await credentialRefreshTask.value
            try requireCurrent(context)
            return
        }

        let refreshID = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            try self.requireCurrent(context)
            try? self.clearDeviceCredential(
                homeAssistantInstanceID: context.relayInstanceID,
                context: context
            )
            self.diagnostics.authenticationProtocol = .none
            self.diagnostics.workerDeviceCredentialAvailable = false
            _ = try await self.performPushRegistration(
                token: pushToken,
                context: context
            )
            try self.requireCurrent(context)
        }
        credentialRefreshTask = task
        credentialRefreshID = refreshID
        credentialRefreshGeneration = context.generation

        do {
            try await task.value
            if credentialRefreshID == refreshID {
                credentialRefreshTask = nil
                credentialRefreshID = nil
                credentialRefreshGeneration = nil
            }
        } catch {
            if credentialRefreshID == refreshID {
                credentialRefreshTask = nil
                credentialRefreshID = nil
                credentialRefreshGeneration = nil
            }
            throw error
        }
    }

    private func schedulePushRegistration(_ token: String) {
        guard let context = registrationContext() else { return }
        if registrationInProgress {
            pendingRegistrationRequested = true
            return
        }
        scheduledRegistrationTask?.cancel()
        let taskID = UUID()
        scheduledRegistrationID = taskID
        scheduledRegistrationTask = Task { [weak self] in
            guard let self else { return }
            await self.registerPushToStartToken(token, context: context)
            guard self.isCurrent(context), self.scheduledRegistrationID == taskID else { return }
            self.scheduledRegistrationTask = nil
            self.scheduledRegistrationID = nil
        }
    }

    private func adoptCanonicalInstanceID(
        _ canonicalInstanceID: String,
        context: RegistrationContext
    ) throws {
        try requireCurrent(context)
        try instanceIDStore.save(
            canonicalInstanceID: canonicalInstanceID,
            for: context.localInstanceID
        )
        let canonicalIdentityChanged = relayHomeAssistantInstanceID
            != canonicalInstanceID
        relayHomeAssistantInstanceID = canonicalInstanceID
        if canonicalIdentityChanged {
            // A remote start can already carry the canonical tenant while the
            // app still knows only its local fingerprint. Re-scan once the
            // verified pairing response links those identities.
            observeActiveActivities()
        }
    }

    private func shouldRevokeManagedCredential(
        from oldSettings: APNsRelaySettings,
        to newSettings: APNsRelaySettings
    ) -> Bool {
        guard oldSettings.useManagedRelay,
              oldSettings.effectiveMode != .disabled,
              let oldURL = oldSettings.relayURL
        else {
            return false
        }
        guard newSettings.useManagedRelay,
              newSettings.effectiveMode != .disabled,
              let newURL = newSettings.relayURL
        else {
            return true
        }
        return oldSettings.effectiveMode != newSettings.effectiveMode
            || normalizedRelayScope(oldURL) != normalizedRelayScope(newURL)
    }

    private func enqueueCurrentCredentialForRevocation(using oldSettings: APNsRelaySettings) throws {
        guard oldSettings.useManagedRelay,
              oldSettings.effectiveMode != .disabled,
              let relayURL = oldSettings.relayURL,
              let homeAssistantInstanceID = relayHomeAssistantInstanceID,
              !deviceID.isEmpty
        else {
            return
        }

        guard let credential = try deviceCredentialStore.load(
            relayURL: relayURL,
            environment: oldSettings.effectiveMode,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: deviceID
        ) else {
            return
        }
        let pending = PendingRelayRevocation(
            relayURLString: relayURL.absoluteString,
            environment: oldSettings.effectiveMode,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: deviceID,
            deviceCredential: credential
        )
        // Persist the only remaining credential before deleting the active
        // copy. A logout or crash can therefore never silently lose revoke.
        try pendingRevocationStore.enqueue(pending)
        try deviceCredentialStore.clear(
            relayURL: relayURL,
            environment: oldSettings.effectiveMode,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: deviceID
        )
        diagnostics.workerDeviceCredentialAvailable = false
    }

    private func retryPendingRevocations() {
        guard revocationRetryTask == nil else { return }
        revocationRetryTask = Task { [weak self] in
            guard let self else { return }
            await self.processPendingRevocations()
            self.revocationRetryTask = nil
        }
    }

    private func processPendingRevocations() async {
        let pending: [PendingRelayRevocation]
        do {
            pending = try pendingRevocationStore.load()
        } catch {
            onLog?("Pending relay revocations could not be read: \(userFacingMessage(error))")
            return
        }

        for record in pending {
            guard !Task.isCancelled,
                  let relayURL = URL(string: record.relayURLString),
                  [APNsRelayMode.sandbox, .production].contains(record.environment)
            else {
                continue
            }
            let revocationSettings = APNsRelaySettings(
                useManagedRelay: false,
                relayURLString: relayURL.absoluteString,
                registrationSecret: "",
                sharedSecret: "",
                mode: record.environment
            )
            do {
                let result = try await client.unregisterV2(
                    settings: revocationSettings,
                    deviceCredential: record.deviceCredential,
                    deviceID: record.deviceID,
                    homeAssistantInstanceID: record.homeAssistantInstanceID
                )
                guard result.ok == true,
                      result.unregistered == true,
                      result.authenticationProtocol == RelayAuthenticationProtocol.deviceV2.rawValue,
                      result.deviceID == record.deviceID,
                      result.homeAssistantInstanceID == record.homeAssistantInstanceID,
                      result.environment == record.environment.rawValue
                else {
                    throw ManagedRelayPairingError.invalidResponse
                }
                try pendingRevocationStore.remove(id: record.id)
                onLog?("Relay device registration removed: HTTP \(result.statusCode).")
            } catch {
                onLog?("Relay device registration removal is queued for retry: \(userFacingMessage(error))")
            }
        }
    }

    private func normalizedRelayScope(_ url: URL) -> String {
        let port = url.port.map { ":\($0)" } ?? ""
        let path = url.path.split(separator: "/").joined(separator: "/")
        return "\(url.scheme?.lowercased() ?? "https")://\(url.host(percentEncoded: false)?.lowercased() ?? "")\(port)/\(path)"
    }

    private var bundleIdentifier: String {
        Bundle.main.bundleIdentifier ?? "unknown"
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
    }

    private var notificationsAllowed: Bool {
        switch notificationAuthorizationStatus {
        case .authorized, .provisional, .ephemeral:
            true
        default:
            false
        }
    }

    private var notificationUnavailableMessage: String {
        switch notificationAuthorizationStatus {
        case .denied:
            L10n.string("Notifications are denied for HA LiveKit.")
        case .notDetermined:
            L10n.string("Notifications are not enabled yet.")
        default:
            L10n.string("Notifications are not allowed for HA LiveKit.")
        }
    }

    private func publishDiagnostics() {
        onDiagnosticsChanged?(diagnostics)
    }

    @discardableResult
    private func publishManagedRelayCredentialIfNeeded(_ result: APNsRelayHTTPResult) -> Bool {
        guard settings.useManagedRelay,
              let relayURLString = settings.relayURL?.absoluteString,
              let homeAssistantInstanceID = relayHomeAssistantInstanceID,
              let localHomeAssistantInstanceID,
              !publishedManagedRelayCredentialInstanceIDs.contains(homeAssistantInstanceID)
        else {
            return false
        }
        let homeAssistantRelayToken = result.homeAssistantRelayToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let appRegistrationSecret = settings.effectiveRegistrationSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !homeAssistantRelayToken.isEmpty || !appRegistrationSecret.isEmpty else {
            return false
        }

        publishedManagedRelayCredentialInstanceIDs.insert(homeAssistantInstanceID)
        onManagedRelayCredentialReceived?(
            ManagedRelayCredential(
                relayURLString: relayURLString,
                relaySharedSecret: homeAssistantRelayToken,
                relayAppRegistrationSecret: appRegistrationSecret,
                environment: settings.effectiveMode,
                homeAssistantInstanceID: homeAssistantInstanceID,
                localHomeAssistantInstanceID: localHomeAssistantInstanceID
            )
        )
        return true
    }

    private func userFacingMessage(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

private struct RegistrationContext {
    var generation: UInt64
    var settings: APNsRelaySettings
    var deviceID: String
    var localInstanceID: String
    var relayInstanceID: String
    var friendlyDeviceName: String?
    var bundleIdentifier: String
    var appVersion: String
}

private struct PendingActivityToken {
    var id: String
    var token: String
    var activityID: String
    var activityKitID: String
    var contentState: HALiveActivityAttributes.ContentState
    var originHomeAssistantInstanceID: String
}

/// Device-local, non-secret ownership metadata for legacy ActivityKit records
/// that predate the tenant origin attribute. A binding can be written once for
/// an ActivityKit identifier and never reassigned to another tenant.
/// Persists which relay routes this device registered, keyed by ActivityKit ID.
///
/// The live `activityStateUpdates` observer only sees a dismissal while the app
/// process is running. When the user swipes an activity away while the app is
/// terminated, nobody reports it and the relay keeps a ghost route whose update
/// token APNs still accepts. This store survives relaunch so the next launch can
/// reconcile: any recorded route whose activity no longer exists in
/// `Activity.activities` is retired at the relay and then forgotten.
private final class LiveActivityRegisteredRouteStore {
    private let defaults: UserDefaults
    private let defaultsKey = "haLiveKitRegisteredActivityRoutes.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    struct Route {
        let activityKitID: String
        let activityID: String
        let tenantID: String
    }

    func record(activityKitID: String, activityID: String, tenantID: String) {
        guard !activityKitID.isEmpty, !activityID.isEmpty,
              HomeAssistantInstanceIdentity.isSafeIdentifier(tenantID)
        else { return }
        var current = routes()
        current[activityKitID] = [activityID, tenantID]
        defaults.set(current, forKey: defaultsKey)
    }

    func remove(activityKitID: String) {
        var current = routes()
        guard current.removeValue(forKey: activityKitID) != nil else { return }
        defaults.set(current, forKey: defaultsKey)
    }

    func vanishedRoutes(keepingActivityKitIDs activeActivityKitIDs: Set<String>) -> [Route] {
        routes().compactMap { key, value in
            guard !activeActivityKitIDs.contains(key),
                  value.count == 2,
                  HomeAssistantInstanceIdentity.isSafeIdentifier(value[1])
            else { return nil }
            return Route(activityKitID: key, activityID: value[0], tenantID: value[1])
        }
    }

    private func routes() -> [String: [String]] {
        defaults.dictionary(forKey: defaultsKey) as? [String: [String]] ?? [:]
    }
}

private final class LiveActivityTenantBindingStore {
    private let defaults: UserDefaults
    private let defaultsKey = "haLiveKitActivityTenantBindings.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func tenantID(for activityKitID: String) -> String? {
        guard let tenantID = bindings()[activityKitID],
              HomeAssistantInstanceIdentity.isSafeIdentifier(tenantID)
        else {
            return nil
        }
        return tenantID
    }

    @discardableResult
    func bind(activityKitID: String, tenantID: String) -> Bool {
        guard !activityKitID.isEmpty,
              HomeAssistantInstanceIdentity.isSafeIdentifier(tenantID)
        else {
            return false
        }
        var current = bindings()
        if let existingTenantID = current[activityKitID] {
            return existingTenantID == tenantID
        }
        current[activityKitID] = tenantID
        defaults.set(current, forKey: defaultsKey)
        return true
    }

    func prune(keepingActivityKitIDs activeActivityKitIDs: Set<String>) {
        let current = bindings()
        let retained = current.filter {
            activeActivityKitIDs.contains($0.key)
        }
        guard retained.count != current.count else { return }
        defaults.set(retained, forKey: defaultsKey)
    }

    private func bindings() -> [String: String] {
        defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }
}

private extension Data {
    var haLiveKitHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}

private extension String {
    var redactedToken: String {
        guard count > 12 else { return "<redacted>" }
        return "\(prefix(6))...\(suffix(6))"
    }
}
