import ActivityKit
import Foundation
import Observation
import SwiftUI
import UserNotifications

struct DebugLogEntry: Identifiable, Equatable {
    let id: UUID
    let timestamp: Date
    let message: String
    let repetitionCount: Int

    init(
        id: UUID = UUID(),
        timestamp: Date = .now,
        message: String,
        repetitionCount: Int = 1
    ) {
        self.id = id
        self.timestamp = timestamp
        self.message = message
        self.repetitionCount = max(1, repetitionCount)
    }

    var timestampText: String {
        timestamp.formatted(date: .omitted, time: .standard)
    }

    var formattedLine: String {
        let repetition = repetitionCount > 1 ? " ×\(repetitionCount)" : ""
        return "[\(timestampText)] \(message)\(repetition)"
    }
}

@MainActor
@Observable
final class AppModel {
    var connectionState: AppConnectionState = .disconnected
    var configuration: ConnectionConfiguration?
    var entities: [HAEntity] = []
    var activeActivities: [ActiveActivityRecord] = []
    private(set) var debugLogs: [DebugLogEntry] = []
    var lastErrorMessage: String?
    var foregroundUpdateNotice: String?
    var restStatus: ConnectionDiagnosticStatus = .idle
    var webSocketStatus: ConnectionDiagnosticStatus = .idle
    var entityFetchStatus: ConnectionDiagnosticStatus = .idle
    var lastRESTError: String?
    var lastConnectionTestResultLabel: String?
    var lastConnectionTestSucceeded: Bool?
    var lastWebSocketError: String?
    var lastEntityFetchError: String?
    var lastReceivedEventAt: Date?
    var lastReceivedEventType: String?
    var subscribedEventTypes: [String] = []
    var clientDeviceID: String
    var homeAssistantInstanceID: String?
    var relaySettings: APNsRelaySettings
    var relayDiagnostics: APNsRelayDiagnostics
    var shouldShowIntegrationGuide = false
    var notificationAuthorizationStatus = "Unknown"
    var notificationPermissionError: String?
    var relaySettingsError: String?
    var backgroundSetupChecks: [BackgroundSetupCheck] = []
    var managedRelayCredentialInstallState: ManagedRelayCredentialInstallState = .waiting
    var lastManagedRelayCredentialReceivedAt: Date?
    var lastManagedRelayCredentialInstallAttemptAt: Date?
    var lastManagedRelayCredentialInstallStatusCode: Int?
    var lastManagedRelayCredentialInstallError: String?
    var cloudKitSyncStatus: CloudKitSyncStatus = .off
    var managedRelayDevices: [ManagedRelayDevice] = []
    var managedRelayDevicesError: String?
    var isLoadingManagedRelayDevices = false
    var revokingManagedRelayDeviceID: String?
    var haLiveKitIntegrationStatus: HALiveKitIntegrationStatus?
    var haLiveKitIntegrationNeedsUpdate = false
    var haLiveKitIntegrationStatusError: String?
    var isCheckingHALiveKitIntegration = false

    let preferencesStore: AppPreferencesStore
    private let cloudKitMirror: CloudKitPreferencesMirror
    private let accountObserver: iCloudAccountObserver
    private let credentialStore: KeychainCredentialStore
    private let webSocketManager: HomeAssistantWebSocketManager
    private let liveActivityManager: LiveActivityManager
    private let managedRelayInstanceIDStore = ManagedRelayInstanceIDStore()
    private let relaySettingsStore: APNsRelaySettingsStore
    private let relayRegistrar: LiveActivityRelayRegistrar
    private let demoProvider: DemoHomeProvider
    private let entityCacheStore: HAEntityCacheStore
    private var client: HomeAssistantClient?
    private var pendingManagedRelayCredential: ManagedRelayCredential?
    private var connectionBeforeDemo: ConnectionConfiguration?
    private var didAttemptRestore = false
    private var lastEnteredBackgroundAt: Date?
    private var acceptsForegroundActivityRequests = false
    private var demoSimulationTask: Task<Void, Never>?
    private var entityCacheSaveTask: Task<Void, Never>?
    private var connectionGeneration: UInt64 = 0
    private var webSocketConnectionID: UUID?
    private static let deviceIDDefaultsKey = "haLiveKitClientDeviceID"
    private static let didRequestInitialNotificationPermissionKey = "haLiveKitDidRequestInitialNotificationPermission"

    init(
        credentialStore: KeychainCredentialStore? = nil,
        webSocketManager: HomeAssistantWebSocketManager? = nil,
        liveActivityManager: LiveActivityManager? = nil,
        relaySettingsStore: APNsRelaySettingsStore? = nil,
        relayRegistrar: LiveActivityRelayRegistrar? = nil,
        demoProvider: DemoHomeProvider? = nil,
        entityCacheStore: HAEntityCacheStore? = nil,
        preferencesStore: AppPreferencesStore? = nil,
        cloudKitMirror: CloudKitPreferencesMirror? = nil
    ) {
        self.credentialStore = credentialStore ?? KeychainCredentialStore()
        self.webSocketManager = webSocketManager ?? HomeAssistantWebSocketManager()
        self.liveActivityManager = liveActivityManager ?? LiveActivityManager()
        self.relaySettingsStore = relaySettingsStore ?? APNsRelaySettingsStore()
        self.relayRegistrar = relayRegistrar ?? LiveActivityRelayRegistrar()
        self.demoProvider = demoProvider ?? DemoHomeProvider()
        self.entityCacheStore = entityCacheStore ?? HAEntityCacheStore()
        self.preferencesStore = preferencesStore ?? AppPreferencesStore()
        self.cloudKitMirror = cloudKitMirror ?? CloudKitPreferencesMirror()
        self.accountObserver = iCloudAccountObserver()
        self.clientDeviceID = Self.loadClientDeviceID()
        let loadedRelaySettings = self.relaySettingsStore.load()
        self.relaySettings = loadedRelaySettings
        var diagnostics = APNsRelayDiagnostics.disabled
        diagnostics.mode = loadedRelaySettings.effectiveMode
        self.relayDiagnostics = diagnostics
        self.debugLogs = [
            DebugLogEntry(
                message: "Debug session started. Redacted events from this launch will appear here."
            )
        ]

        self.webSocketManager.onEntityChanged = { [weak self] entity, connectionID in
            Task { @MainActor in
                guard let self, self.webSocketConnectionID == connectionID else { return }
                await self.applyEntityUpdate(entity, connectionID: connectionID)
            }
        }

        self.webSocketManager.onActivityRequest = { [weak self] request, connectionID in
            Task { @MainActor in
                guard let self, self.webSocketConnectionID == connectionID else { return }
                await self.applyActivityRequest(request, connectionID: connectionID)
            }
        }

        self.webSocketManager.onStatusChanged = { [weak self] status, message, connectionID in
            Task { @MainActor in
                guard let self, self.webSocketConnectionID == connectionID else { return }
                self.webSocketStatus = status
                self.lastWebSocketError = message
            }
        }

        self.webSocketManager.onSubscribedEventTypesChanged = { [weak self] eventTypes, connectionID in
            Task { @MainActor in
                guard let self, self.webSocketConnectionID == connectionID else { return }
                self.subscribedEventTypes = eventTypes
            }
        }

        self.webSocketManager.onEventReceived = { [weak self] eventType, connectionID in
            Task { @MainActor in
                guard let self, self.webSocketConnectionID == connectionID else { return }
                self.lastReceivedEventAt = .now
                self.lastReceivedEventType = eventType
            }
        }

        self.webSocketManager.onLog = { [weak self] line, connectionID in
            Task { @MainActor in
                guard let self, self.webSocketConnectionID == connectionID else { return }
                self.appendLog(line)
            }
        }

        self.relayRegistrar.onDiagnosticsChanged = { [weak self] diagnostics in
            Task { @MainActor in
                self?.relayDiagnostics = diagnostics
            }
        }

        self.relayRegistrar.onManagedRelayCredentialReceived = { [weak self] credential in
            Task { @MainActor in
                await self?.handleManagedRelayCredentialReceived(credential)
            }
        }

        self.relayRegistrar.onManagedRelayPairingRequested = { [weak self] request in
            guard let self else {
                throw ManagedRelayPairingError.invalidResponse
            }
            return try await self.requestManagedRelayPairing(request)
        }

        self.relayRegistrar.onLog = { [weak self] line in
            Task { @MainActor in
                self?.appendLog(line)
            }
        }

        self.liveActivityManager.syncFromSystem()
        self.activeActivities = self.liveActivityManager.activeActivities
        self.relayRegistrar.start(deviceID: self.clientDeviceID, settings: self.relaySettings)

        self.cloudKitMirror.onStatusChanged = { [weak self] status in
            Task { @MainActor in
                self?.cloudKitSyncStatus = status
            }
        }
        self.cloudKitMirror.onRemoteSnapshot = { [weak self] remote in
            Task { @MainActor in
                self?.preferencesStore.applyRemoteSnapshot(remote)
            }
        }
        self.preferencesStore.onPreferencesChanged = { [weak self] snapshot in
            Task { @MainActor in
                self?.cloudKitMirror.push(snapshot)
            }
        }
        self.accountObserver.onAccountChanged = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                guard self.preferencesStore.iCloudSyncEnabled else { return }
                self.cloudKitMirror.resetForAccountChange(currentLocal: self.preferencesStore.preferences)
            }
        }
        if self.preferencesStore.iCloudSyncEnabled {
            self.cloudKitMirror.enable(currentLocal: self.preferencesStore.preferences)
        }

        Task { await reconcileDuplicateActivities() }
        Task { await refreshNotificationPermissionStatus() }
    }

    /// Public entry point used by the Settings UI.
    func setiCloudSyncEnabled(_ enabled: Bool) {
        preferencesStore.iCloudSyncEnabled = enabled
        if enabled {
            cloudKitMirror.enable(currentLocal: preferencesStore.preferences)
        } else {
            cloudKitMirror.disable()
        }
    }

    func restoreIfPossible() async {
        guard !didAttemptRestore else { return }
        didAttemptRestore = true

        do {
            if UserDefaults.standard.bool(forKey: HALiveKitDefaults.demoModeEnabledKey) {
                startDemoMode(persist: false)
                return
            }

            guard let stored = try credentialStore.load() else {
                connectionState = .disconnected
                return
            }

            try await connect(
                baseURLString: stored.baseURL.absoluteString,
                token: stored.token,
                displayName: stored.displayName,
                internalURLString: stored.internalURL?.absoluteString,
                externalURLString: stored.externalURL?.absoluteString,
                persist: true
            )
        } catch {
            connectionState = .failed(userFacingMessage(error))
            appendLog("Restore failed: \(error.localizedDescription)")
        }
    }

    func connect(
        baseURLString: String,
        token: String,
        displayName: String? = nil,
        internalURLString: String? = nil,
        externalURLString: String? = nil,
        persist: Bool = true,
        offerIntegrationGuide: Bool = false
    ) async throws {
        var attemptGeneration: UInt64?
        do {
            let url = try HomeAssistantURLNormalizer.normalize(baseURLString)
            let internalURL = try Self.optionalNormalizedURL(internalURLString)
            let externalURL = try Self.optionalNormalizedURL(externalURLString)
            let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)

            guard !trimmedToken.isEmpty else {
                throw HALiveKitError.missingCredentials
            }

            let generation = beginConnectionTransition()
            attemptGeneration = generation
            demoSimulationTask?.cancel()
            UserDefaults.standard.set(false, forKey: HALiveKitDefaults.demoModeEnabledKey)
            connectionState = .connecting
            restStatus = .connecting
            webSocketStatus = .idle
            entityFetchStatus = .idle
            lastErrorMessage = nil
            lastRESTError = nil
            lastWebSocketError = nil
            lastEntityFetchError = nil
            subscribedEventTypes = []
            entities = []

            let draftConfiguration = ConnectionConfiguration(
                baseURL: url,
                token: trimmedToken,
                displayName: displayName,
                internalURL: internalURL,
                externalURL: externalURL
            )
            let resolver = HomeAssistantConnectionResolver(configuration: draftConfiguration)
            let resolved = try await resolver.resolve()
            try requireCurrentConnectionGeneration(generation)
            let activeURL = resolved.configuration.baseURL
            let haConfig = resolved.haConfig
            let resolvedDisplayName = ConnectionConfiguration.resolvedDisplayName(
                preferredName: displayName,
                locationName: haConfig.locationName
            )
            let instanceID = HomeAssistantInstanceIdentity.identifier(baseURL: url, config: haConfig)
            let storedConfiguration = ConnectionConfiguration(
                baseURL: url,
                token: trimmedToken,
                displayName: resolvedDisplayName,
                internalURL: internalURL,
                externalURL: externalURL
            )
            let activeConfiguration = storedConfiguration.variant(baseURL: activeURL)
            let client = HomeAssistantClient(configuration: activeConfiguration)
            appendLog("Home Assistant config checked via \(resolved.candidate.localizedRoleLabel): HTTP \(resolved.debug.statusCode).")

            if persist {
                try credentialStore.save(storedConfiguration)
            }
            try requireCurrentConnectionGeneration(generation)

            self.configuration = activeConfiguration
            self.client = client
            self.homeAssistantInstanceID = instanceID
            self.entityCacheStore.activateScope(instanceID)
            try self.relayRegistrar.updateHomeAssistantContext(
                instanceID: instanceID,
                friendlyDeviceName: activeConfiguration.instanceName
            )
            self.preferencesStore.update { $0.displayName = activeConfiguration.displayName }
            self.restStatus = .connected
            self.connectionState = .connected
            self.connectionBeforeDemo = nil
            self.foregroundUpdateNotice = nil
            self.shouldShowIntegrationGuide = offerIntegrationGuide
            appendLog("REST connected to \(activeConfiguration.instanceName) via \(resolved.candidate.localizedRoleLabel). Fetching supported entities.")

            Task { [weak self] in
                guard let self, self.connectionGeneration == generation else { return }
                await self.refreshEntities()
            }
            Task { [weak self] in
                guard let self, self.connectionGeneration == generation else { return }
                await self.connectForegroundEventStream()
            }
            Task { [weak self] in
                guard let self, self.connectionGeneration == generation else { return }
                await self.refreshHALiveKitIntegrationStatus()
                guard self.connectionGeneration == generation else { return }
                self.scheduleBackgroundRegistrationRetry()
            }
        } catch {
            if let attemptGeneration,
               attemptGeneration != connectionGeneration || error is CancellationError {
                throw CancellationError()
            }
            let message = userFacingMessage(error)
            restStatus = .failed
            lastRESTError = message
            lastErrorMessage = message
            connectionState = .failed(message)
            appendLog("Connection failed: \(message)")
            throw error
        }
    }

    func updateDisplayName(_ name: String) {
        guard var configuration else { return }
        configuration.displayName = ConnectionConfiguration.resolvedDisplayName(
            preferredName: name,
            locationName: nil
        )

        do {
            try credentialStore.save(configuration)
            self.configuration = configuration
            try relayRegistrar.updateHomeAssistantContext(
                instanceID: homeAssistantInstanceID,
                friendlyDeviceName: configuration.instanceName
            )
            preferencesStore.update { $0.displayName = configuration.displayName }
            appendLog("Display name updated to \(configuration.instanceName).")
        } catch {
            lastErrorMessage = userFacingMessage(error)
        }
    }

    func saveRelaySettings(
        useManagedRelay: Bool,
        relayURLString: String,
        registrationSecret: String,
        sharedSecret: String,
        mode: APNsRelayMode
    ) {
        let trimmedSecret = registrationSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveSecret = mode == .disabled
            ? ""
            : (trimmedSecret.isEmpty ? relaySettings.registrationSecret : trimmedSecret)
        let trimmedSharedSecret = sharedSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveSharedSecret = mode == .disabled
            ? ""
            : (trimmedSharedSecret.isEmpty ? relaySettings.sharedSecret : trimmedSharedSecret)

        let settings = APNsRelaySettings(
            useManagedRelay: useManagedRelay,
            relayURLString: relayURLString,
            registrationSecret: effectiveSecret,
            sharedSecret: effectiveSharedSecret,
            mode: mode
        )

        do {
            let previousSettings = relaySettings
            try relaySettingsStore.save(settings)
            do {
                try relayRegistrar.updateSettings(settings)
            } catch {
                try? relaySettingsStore.save(previousSettings)
                throw error
            }
            relaySettings = settings
            relaySettingsError = nil
            preferencesStore.update {
                $0.apnsRelayMode = settings.mode.rawValue
                $0.useManagedRelay = settings.useManagedRelay
            }
            appendLog("APNs relay saved as \(settings.relaySourceTitle) in \(settings.effectiveMode.rawValue) mode.")
        } catch {
            relaySettingsError = userFacingMessage(error)
            appendLog("APNs relay settings save failed: \(userFacingMessage(error))")
        }
    }

    func refreshNotificationPermissionStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationAuthorizationStatus = Self.notificationStatusTitle(settings.authorizationStatus)
        notificationPermissionError = nil
        relayRegistrar.updateNotificationAuthorizationStatus(settings.authorizationStatus)
    }

    func requestNotificationPermission() async {
        do {
            UserDefaults.standard.set(true, forKey: Self.didRequestInitialNotificationPermissionKey)
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshNotificationPermissionStatus()
            scheduleBackgroundRegistrationRetry()
            appendLog(granted ? "Notification permission granted." : "Notification permission was not granted.")
        } catch {
            notificationPermissionError = userFacingMessage(error)
            appendLog("Notification permission request failed: \(userFacingMessage(error))")
        }
    }

    func requestInitialNotificationPermissionIfNeeded() async {
        await refreshNotificationPermissionStatus()

        guard !UserDefaults.standard.bool(forKey: Self.didRequestInitialNotificationPermissionKey),
              notificationAuthorizationStatus == "notDetermined"
        else {
            return
        }

        await requestNotificationPermission()
    }

    func registerRelayAgain() async {
        await refreshNotificationPermissionStatus()
        await relayRegistrar.registerAgain()
    }

    func retryBackgroundRegistration() async {
        relayRegistrar.refreshRegistration()

        if let pendingManagedRelayCredential {
            await configureManagedRelayInHomeAssistant(pendingManagedRelayCredential)
        }
    }

    private func scheduleBackgroundRegistrationRetry() {
        Task { [weak self] in
            await self?.retryBackgroundRegistration()
        }
    }

    func testRelayHealth() async {
        await relayRegistrar.testRelayHealth()
    }

    func refreshHALiveKitIntegrationStatus() async {
        guard !isDemoMode,
              let client,
              let configuration
        else {
            haLiveKitIntegrationStatus = nil
            haLiveKitIntegrationNeedsUpdate = false
            haLiveKitIntegrationStatusError = nil
            isCheckingHALiveKitIntegration = false
            return
        }

        let generation = connectionGeneration
        isCheckingHALiveKitIntegration = true
        haLiveKitIntegrationStatusError = nil
        do {
            let status = try await client.fetchHALiveKitIntegrationStatus()
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  !isDemoMode
            else { return }
            haLiveKitIntegrationStatus = status
            haLiveKitIntegrationNeedsUpdate = !status.supportsRelayPairingV2
                || !status.supportsRelayDevicesV2
            haLiveKitIntegrationStatusError = nil
            isCheckingHALiveKitIntegration = false
        } catch {
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  !(error is CancellationError)
            else { return }
            haLiveKitIntegrationStatus = nil
            if case HALiveKitError.integrationUpdateRequired = error {
                haLiveKitIntegrationNeedsUpdate = true
                haLiveKitIntegrationStatusError = nil
            } else {
                haLiveKitIntegrationNeedsUpdate = false
                haLiveKitIntegrationStatusError = userFacingMessage(error)
            }
            isCheckingHALiveKitIntegration = false
        }
    }

    func refreshManagedRelayDevices() async {
        guard relaySettings.useManagedRelay,
              !isDemoMode,
              let client,
              let configuration
        else {
            managedRelayDevices = []
            managedRelayDevicesError = nil
            return
        }
        if haLiveKitIntegrationNeedsUpdate {
            managedRelayDevices = []
            managedRelayDevicesError = HALiveKitError.integrationUpdateRequired.errorDescription
            isLoadingManagedRelayDevices = false
            return
        }
        let generation = connectionGeneration
        isLoadingManagedRelayDevices = true
        managedRelayDevicesError = nil
        do {
            let devices = try await client.fetchManagedRelayDevices()
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  relaySettings.useManagedRelay,
                  !isDemoMode
            else { return }
            managedRelayDevices = devices
            isLoadingManagedRelayDevices = false
        } catch {
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  !(error is CancellationError)
            else { return }
            managedRelayDevices = []
            managedRelayDevicesError = userFacingMessage(error)
            isLoadingManagedRelayDevices = false
        }
    }

    func revokeManagedRelayDevice(_ device: ManagedRelayDevice) async {
        guard device.deviceID != clientDeviceID,
              relaySettings.useManagedRelay,
              !isDemoMode,
              let client,
              let configuration
        else { return }
        let generation = connectionGeneration
        revokingManagedRelayDeviceID = device.deviceID
        managedRelayDevicesError = nil
        do {
            try await client.revokeManagedRelayDevice(deviceID: device.deviceID)
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  relaySettings.useManagedRelay,
                  !isDemoMode
            else { return }
            managedRelayDevices.removeAll { $0.deviceID == device.deviceID }
            revokingManagedRelayDeviceID = nil
            appendLog("Revoked relay device \(device.deviceID.prefix(8))… from Home Assistant.")
        } catch {
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  !(error is CancellationError)
            else { return }
            managedRelayDevicesError = userFacingMessage(error)
            revokingManagedRelayDeviceID = nil
        }
    }

    private func handleManagedRelayCredentialReceived(_ credential: ManagedRelayCredential) async {
        guard isCurrentManagedRelayCredential(credential) else {
            appendLog("Ignored a managed relay credential from a stale Home Assistant connection.")
            return
        }
        pendingManagedRelayCredential = credential
        lastManagedRelayCredentialReceivedAt = .now
        managedRelayCredentialInstallState = client == nil || isDemoMode ? .pending : .installing
        lastManagedRelayCredentialInstallError = nil
        await configureManagedRelayInHomeAssistant(credential)
    }

    private func requestManagedRelayPairing(
        _ request: ManagedRelayPairingRequest
    ) async throws -> ManagedRelayPairingGrant {
        if haLiveKitIntegrationNeedsUpdate {
            throw ManagedRelayPairingError.unavailable(
                HALiveKitError.integrationUpdateRequired.errorDescription
                    ?? L10n.string("Update the HA LiveKit integration in HACS and restart Home Assistant."),
                homeAssistantInstanceID: homeAssistantInstanceID
            )
        }
        guard !isDemoMode,
              let client,
              let configuration,
              let localInstanceID = homeAssistantInstanceID,
              request.deviceID == clientDeviceID,
              request.environment == relaySettings.effectiveMode,
              relaySettings.useManagedRelay,
              relaySettings.isRegistrationReady,
              HomeAssistantInstanceIdentity.isSafeIdentifier(localInstanceID),
              HomeAssistantInstanceIdentity.isSafeIdentifier(request.homeAssistantInstanceID)
        else {
            throw HALiveKitError.missingCredentials
        }
        let expectedDeviceID = clientDeviceID
        let expectedEnvironment = relaySettings.effectiveMode
        let expectedLocalInstanceID = localInstanceID
        let expectedConfiguration = configuration

        managedRelayCredentialInstallState = .installing
        lastManagedRelayCredentialInstallAttemptAt = .now
        lastManagedRelayCredentialInstallStatusCode = nil
        lastManagedRelayCredentialInstallError = nil
        do {
            let grant = try await client.requestManagedRelayPairing(request)
            guard !isDemoMode,
                  self.configuration == expectedConfiguration,
                  homeAssistantInstanceID == expectedLocalInstanceID,
                  clientDeviceID == expectedDeviceID,
                  relaySettings.useManagedRelay,
                  relaySettings.effectiveMode == expectedEnvironment,
                  grant.deviceID == expectedDeviceID,
                  grant.environment == expectedEnvironment.rawValue
            else {
                throw CancellationError()
            }
            pendingManagedRelayCredential = nil
            managedRelayCredentialInstallState = .installed
            lastManagedRelayCredentialReceivedAt = .now
            lastManagedRelayCredentialInstallStatusCode = grant.statusCode
            lastManagedRelayCredentialInstallError = nil
            appendLog("Home Assistant authorized secure relay pairing: HTTP \(grant.statusCode).")
            return grant
        } catch {
            guard self.configuration == expectedConfiguration,
                  homeAssistantInstanceID == expectedLocalInstanceID,
                  clientDeviceID == expectedDeviceID,
                  relaySettings.effectiveMode == expectedEnvironment,
                  !(error is CancellationError)
            else {
                throw error
            }
            managedRelayCredentialInstallState = .failed
            lastManagedRelayCredentialInstallStatusCode = httpStatusCode(from: error)
            lastManagedRelayCredentialInstallError = userFacingMessage(error)
            if let pairingError = error as? ManagedRelayPairingError,
               pairingError.isV2Unavailable {
                haLiveKitIntegrationNeedsUpdate = true
            }
            appendLog("Home Assistant secure relay pairing was not completed: \(userFacingMessage(error))")
            throw error
        }
    }

    private func configureManagedRelayInHomeAssistant(_ credential: ManagedRelayCredential) async {
        guard isCurrentManagedRelayCredential(credential) else {
            if pendingManagedRelayCredential == credential {
                pendingManagedRelayCredential = nil
            }
            appendLog("Discarded a managed relay credential after the Home Assistant connection changed.")
            return
        }
        guard let client, let configuration, let expectedInstanceID = homeAssistantInstanceID else {
            pendingManagedRelayCredential = credential
            managedRelayCredentialInstallState = .pending
            appendLog("Home Assistant managed relay credential pending until connection is ready.")
            return
        }
        let generation = connectionGeneration

        do {
            managedRelayCredentialInstallState = .installing
            lastManagedRelayCredentialInstallAttemptAt = .now
            lastManagedRelayCredentialInstallStatusCode = nil
            lastManagedRelayCredentialInstallError = nil
            let debug = try await client.configureManagedRelay(
                relayURLString: credential.relayURLString,
                relaySharedSecret: credential.relaySharedSecret,
                relayAppRegistrationSecret: credential.relayAppRegistrationSecret,
                environment: credential.environment.rawValue,
                homeAssistantInstanceID: credential.homeAssistantInstanceID
            )
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  homeAssistantInstanceID == expectedInstanceID,
                  isCurrentManagedRelayCredential(credential)
            else { return }
            if pendingManagedRelayCredential == credential {
                pendingManagedRelayCredential = nil
            }
            managedRelayCredentialInstallState = .installed
            lastManagedRelayCredentialInstallStatusCode = debug.statusCode
            lastManagedRelayCredentialInstallError = nil
            appendLog("Home Assistant relay credential installed: HTTP \(debug.statusCode).")
        } catch {
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  homeAssistantInstanceID == expectedInstanceID,
                  isCurrentManagedRelayCredential(credential),
                  !(error is CancellationError)
            else { return }
            pendingManagedRelayCredential = credential
            managedRelayCredentialInstallState = .failed
            lastManagedRelayCredentialInstallStatusCode = httpStatusCode(from: error)
            lastManagedRelayCredentialInstallError = userFacingMessage(error)
            appendLog("Home Assistant managed relay auto-config skipped: \(userFacingMessage(error))")
        }
    }

    private func isCurrentManagedRelayCredential(_ credential: ManagedRelayCredential) -> Bool {
        !isDemoMode
            && relaySettings.useManagedRelay
            && relaySettings.effectiveMode == credential.environment
            && homeAssistantInstanceID == credential.localHomeAssistantInstanceID
            && configuration != nil
    }

    func testBackgroundSetup() async {
        await refreshNotificationPermissionStatus()

        if relaySettings.hasRelayURL {
            await relayRegistrar.testRelayHealth()
            relayDiagnostics = relayRegistrar.currentDiagnostics()
        }

        let notificationsAllowed = areNotificationsAllowed
        let liveActivitiesReady = liveActivitiesAvailable && liveActivitiesEnabled
        let pushTokenAvailable = relayDiagnostics.pushToStartTokenAvailable
        let relayConfigured = relaySettings.isRegistrationReady
        let relayRegistered = relayDiagnostics.relayRegistered
        let relayHealthOK = relayDiagnostics.lastHealthStatusCode.map { (200..<300).contains($0) } ?? false
        let relayHasAPNsCredentials = relayHealthOK
            && !(relayDiagnostics.lastHealthResponseSummary?.contains("\"apns_configured\": false") ?? false)
        let foregroundConnectionWorking = !isDemoMode
            && restStatus == .connected
            && webSocketStatus == .connected
            && subscribedEventTypes.contains("ha_livekit_activity_request")

        if notificationsAllowed,
           liveActivitiesReady,
           pushTokenAvailable,
           relayConfigured,
           relayRegistered,
           relayHealthOK,
           relayHasAPNsCredentials {
            await relayRegistrar.testStart(activityID: "ha_livekit_background_test_\(Int(Date().timeIntervalSince1970))")
            relayDiagnostics = relayRegistrar.currentDiagnostics()
        }

        let relayTestStartOK = relayDiagnostics.lastAPNsStatusCode.map { (200..<300).contains($0) } ?? false

        let checks: [BackgroundSetupCheck] = [
            BackgroundSetupCheck(
                id: "notifications",
                title: L10n.string("Notifications allowed"),
                status: notificationsAllowed ? L10n.string("Allowed") : L10n.string("Not allowed"),
                isPassing: notificationsAllowed,
                detail: notificationsAllowed ? nil : L10n.string("Allow notifications to enable background Live Activities.")
            ),
            BackgroundSetupCheck(
                id: "live_activities",
                title: L10n.string("Live Activities available"),
                status: liveActivitiesReady ? L10n.string("Available") : L10n.string("Disabled"),
                isPassing: liveActivitiesReady,
                detail: liveActivitiesReady ? nil : L10n.string("Enable Live Activities for HA LiveKit in iOS Settings.")
            ),
            BackgroundSetupCheck(
                id: "push_token",
                title: L10n.string("Push token received"),
                status: pushTokenAvailable ? L10n.string("Received") : L10n.string("Waiting"),
                isPassing: pushTokenAvailable,
                detail: pushTokenAvailable ? nil : pushTokenUnavailableReasonText
            ),
            BackgroundSetupCheck(
                id: "relay_configured",
                title: L10n.string("Relay configured"),
                status: relayConfigured ? L10n.string("Configured") : L10n.string("Setup needed"),
                isPassing: relayConfigured,
                detail: relayConfigured ? nil : relaySettings.relayConfigurationIssue
            ),
            BackgroundSetupCheck(
                id: "relay_registered",
                title: L10n.string("Relay registered"),
                status: relayRegistered ? L10n.string("Registered") : L10n.string("Waiting"),
                isPassing: relayRegistered,
                detail: relayRegistered ? relayLastRegistrationResultText : relayDiagnostics.lastRegistrationError
            ),
            BackgroundSetupCheck(
                id: "relay_health",
                title: L10n.string("Relay health check"),
                status: relayHealthOK && relayHasAPNsCredentials ? L10n.string("Healthy") : (relayHealthOK ? L10n.string("APNs missing") : L10n.string("Failed")),
                isPassing: relayHealthOK && relayHasAPNsCredentials,
                detail: relayHealthOK && !relayHasAPNsCredentials
                    ? L10n.string("APNs credentials missing on relay")
                    : relayLastHealthResultText
            ),
            BackgroundSetupCheck(
                id: "foreground_connection",
                title: L10n.string("Home Assistant foreground connection working"),
                status: foregroundConnectionWorking ? L10n.string("Working") : L10n.string("Not connected"),
                isPassing: foregroundConnectionWorking,
                detail: foregroundConnectionWorking
                    ? nil
                    : L10n.string("Open the app with Home Assistant connected so foreground automation events can be verified.")
            ),
            BackgroundSetupCheck(
                id: "relay_test_start",
                title: L10n.string("Relay test start request"),
                status: relayTestStartOK ? L10n.string("Sent") : L10n.string("Not sent"),
                isPassing: relayTestStartOK,
                detail: relayTestStartOK
                    ? relayLastAPNsResultText
                    : (relayHealthOK && !relayHasAPNsCredentials
                        ? L10n.string("APNs credentials missing on relay")
                        : (relayDiagnostics.lastAPNSError ?? L10n.string("Relay test start runs after notification, token, registration and health checks pass.")))
            )
        ]

        backgroundSetupChecks = checks
    }

    func refreshEntities() async {
        let generation = connectionGeneration
        if isDemoMode {
            entities = demoProvider.currentEntities()
            saveEntityCacheImmediately()
            restStatus = .connected
            entityFetchStatus = .connected
            webSocketStatus = .idle
            lastRESTError = nil
            lastEntityFetchError = nil
            await refreshAllActivities()
            appendLog("Demo entities refreshed.")
            return
        }

        guard let client, let configuration else { return }

        do {
            entityFetchStatus = .connecting
            let (states, _) = try await client.fetchStates()
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  !isDemoMode
            else { return }
            entities = states
            saveEntityCacheImmediately(states)
            entityFetchStatus = .connected
            lastEntityFetchError = nil
            appendLog("Entity list refreshed: \(states.count) entities.")
            await refreshAllActivities()
        } catch {
            guard generation == connectionGeneration,
                  self.configuration == configuration,
                  !(error is CancellationError)
            else { return }
            let message = userFacingMessage(error)
            entityFetchStatus = .failed
            lastEntityFetchError = message
            appendLog("Refresh failed: \(message)")
        }
    }

    private var entityControlHomeAssistantInstanceID: String? {
        guard let localInstanceID = homeAssistantInstanceID,
              HomeAssistantInstanceIdentity.isSafeIdentifier(localInstanceID)
        else {
            return nil
        }
        return managedRelayInstanceIDStore.canonicalInstanceID(for: localInstanceID)
            ?? localInstanceID
    }

    func startLiveActivity(draft: LiveActivityDraft) async throws {
        try await liveActivityManager.start(
            draft: draft,
            allowsRemotePushUpdates: isDemoMode ? false : relaySettings.isRegistrationReady,
            entityControlHomeAssistantInstanceID: entityControlHomeAssistantInstanceID,
            homeAssistantInstanceID: entityControlHomeAssistantInstanceID
        )
        syncActivities()
        appendLog("Started Live Activity for \(draft.primaryEntity.entityId).")
    }

    func startLiveActivity(
        build: EntityLiveActivityBuild,
        endExistingActivity: Bool = false,
        allowsEntityControl: Bool? = nil
    ) async throws {
        try await liveActivityManager.start(
            build: build,
            allowsRemotePushUpdates: isDemoMode ? false : relaySettings.isRegistrationReady,
            endExistingActivity: endExistingActivity,
            allowsEntityControl: allowsEntityControl,
            entityControlHomeAssistantInstanceID: entityControlHomeAssistantInstanceID,
            homeAssistantInstanceID: entityControlHomeAssistantInstanceID
        )
        syncActivities()
        appendLog("Started or updated Live Activity \(build.activityId) for \(build.draft.primaryEntity.entityId).")
    }

    func refreshActivity(recordId: String) async {
        do {
            try await liveActivityManager.refresh(recordId: recordId, allEntities: entities)
            syncActivities()
            appendLog("Manually refreshed Live Activity \(recordId).")
        } catch {
            lastErrorMessage = userFacingMessage(error)
        }
    }

    func endActivity(recordId: String) async {
        do {
            try await liveActivityManager.end(recordId: recordId)
            syncActivities()
            appendLog("Ended Live Activity \(recordId).")
        } catch {
            lastErrorMessage = userFacingMessage(error)
        }
    }

    func testCurrentConnection(
        baseURLString: String,
        token: String,
        displayName: String? = nil,
        internalURLString: String? = nil,
        externalURLString: String? = nil
    ) async -> Bool {
        do {
            let url = try HomeAssistantURLNormalizer.normalize(baseURLString)
            let internalURL = try Self.optionalNormalizedURL(internalURLString)
            let externalURL = try Self.optionalNormalizedURL(externalURLString)
            let effectiveToken = try existingTokenIfNeeded(token)

            // A connection test must not replace or downgrade the active
            // connection. The resolver owns temporary configuration/client
            // instances and only the test-specific result is published.
            lastConnectionTestResultLabel = nil
            lastConnectionTestSucceeded = nil
            let draftConfiguration = ConnectionConfiguration(
                baseURL: url,
                token: effectiveToken,
                displayName: displayName ?? configuration?.displayName,
                internalURL: internalURL,
                externalURL: externalURL
            )
            let resolver = HomeAssistantConnectionResolver(configuration: draftConfiguration)
            let resolved = try await resolver.resolve()
            let message = L10n.format("Connection test succeeded via %@.", resolved.candidate.localizedRoleLabel)
            appendLog("\(message) HTTP \(resolved.debug.statusCode).")
            lastConnectionTestResultLabel = message
            lastConnectionTestSucceeded = true
            return true
        } catch {
            let message = userFacingMessage(error)
            lastConnectionTestResultLabel = L10n.format("Connection test failed: %@", message)
            lastConnectionTestSucceeded = false
            appendLog("Connection test failed: \(message)")
            return false
        }
    }

    func saveCurrentConnection(
        baseURLString: String,
        token: String,
        displayName: String? = nil,
        internalURLString: String? = nil,
        externalURLString: String? = nil
    ) async -> Bool {
        do {
            try await connect(
                baseURLString: baseURLString,
                token: token,
                displayName: displayName ?? configuration?.displayName,
                internalURLString: internalURLString,
                externalURLString: externalURLString,
                persist: true
            )
            return true
        } catch {
            connectionState = .failed(userFacingMessage(error))
            lastErrorMessage = userFacingMessage(error)
            appendLog("Connection save failed: \(error.localizedDescription)")
            return false
        }
    }

    private static func optionalNormalizedURL(_ value: String?) throws -> URL? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return try HomeAssistantURLNormalizer.normalize(trimmed)
    }

    private func existingTokenIfNeeded(_ enteredToken: String) throws -> String {
        let trimmedToken = enteredToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty {
            return trimmedToken
        }

        if let existingToken = configuration?.token.trimmingCharacters(in: .whitespacesAndNewlines),
           !existingToken.isEmpty {
            return existingToken
        }

        if let existingToken = connectionBeforeDemo?.token.trimmingCharacters(in: .whitespacesAndNewlines),
           !existingToken.isEmpty {
            return existingToken
        }

        if let storedToken = try credentialStore.load()?.token.trimmingCharacters(in: .whitespacesAndNewlines),
           !storedToken.isEmpty {
            return storedToken
        }

        throw HALiveKitError.missingCredentials
    }

    func clearCredentials() {
        do {
            try relayRegistrar.unregisterAndClearManagedDeviceCredential()
            _ = beginConnectionTransition()
            try credentialStore.clear()
            demoSimulationTask?.cancel()
            UserDefaults.standard.set(false, forKey: HALiveKitDefaults.demoModeEnabledKey)
            client = nil
            configuration = nil
            connectionBeforeDemo = nil
            homeAssistantInstanceID = nil
            try relayRegistrar.updateHomeAssistantContext(instanceID: nil, friendlyDeviceName: nil)
            entities = []
            clearEntityCache(removeAll: true)
            restStatus = .idle
            webSocketStatus = .idle
            entityFetchStatus = .idle
            lastRESTError = nil
            lastWebSocketError = nil
            lastEntityFetchError = nil
            lastConnectionTestResultLabel = nil
            lastConnectionTestSucceeded = nil
            lastReceivedEventAt = nil
            lastReceivedEventType = nil
            subscribedEventTypes = []
            connectionState = .disconnected
            appendLog("Credentials cleared.")
        } catch {
            lastErrorMessage = userFacingMessage(error)
        }
    }

    func startDemoMode(persist: Bool = true) {
        if !isDemoMode {
            do {
                connectionBeforeDemo = try credentialStore.load() ?? configuration
            } catch {
                connectionBeforeDemo = configuration
                appendLog("Stored Home Assistant connection could not be staged before Demo Mode: \(userFacingMessage(error))")
            }
        }

        demoSimulationTask?.cancel()
        _ = beginConnectionTransition()
        entityCacheStore.activateScope("demo")
        client = nil
        configuration = nil
        homeAssistantInstanceID = nil
        try? relayRegistrar.updateHomeAssistantContext(instanceID: nil, friendlyDeviceName: nil)
        entities = demoProvider.reset()
        saveEntityCacheImmediately()
        restStatus = .connected
        entityFetchStatus = .connected
        webSocketStatus = .idle
        lastErrorMessage = nil
        lastRESTError = nil
        lastEntityFetchError = nil
        lastWebSocketError = nil
        lastReceivedEventAt = nil
        lastReceivedEventType = nil
        subscribedEventTypes = []
        foregroundUpdateNotice = nil
        connectionState = .demo
        if persist {
            UserDefaults.standard.set(true, forKey: HALiveKitDefaults.demoModeEnabledKey)
        }
        appendLog("Demo Mode started with \(entities.count) entities.")
    }

    func exitDemoMode() async {
        guard isDemoMode else { return }
        demoSimulationTask?.cancel()
        UserDefaults.standard.set(false, forKey: HALiveKitDefaults.demoModeEnabledKey)
        entities = []
        clearEntityCache(removeAll: true)
        entityCacheStore.activateScope(nil)
        restStatus = .idle
        entityFetchStatus = .idle
        webSocketStatus = .idle
        homeAssistantInstanceID = nil
        try? relayRegistrar.updateHomeAssistantContext(instanceID: nil, friendlyDeviceName: nil)

        let storedConfiguration: ConnectionConfiguration?
        do {
            if let connectionBeforeDemo {
                storedConfiguration = connectionBeforeDemo
            } else {
                storedConfiguration = try credentialStore.load()
            }
        } catch {
            let message = userFacingMessage(error)
            lastErrorMessage = message
            connectionState = .failed(message)
            appendLog("Demo Mode ended, but the stored Home Assistant connection could not be loaded: \(message)")
            return
        }

        guard let storedConfiguration else {
            connectionState = .disconnected
            appendLog("Demo Mode ended. Ready for a real Home Assistant connection.")
            return
        }

        appendLog("Demo Mode ended. Restoring the previous Home Assistant connection.")
        do {
            try await connect(
                baseURLString: storedConfiguration.baseURL.absoluteString,
                token: storedConfiguration.token,
                displayName: storedConfiguration.displayName,
                internalURLString: storedConfiguration.internalURL?.absoluteString,
                externalURLString: storedConfiguration.externalURL?.absoluteString,
                persist: false
            )
        } catch {
            // connect(...) owns the user-visible failure state. Keep the saved
            // credential intact so the user can retry or edit it.
            appendLog("Previous Home Assistant connection could not be restored after Demo Mode.")
        }
    }

    func dismissLastError() {
        lastErrorMessage = nil
    }

    func runDemoScenario(_ scenario: DemoScenario) async {
        if !isDemoMode {
            startDemoMode()
        }

        let payload = demoProvider.apply(scenario)
        entities = demoProvider.currentEntities()
        saveEntityCacheImmediately()

        do {
            try await applyDemoPayload(payload)
            appendLog("Demo scenario applied: \(scenario.title).")

            if scenario == .laundryRunning {
                startDemoLaundrySimulation()
            }
        } catch {
            lastErrorMessage = userFacingMessage(error)
            appendLog("Demo scenario failed: \(userFacingMessage(error))")
        }
    }

    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            acceptsForegroundActivityRequests = true
            if let lastEnteredBackgroundAt,
               Date.now.timeIntervalSince(lastEnteredBackgroundAt) > 60,
               !activeActivities.isEmpty {
                appendLog("App returned from background; refreshing entities and Live Activities.")
            }
            foregroundUpdateNotice = nil
            if preferencesStore.iCloudSyncEnabled {
                cloudKitMirror.pull()
            }
            Task {
                await refreshNotificationPermissionStatus()
                await refreshAfterForegroundActivation()
                scheduleBackgroundRegistrationRetry()
            }
        case .background:
            acceptsForegroundActivityRequests = false
            lastEnteredBackgroundAt = .now
            saveEntityCacheImmediately()
            appendLog("App moved to background. iOS may pause the foreground WebSocket.")
        case .inactive:
            acceptsForegroundActivityRequests = false
        @unknown default:
            acceptsForegroundActivityRequests = false
        }
    }

    private func applyEntityUpdate(_ entity: HAEntity, connectionID: UUID) async {
        guard isCurrentWebSocketConnection(connectionID) else { return }
        if let index = entities.firstIndex(where: { $0.entityId == entity.entityId }) {
            entities[index] = entity
        } else if HAEntityDomain.allCases.dropLast().contains(entity.domain) {
            entities.append(entity)
            entities.sort { $0.entityId.localizedStandardCompare($1.entityId) == .orderedAscending }
        }
        scheduleEntityCacheSave()

        await liveActivityManager.updateActivities(for: entity, allEntities: entities)
        guard isCurrentWebSocketConnection(connectionID) else { return }
        syncActivities()
    }

    private func scheduleEntityCacheSave() {
        entityCacheSaveTask?.cancel()
        let snapshot = entities
        entityCacheSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 750_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.entityCacheStore.save(snapshot)
            self.entityCacheSaveTask = nil
        }
    }

    private func saveEntityCacheImmediately(_ snapshot: [HAEntity]? = nil) {
        entityCacheSaveTask?.cancel()
        let values = snapshot ?? entities
        entityCacheSaveTask = Task { [weak self] in
            guard let self else { return }
            await self.entityCacheStore.save(values)
            self.entityCacheSaveTask = nil
        }
    }

    private func clearEntityCache(removeAll: Bool = false) {
        entityCacheSaveTask?.cancel()
        entityCacheSaveTask = Task { [weak self] in
            guard let self else { return }
            if removeAll {
                await self.entityCacheStore.clearAll()
            } else {
                await self.entityCacheStore.clearActiveScope()
            }
            self.entityCacheSaveTask = nil
        }
    }

    private func applyActivityRequest(
        _ request: HALiveKitActivityRequest,
        connectionID: UUID
    ) async {
        guard isCurrentWebSocketConnection(connectionID),
              shouldAcceptActivityRequest(request)
        else {
            appendLog("Ignored HA LiveKit request \(request.activityId) for another device.")
            return
        }
        guard acceptsForegroundActivityRequests else {
            appendLog(
                "Ignored HA LiveKit foreground request \(request.activityId) while the app was not active; background relay delivery remains authoritative."
            )
            return
        }

        do {
            try requireCurrentWebSocketConnection(connectionID)
            switch request.action {
            case .start:
                if request.isEntityBased {
                    let build = entityActivityBuild(for: request)
                    try await liveActivityManager.start(
                        build: build,
                        allowsRemotePushUpdates: relaySettings.isRegistrationReady,
                        endExistingActivity: false,
                        allowsEntityControl: request.allowsEntityControl,
                        entityControlHomeAssistantInstanceID: entityControlHomeAssistantInstanceID,
                        homeAssistantInstanceID: entityControlHomeAssistantInstanceID
                    )
                    try requireCurrentWebSocketConnection(connectionID)
                    appendLog("HA entity service started or updated Live Activity \(build.activityId).")
                    break
                }

                let entity = entityForActivityRequest(request)
                let templateDefaults: LiveActivityTemplate?
                if request.isEntityBased {
                    templateDefaults = LiveActivityTemplate.defaults.first(where: { $0.id == (request.template ?? .custom) })
                } else {
                    templateDefaults = nil
                }
                let title = request.title ?? templateDefaults?.title ?? request.displayName ?? entity.friendlyName
                let subtitle = request.subtitle ?? templateDefaults?.subtitle ?? entity.state
                let displayName = request.displayName ?? entity.friendlyName
                let value = request.requestedValue ?? request.state

                if liveActivityManager.contains(recordId: request.activityId) {
                    try await liveActivityManager.update(
                        recordId: request.activityId,
                        title: title,
                        subtitle: subtitle,
                        displayName: displayName,
                        primaryState: request.state,
                        secondaryState: request.requestedSecondaryState,
                        progress: request.progress,
                        value: value,
                        unit: request.requestedUnit
                    )
                    try requireCurrentWebSocketConnection(connectionID)
                    appendLog("HA service refreshed existing Live Activity \(request.activityId).")
                    break
                }

                let draft = LiveActivityDraft(
                    activityId: request.activityId,
                    title: title,
                    subtitle: subtitle,
                    displayName: displayName,
                    primaryEntity: entity,
                    secondaryEntity: nil,
                    displayStyle: request.requestedDisplayStyle,
                    template: request.template ?? .custom,
                    iconName: request.requestedIconName ?? templateDefaults?.iconName ?? entity.suggestedIconName,
                    theme: request.requestedTheme
                )
                try await liveActivityManager.start(
                    draft: draft,
                    allowsRemotePushUpdates: relaySettings.isRegistrationReady,
                    allowsEntityControl: request.allowsEntityControl,
                    entityControlHomeAssistantInstanceID: entityControlHomeAssistantInstanceID,
                    homeAssistantInstanceID: entityControlHomeAssistantInstanceID
                )
                try requireCurrentWebSocketConnection(connectionID)
                if request.state != nil || request.progress != nil {
                    try await liveActivityManager.update(
                        recordId: request.activityId,
                        title: nil,
                        subtitle: nil,
                        displayName: nil,
                        primaryState: request.state,
                        secondaryState: request.requestedSecondaryState,
                        progress: request.progress,
                        value: value,
                        unit: request.requestedUnit
                    )
                    try requireCurrentWebSocketConnection(connectionID)
                }
                appendLog("HA service started Live Activity \(request.activityId).")

            case .update:
                if request.isEntityBased {
                    let build = entityActivityBuild(for: request)
                    try await liveActivityManager.update(recordId: build.activityId, state: build.contentState)
                    try requireCurrentWebSocketConnection(connectionID)
                    appendLog("HA entity service updated Live Activity \(build.activityId).")
                    break
                }

                try await liveActivityManager.update(
                    recordId: request.activityId,
                    title: request.title,
                    subtitle: request.subtitle,
                    displayName: request.displayName,
                    primaryState: request.state,
                    secondaryState: request.requestedSecondaryState,
                    progress: request.progress,
                    value: request.requestedValue ?? request.state,
                    unit: request.requestedUnit
                )
                try requireCurrentWebSocketConnection(connectionID)
                appendLog("HA service updated Live Activity \(request.activityId).")

            case .end:
                try await liveActivityManager.end(recordId: request.activityId)
                try requireCurrentWebSocketConnection(connectionID)
                appendLog("HA service ended Live Activity \(request.activityId).")
            }

            syncActivities()
        } catch {
            guard isCurrentWebSocketConnection(connectionID),
                  !(error is CancellationError)
            else { return }
            guard acceptsForegroundActivityRequests else {
                appendLog(
                    "HA LiveKit foreground request \(request.activityId) stopped after the app left the foreground: \(error.localizedDescription)"
                )
                return
            }
            lastErrorMessage = userFacingMessage(error)
            appendLog("HA LiveKit service request failed: \(error.localizedDescription)")
        }
    }

    private func isCurrentWebSocketConnection(_ connectionID: UUID) -> Bool {
        webSocketConnectionID == connectionID && !isDemoMode && configuration != nil
    }

    private func requireCurrentWebSocketConnection(_ connectionID: UUID) throws {
        try Task.checkCancellation()
        guard isCurrentWebSocketConnection(connectionID) else {
            throw CancellationError()
        }
    }

    private func shouldAcceptActivityRequest(_ request: HALiveKitActivityRequest) -> Bool {
        guard let deviceId = request.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !deviceId.isEmpty
        else {
            return true
        }

        return deviceId.caseInsensitiveCompare(clientDeviceID) == .orderedSame
    }

    private func entityForActivityRequest(_ request: HALiveKitActivityRequest) -> HAEntity {
        if request.isEntityBased {
            return entityFromEntityBasedRequest(request)
        }

        if let entityId = request.entityId,
           let entity = entities.first(where: { $0.entityId == entityId }) {
            return entity
        }

        let entityId = request.entityId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? request.entityId!
            : "ha_livekit.\(request.activityId)"

        return HAEntity(
            entityId: entityId,
            state: request.requestedValue ?? request.state ?? "unknown",
            attributes: HAEntityAttributes(
                friendlyName: request.displayName ?? request.title ?? entityId,
                icon: nil,
                unitOfMeasurement: request.requestedUnit,
                deviceClass: request.requestedDeviceClass,
                batteryLevel: request.requestedBatteryLevel,
                currentTemperature: request.requestedCurrentTemperature,
                temperature: request.requestedTargetTemperature,
                hvacMode: request.requestedHVACMode
            ),
            lastChanged: .now,
            lastUpdated: .now
        )
    }

    private func entityActivityBuild(for request: HALiveKitActivityRequest) -> EntityLiveActivityBuild {
        let entity = entityForActivityRequest(request)
        let progressEntity = request.requestedProgressEntityID.flatMap { progressEntityID in
            entities.first(where: { $0.entityId == progressEntityID })
        }

        return EntityLiveActivityBuilder.build(
            EntityLiveActivityBuildInput(
                activityId: request.activityId,
                primaryEntity: entity,
                secondaryEntity: nil,
                progressEntity: progressEntity,
                template: request.template ?? EntityLiveActivityBuilder.inferredTemplate(for: entity, progressEntity: progressEntity),
                displayStyle: request.requestedDisplayStyle,
                displayName: request.displayName ?? request.requestedFriendlyName,
                title: request.title,
                subtitle: request.subtitle,
                iconName: request.requestedIconName,
                theme: request.requestedTheme,
                progress: request.progress,
                source: .homeAssistant
            )
        )
    }

    private func entityFromEntityBasedRequest(_ request: HALiveKitActivityRequest) -> HAEntity {
        let entityId = request.entityId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? request.entityId!
            : "ha_livekit.\(request.activityId)"
        let cached = entities.first { $0.entityId == entityId }
        let rawState = request.requestedValue ?? request.requestedRawState ?? cached?.state ?? request.state ?? "unknown"
        let attributes = HAEntityAttributes(
            friendlyName: request.displayName ?? request.requestedFriendlyName ?? cached?.friendlyName ?? request.title ?? entityId,
            icon: cached?.attributes.icon,
            unitOfMeasurement: request.requestedUnit ?? request.requestedUnitOfMeasurement ?? cached?.displayUnit,
            deviceClass: request.requestedDeviceClass ?? cached?.attributes.deviceClass,
            batteryLevel: request.requestedBatteryLevel ?? cached?.attributes.batteryLevel,
            currentTemperature: request.requestedCurrentTemperature ?? cached?.attributes.currentTemperature,
            temperature: request.requestedTargetTemperature ?? cached?.attributes.temperature,
            hvacMode: request.requestedHVACMode ?? cached?.attributes.hvacMode,
            brightness: request.requestedBrightness ?? cached?.attributes.brightness,
            currentPosition: request.requestedCurrentPosition ?? cached?.attributes.currentPosition,
            progress: request.requestedAttributeProgress ?? cached?.attributes.progress,
            percentage: request.requestedPercentage ?? cached?.attributes.percentage,
            remaining: request.requestedRemaining ?? cached?.attributes.remaining,
            remainingTime: request.requestedRemainingTime ?? cached?.attributes.remainingTime,
            room: request.requestedRoom ?? cached?.attributes.room,
            status: request.requestedStatus ?? cached?.attributes.status
        )
        return HAEntity(
            entityId: entityId,
            state: rawState,
            attributes: attributes,
            lastChanged: cached?.lastChanged ?? .now,
            lastUpdated: .now
        )
    }

    private func refreshAllActivities() async {
        for record in activeActivities {
            try? await liveActivityManager.refresh(recordId: record.id, allEntities: entities)
        }
        syncActivities()
    }

    private func refreshAfterForegroundActivation() async {
        await reconcileDuplicateActivities()

        if isDemoMode {
            await refreshEntities()
            return
        }

        await refreshEntities()
        await connectForegroundEventStream()
    }

    private func syncActivities() {
        liveActivityManager.syncFromSystem()
        activeActivities = liveActivityManager.activeActivities
        relayRegistrar.observeActiveActivities()
    }

    private func reconcileDuplicateActivities() async {
        await liveActivityManager.reconcileDuplicateActivities()
        syncActivities()
    }

    private func connectForegroundEventStream() async {
        guard case .connected = connectionState, let configuration else { return }
        let generation = connectionGeneration
        let connectionID = UUID()
        webSocketConnectionID = connectionID

        do {
            webSocketStatus = .connecting
            lastWebSocketError = nil
            try await webSocketManager.connect(
                configuration: configuration,
                connectionID: connectionID
            )
            guard generation == connectionGeneration,
                  webSocketConnectionID == connectionID,
                  self.configuration == configuration
            else { return }
        } catch {
            guard generation == connectionGeneration,
                  webSocketConnectionID == connectionID,
                  self.configuration == configuration,
                  !(error is CancellationError)
            else { return }
            let message = userFacingMessage(error)
            webSocketStatus = .failed
            lastWebSocketError = message
            foregroundUpdateNotice = "REST connected, WebSocket disconnected. Entity browsing and manual Live Activities work; live foreground updates will retry in the background."
            appendLog("Foreground WebSocket unavailable: \(message)")
        }
    }

    @discardableResult
    private func beginConnectionTransition() -> UInt64 {
        connectionGeneration &+= 1
        webSocketConnectionID = nil
        pendingManagedRelayCredential = nil
        managedRelayDevices = []
        managedRelayDevicesError = nil
        isLoadingManagedRelayDevices = false
        revokingManagedRelayDeviceID = nil
        haLiveKitIntegrationStatus = nil
        haLiveKitIntegrationNeedsUpdate = false
        haLiveKitIntegrationStatusError = nil
        isCheckingHALiveKitIntegration = false
        entityCacheStore.activateScope(nil)
        webSocketManager.disconnect()
        return connectionGeneration
    }

    private func requireCurrentConnectionGeneration(_ generation: UInt64) throws {
        try Task.checkCancellation()
        guard generation == connectionGeneration else {
            throw CancellationError()
        }
    }

    private static func loadClientDeviceID() -> String {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: deviceIDDefaultsKey),
           !existing.isEmpty {
            return existing
        }

        let generated = UUID().uuidString.lowercased()
        defaults.set(generated, forKey: deviceIDDefaultsKey)
        return generated
    }

    private func appendLog(_ line: String) {
        let sanitizedMessage = sanitizeLogMessage(line)
        guard !sanitizedMessage.isEmpty else { return }

        if let latest = debugLogs.first,
           latest.message == sanitizedMessage {
            debugLogs[0] = DebugLogEntry(
                id: latest.id,
                timestamp: .now,
                message: sanitizedMessage,
                repetitionCount: latest.repetitionCount + 1
            )
        } else {
            debugLogs.insert(DebugLogEntry(message: sanitizedMessage), at: 0)
        }

        if debugLogs.count > 80 {
            debugLogs.removeLast(debugLogs.count - 80)
        }
    }

    private func userFacingMessage(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private func httpStatusCode(from error: Error) -> Int? {
        if case ManagedRelayPairingError.rejected(let statusCode, _) = error {
            return statusCode
        }
        if case ManagedRelayPairingError.administratorRequired = error {
            return 403
        }
        if case HALiveKitError.httpStatus(let statusCode) = error {
            return statusCode
        }
        if case HALiveKitError.invalidToken = error {
            return 401
        }
        if case HALiveKitError.unauthorized = error {
            return 403
        }
        return nil
    }

    private func sanitizeLogMessage(_ line: String) -> String {
        LogSanitizer.sanitizeLogMessage(line, secrets: sensitiveLogValues)
    }

    private var sensitiveLogValues: [String] {
        [
            configuration?.token,
            relaySettings.registrationSecret,
            relaySettings.sharedSecret,
            ManagedRelayConfig.current.appRegistrationKey
        ].compactMap { $0 }
    }

    var redactedDebugLogs: [DebugLogEntry] {
        debugLogs.map { entry in
            DebugLogEntry(
                id: entry.id,
                timestamp: entry.timestamp,
                message: sanitizeLogMessage(entry.message),
                repetitionCount: entry.repetitionCount
            )
        }
    }

    var redactedDebugLogsText: String {
        redactedDebugLogs
            .map { sanitizeLogMessage($0.formattedLine) }
            .joined(separator: "\n")
    }

    /// Current-launch support history with a deliberately tiny data surface.
    /// The export contains no raw messages or timestamps, and is never stored.
    var privacySafeSupportLogsText: String {
        let entries = debugLogs.reversed().suffix(40)
        let summaries = entries.enumerated().map { index, entry in
            let summary = LogSanitizer.privacySafeSupportEventSummary(
                entry.message,
                secrets: sensitiveLogValues
            )
            let boundedRepetition = min(entry.repetitionCount, 999)
            let repetition = boundedRepetition > 1 ? " (repeated \(boundedRepetition)x)" : ""
            return "\(index + 1). \(summary)\(repetition)"
        }

        let header = [
            "HA LiveKit privacy-protected support events",
            "Raw messages, timestamps, names, identifiers, URLs, IP addresses, credentials, server responses and error details are excluded."
        ]
        let body = summaries.isEmpty ? ["No support events recorded."] : summaries
        return (header + [""] + body).joined(separator: "\n")
    }

    var redactedHomeAssistantInstanceID: String {
        LogSanitizer.redactedInstanceID(homeAssistantInstanceID)
    }

    var diagnosticsText: String {
        let lines = [
            "HA LiveKit Diagnostics",
            "Mode: \(isDemoMode ? L10n.string("Demo Mode") : L10n.string("Home Assistant"))",
            "REST status: \(restStatus.title)",
            "WebSocket status: \(webSocketStatus.title)",
            "Entity fetch status: \(entityFetchStatus.title)",
            "Display Name: \(homeDisplayName)",
            "Normalized URL: \(isDemoMode ? "demo://home" : configuration?.redactedURLString ?? L10n.string("not connected"))",
            "WebSocket URL: \(configuration.flatMap { HomeAssistantWebSocketManager.redactedWebSocketURLString(from: $0.baseURL) } ?? L10n.string("not connected"))",
            "Client Device ID: \(clientDeviceID)",
            "Home Assistant instance ID: \(redactedHomeAssistantInstanceID)",
            "Last REST error: \(lastRESTError ?? L10n.string("none"))",
            "Last WebSocket error: \(lastWebSocketError ?? L10n.string("none"))",
            "Last entity fetch error: \(lastEntityFetchError ?? L10n.string("none"))",
            "Last received event: \(lastReceivedEventDescription)",
            "Subscribed events: \(subscribedEventTypes.isEmpty ? L10n.string("none") : subscribedEventTypes.joined(separator: ", "))",
            "HA LiveKit integration subscription: \(integrationSubscriptionStatusText)",
            "Entity count: \(entities.count)",
            "Active activities: \(activeActivities.count)",
            "Running on simulator: \(runningOnSimulatorText.lowercased())",
            "ActivityKit available: \(activityKitAvailableText.lowercased())",
            "APNs mode: \(relayDiagnostics.mode.rawValue)",
            "Relay authentication: \(relayDiagnostics.authenticationProtocol.rawValue)",
            "APNs entitlement: \(apnsEntitlementStatusText)",
            "Push Notifications entitlement present: \(pushNotificationsEntitlementPresentText.lowercased())",
            "Notification permission: \(notificationAuthorizationStatus)",
            "Live Activities available: \(liveActivitiesAvailableText)",
            "Live Activities enabled: \(liveActivitiesEnabledText)",
            "Push-to-start listener: \(relayDiagnostics.isObservingPushToStartToken ? L10n.string("active") : L10n.string("inactive"))",
            "Push-to-start token available: \(relayDiagnostics.pushToStartTokenAvailable ? L10n.string("yes") : L10n.string("no"))",
            "Push-to-start token: \(relayDiagnostics.pushToStartTokenAvailable ? L10n.string("available") : L10n.string("unavailable"))",
            "Last push-to-start token update: \(formattedDate(relayDiagnostics.lastPushToStartTokenUpdateAt))",
            "Last activity update token: \(formattedDate(relayDiagnostics.lastActivityTokenUpdateAt))",
            "Push token wait reason: \(pushTokenUnavailableReasonText ?? L10n.string("none"))",
            "Relay source: \(relaySettings.relaySourceTitle)",
            "Managed relay configured in build: \(ManagedRelayConfig.current.isManagedRelayAvailable ? L10n.string("yes") : L10n.string("no"))",
            "Managed relay URL present: \(ManagedRelayConfig.current.hasManagedRelayURL ? L10n.string("yes") : L10n.string("no"))",
            "Managed relay URL: \(ManagedRelayConfig.current.redactedManagedRelayURL)",
            "Relay URL: \(relaySettings.redactedRelayURL)",
            "Relay status: \(relayChecklistStatus)",
            "Relay registered: \(relayDiagnostics.relayRegistered ? L10n.string("yes") : L10n.string("no"))",
            "HA pairing ticket: \(relayDiagnostics.homeAssistantPairingTicketStatus.rawValue)",
            "Worker device credential: \(relayDiagnostics.workerDeviceCredentialAvailable ? L10n.string("available") : L10n.string("unavailable"))",
            "Last relay registration attempt: \(formattedDate(relayDiagnostics.lastRegistrationAttemptAt))",
            "Last relay registration HTTP: \(relayDiagnostics.lastRegistrationStatusCode.map(String.init) ?? L10n.string("none"))",
            "Last relay registration response: \(relayDiagnostics.lastRegistrationResponseSummary ?? L10n.string("none"))",
            "Last relay registration error: \(relayDiagnostics.lastRegistrationError ?? L10n.string("none"))",
            "Relay credential received: \(relayCredentialReceivedText.lowercased())",
            "HA credential install: \(managedRelayCredentialInstallStatusText)",
            "Last HA configure attempt: \(formattedDate(lastManagedRelayCredentialInstallAttemptAt))",
            "Last HA configure HTTP: \(lastManagedRelayConfigureStatusText)",
            "Last HA configure error: \(lastManagedRelayCredentialInstallError ?? L10n.string("none"))",
            "Last relay health check: \(formattedDate(relayDiagnostics.lastHealthCheckedAt))",
            "Last relay health HTTP: \(relayDiagnostics.lastHealthStatusCode.map(String.init) ?? L10n.string("none"))",
            "Last relay health response: \(relayDiagnostics.lastHealthResponseSummary ?? L10n.string("none"))",
            "Last relay health error: \(relayDiagnostics.lastHealthError ?? L10n.string("none"))",
            "Last APNs relay test: \(formattedDate(relayDiagnostics.lastAPNsAttemptAt))",
            "Last APNs relay HTTP: \(relayDiagnostics.lastAPNsStatusCode.map(String.init) ?? L10n.string("none"))",
            "Last APNs relay response: \(relayDiagnostics.lastAPNsResponseSummary ?? L10n.string("none"))",
            "Last APNs relay error: \(relayDiagnostics.lastAPNSError ?? L10n.string("none"))",
            "Background Live Activities: \(backgroundUpdatesStatusText)"
        ]
        return lines.map(sanitizeLogMessage).joined(separator: "\n")
    }

    var backgroundUpdatesStatusText: String {
        if isDemoMode {
            return L10n.string("Demo Mode uses local ActivityKit start and update calls only. APNs relay and Home Assistant credentials are not required.")
        }
        return backgroundLiveActivitiesStatus.message
    }

    var backgroundUpdatesSettingsStatus: String {
        if relayDiagnostics.registrationEnvironmentMismatch {
            return L10n.string("TestFlight Required")
        }

        switch backgroundLiveActivitiesStatus {
        case .ready:
            return L10n.string("Ready")
        case .needsNotificationPermission, .notificationsDisabled:
            return L10n.string("Needs notification permission")
        case .setupNeeded:
            return L10n.string("Waiting for device registration")
        case .liveActivitiesDisabled, .relayNotReady, .error:
            return backgroundLiveActivitiesStatus.title
        }
    }

    var backgroundUpdatesSettingsDetail: String {
        if relayDiagnostics.registrationEnvironmentMismatch,
           let error = relayDiagnostics.lastRegistrationError {
            return error
        }

        switch backgroundLiveActivitiesStatus {
        case .ready:
            return L10n.string("Background updates are ready.")
        case .needsNotificationPermission, .notificationsDisabled:
            return L10n.string("Enable notifications to finish setup.")
        case .setupNeeded:
            return L10n.string("Push-to-start token has not been received yet.")
        case .liveActivitiesDisabled, .relayNotReady, .error:
            return relayDiagnostics.lastRegistrationError ?? backgroundLiveActivitiesStatus.message
        }
    }

    var backgroundLiveActivitiesStatus: BackgroundLiveActivitiesStatus {
        if isDemoMode {
            return .ready
        }

        if !areNotificationsAllowed {
            return notificationAuthorizationStatus == "denied" ? .notificationsDisabled : .needsNotificationPermission
        }

        if notificationAuthorizationStatus == "denied" {
            return .notificationsDisabled
        }

        if !liveActivitiesAvailable || !liveActivitiesEnabled {
            return .liveActivitiesDisabled
        }

        if homeAssistantInstanceID == nil {
            return .setupNeeded
        }

        if !relaySettings.isRegistrationReady {
            return .relayNotReady
        }

        if !relayDiagnostics.pushToStartTokenAvailable {
            return .setupNeeded
        }

        if !relayDiagnostics.relayRegistered {
            return relayDiagnostics.lastRegistrationError == nil ? .setupNeeded : .error
        }

        return .ready
    }

    var areNotificationsAllowed: Bool {
        ["authorized", "provisional", "ephemeral"].contains(notificationAuthorizationStatus)
    }

    var notificationPermissionChecklistStatus: String {
        switch notificationAuthorizationStatus {
        case "authorized", "provisional", "ephemeral":
            return L10n.string("Allowed")
        case "denied":
            return L10n.string("Not Allowed")
        case "notDetermined":
            return L10n.string("Not Asked")
        default:
            return L10n.string("Unknown")
        }
    }

    var liveActivitiesChecklistStatus: String {
        liveActivitiesEnabled ? L10n.string("Available") : L10n.string("Disabled")
    }

    var pushTokenChecklistStatus: String {
        relayDiagnostics.pushToStartTokenAvailable ? L10n.string("Available") : L10n.string("Waiting")
    }

    var relayChecklistStatus: String {
        if !relaySettings.isRegistrationReady {
            return L10n.string("Setup Needed")
        }
        if relayDiagnostics.registrationEnvironmentMismatch {
            return L10n.string("TestFlight Required")
        }
        if relayDiagnostics.relayRegistered {
            return L10n.string("Ready")
        }
        if relayDiagnostics.lastRegistrationError != nil {
            return L10n.string("Error")
        }
        return L10n.string("Configured")
    }

    var relayLastRegistrationResultText: String {
        if let statusCode = relayDiagnostics.lastRegistrationStatusCode {
            return "HTTP \(statusCode)"
        }
        if let error = relayDiagnostics.lastRegistrationError {
            return error
        }
        return L10n.string("None")
    }

    var relayLastHealthResultText: String {
        if let statusCode = relayDiagnostics.lastHealthStatusCode {
            return "HTTP \(statusCode)"
        }
        if let error = relayDiagnostics.lastHealthError {
            return error
        }
        return L10n.string("Not checked")
    }

    var relayLastAPNsResultText: String {
        if let statusCode = relayDiagnostics.lastAPNsStatusCode {
            return "HTTP \(statusCode)"
        }
        if let error = relayDiagnostics.lastAPNSError {
            return error
        }
        return L10n.string("Not tested")
    }

    var pushTokenUnavailableReasonText: String? {
        guard !relayDiagnostics.pushToStartTokenAvailable else { return nil }

        if !areNotificationsAllowed {
            return notificationAuthorizationStatus == "denied" ? L10n.string("Notifications denied") : L10n.string("Notifications not allowed yet")
        }
        if !liveActivitiesAvailable {
            return L10n.string("iOS 16.1 or newer is required")
        }
        if !liveActivitiesEnabled {
            return L10n.string("Live Activities disabled")
        }
        if apnsEntitlementStatusText == "Missing" {
            return L10n.string("APNs capability missing")
        }
        if !relaySettings.isRegistrationReady {
            return relaySettings.relayConfigurationIssue ?? L10n.string("Relay not configured")
        }
        if !relayDiagnostics.isObservingPushToStartToken {
            return L10n.string("Push-to-start listener inactive")
        }
        return L10n.string("Waiting for APNs push-to-start token")
    }

    var apnsEntitlementStatusText: String {
        #if targetEnvironment(simulator)
        return "Simulator"
        #else
        guard let profileURL = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let profileText = try? String(contentsOf: profileURL, encoding: .isoLatin1)
        else {
            return "Unknown"
        }

        if profileText.contains("<key>aps-environment</key>") {
            if profileText.contains("<string>development</string>") {
                return "development"
            }
            if profileText.contains("<string>production</string>") {
                return "production"
            }
            return "Present"
        }

        return "Missing"
        #endif
    }

    var homeAssistantConnectionIssueMessage: String? {
        if case .failed(let message) = connectionState {
            return message
        }
        if restStatus == .failed {
            return lastRESTError
        }
        return nil
    }

    var foregroundUpdatesIssueMessage: String? {
        guard !isDemoMode else { return nil }
        switch webSocketStatus {
        case .disconnected, .failed:
            return lastWebSocketError ?? L10n.string("Foreground Home Assistant WebSocket updates are disconnected.")
        default:
            return nil
        }
    }

    var integrationSubscriptionStatusText: String {
        guard !isDemoMode else { return L10n.string("Demo Mode") }
        guard webSocketStatus == .connected else { return L10n.string("Waiting for WebSocket") }
        return subscribedEventTypes.contains("ha_livekit_activity_request") ? L10n.string("Subscribed") : L10n.string("Not subscribed")
    }

    var dashboardConnectivityNotice: String? {
        if isDemoMode {
            return nil
        }

        switch webSocketStatus {
        case .disconnected, .failed:
            return L10n.string("REST is connected, but foreground live updates are reconnecting. Manual refresh still works.")
        default:
            return nil
        }
    }

    var lastReceivedEventDescription: String {
        guard let lastReceivedEventAt else { return L10n.string("none") }
        let eventType = lastReceivedEventType ?? L10n.string("unknown")
        return L10n.format("%@ at %@", eventType, lastReceivedEventAt.formatted(date: .abbreviated, time: .standard))
    }

    var liveActivitiesAvailable: Bool {
        if #available(iOS 16.1, *) {
            return true
        }
        return false
    }

    var liveActivitiesAvailableText: String {
        liveActivitiesAvailable ? L10n.string("Yes") : L10n.string("No")
    }

    var runningOnSimulatorText: String {
        #if targetEnvironment(simulator)
        return L10n.string("Yes")
        #else
        return L10n.string("No")
        #endif
    }

    var activityKitAvailableText: String {
        liveActivitiesAvailableText
    }

    var managedRelayURLPresentText: String {
        ManagedRelayConfig.current.hasManagedRelayURL ? L10n.string("Yes") : L10n.string("No")
    }

    var managedRelayAppKeyPresentText: String {
        ManagedRelayConfig.current.hasAppRegistrationKey ? L10n.string("Yes") : L10n.string("No")
    }

    var pushNotificationsEntitlementPresentText: String {
        switch apnsEntitlementStatusText {
        case "Missing":
            return L10n.string("No")
        case "Simulator", "Unknown":
            return apnsEntitlementStatusText
        default:
            return L10n.string("Yes")
        }
    }

    var relayCredentialReceivedText: String {
        lastManagedRelayCredentialReceivedAt == nil ? L10n.string("No") : L10n.string("Yes")
    }

    var managedRelayCredentialInstallStatusText: String {
        managedRelayCredentialInstallState.title
    }

    var lastManagedRelayConfigureStatusText: String {
        lastManagedRelayCredentialInstallStatusCode.map { "HTTP \($0)" } ?? L10n.string("None")
    }

    var liveActivitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    var liveActivitiesEnabledText: String {
        liveActivitiesEnabled ? L10n.string("Yes") : L10n.string("No")
    }

    func formattedDate(_ date: Date?) -> String {
        guard let date else { return L10n.string("Never") }
        return date.formatted(date: .abbreviated, time: .standard)
    }

    var healthChecklist: HealthChecklist {
        var rows: [HealthChecklistRow] = []

        switch connectionState {
        case .connected:
            rows.append(.init(
                id: "home_assistant",
                title: L10n.string("Home Assistant"),
                status: L10n.string("Connected"),
                state: .ok,
                detail: nil
            ))
        case .demo:
            rows.append(.init(
                id: "home_assistant",
                title: L10n.string("Home Assistant"),
                status: L10n.string("Demo Mode"),
                state: .off,
                detail: L10n.string("Connect a real Home Assistant from Settings to use background updates.")
            ))
        case .connecting:
            rows.append(.init(
                id: "home_assistant",
                title: L10n.string("Home Assistant"),
                status: L10n.string("Connecting"),
                state: .unknown,
                detail: nil
            ))
        case .disconnected, .failed:
            rows.append(.init(
                id: "home_assistant",
                title: L10n.string("Home Assistant"),
                status: L10n.string("Needs attention"),
                state: .attention,
                detail: homeAssistantConnectionIssueMessage
            ))
        }

        let integrationStatus = haLiveKitIntegrationNeedsUpdate
            ? L10n.string("Update required")
            : integrationSubscriptionStatusText
        let integrationHealthy = !haLiveKitIntegrationNeedsUpdate
            && integrationSubscriptionStatusText == L10n.string("Subscribed")
        rows.append(.init(
            id: "integration",
            title: L10n.string("Integration"),
            status: integrationStatus,
            state: integrationHealthy ? .ok : .attention,
            detail: integrationHealthy
                ? nil
                : (haLiveKitIntegrationNeedsUpdate
                    ? HALiveKitError.integrationUpdateRequired.errorDescription
                    : L10n.string("Install or update the HA LiveKit Home Assistant integration to enable automation triggers."))
        ))

        let backgroundUpdatesState: HealthRowState = relayDiagnostics.registrationEnvironmentMismatch
            ? .info
            : (backgroundLiveActivitiesStatus == .ready ? .ok : .attention)
        rows.append(.init(
            id: "background_updates",
            title: L10n.string("Background Updates"),
            status: backgroundUpdatesSettingsStatus,
            state: backgroundUpdatesState,
            detail: backgroundLiveActivitiesStatus == .ready ? nil : backgroundUpdatesSettingsDetail
        ))

        rows.append(.init(
            id: "notifications",
            title: L10n.string("Notifications"),
            status: notificationPermissionChecklistStatus,
            state: areNotificationsAllowed ? .ok : .attention,
            detail: areNotificationsAllowed ? nil : L10n.string("Allow notifications in iOS Settings to use background Live Activities.")
        ))

        rows.append(.init(
            id: "live_activities",
            title: L10n.string("Live Activities"),
            status: liveActivitiesChecklistStatus,
            state: liveActivitiesEnabled ? .ok : .attention,
            detail: liveActivitiesEnabled ? nil : L10n.string("Enable Live Activities for HA LiveKit in iOS Settings.")
        ))

        rows.append(.init(
            id: "push_token",
            title: L10n.string("Push Token"),
            status: pushTokenChecklistStatus,
            state: relayDiagnostics.pushToStartTokenAvailable ? .ok : .attention,
            detail: relayDiagnostics.pushToStartTokenAvailable ? nil : pushTokenUnavailableReasonText
        ))

        let relayStatus = relayChecklistStatus
        let relayState: HealthRowState = relayDiagnostics.registrationEnvironmentMismatch
            ? .info
            : (relayStatus == L10n.string("Ready") ? .ok : .attention)
        rows.append(.init(
            id: "relay",
            title: L10n.string("Relay"),
            status: relayStatus,
            state: relayState,
            detail: relayStatus == L10n.string("Ready")
                ? nil
                : (relaySettings.relayConfigurationIssue ?? relayDiagnostics.lastRegistrationError)
        ))

        let shortcutsAvailable = liveActivitiesAvailable
        rows.append(.init(
            id: "shortcuts",
            title: L10n.string("Shortcuts"),
            status: shortcutsAvailable ? L10n.string("Available") : L10n.string("Unavailable"),
            state: shortcutsAvailable ? .ok : .attention,
            detail: shortcutsAvailable ? nil : L10n.string("iOS 16.1 or newer is required for Live Activities Shortcuts.")
        ))

        rows.append(.init(
            id: "icloud_sync",
            title: L10n.string("iCloud Sync"),
            status: iCloudChecklistStatus,
            state: iCloudChecklistState,
            detail: nil
        ))

        rows.append(.init(
            id: "important_notices",
            title: L10n.string("Important Notices"),
            status: L10n.string("Available"),
            state: .ok,
            detail: L10n.string("Critical app, HACS compatibility and reliability notices. Plain text only; Home Assistant tokens and relay credentials are never sent.")
        ))

        return HealthChecklist(rows: rows)
    }

    private var iCloudChecklistStatus: String {
        if !preferencesStore.iCloudSyncEnabled {
            return L10n.string("Off")
        }
        switch cloudKitSyncStatus {
        case .on: return L10n.string("On")
        case .syncing: return L10n.string("Syncing")
        case .signedOut: return L10n.string("Signed Out")
        case .restricted: return L10n.string("Restricted")
        case .unavailable: return L10n.string("Unavailable")
        case .error: return L10n.string("Error")
        case .off: return L10n.string("Off")
        }
    }

    private var iCloudChecklistState: HealthRowState {
        if !preferencesStore.iCloudSyncEnabled {
            return .off
        }
        switch cloudKitSyncStatus {
        case .on: return .ok
        case .syncing: return .unknown
        case .signedOut, .restricted, .unavailable: return .attention
        case .error: return .attention
        case .off: return .off
        }
    }

    var isDemoMode: Bool {
        if case .demo = connectionState {
            return true
        }
        return false
    }

    /// Non-mutating source for the Settings form while Demo Mode temporarily
    /// owns the active UI state. Settings only reads its address and display
    /// fields; the secure token field stays visually empty.
    var connectionConfigurationForEditing: ConnectionConfiguration? {
        configuration ?? connectionBeforeDemo
    }

    var hasStoredHomeAssistantCredential: Bool {
        guard let token = connectionConfigurationForEditing?.token else { return false }
        return !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var homeDisplayName: String {
        isDemoMode ? demoProvider.homeName : configuration?.instanceName ?? L10n.string("Home Assistant")
    }

    var demoRooms: [DemoRoom] {
        demoProvider.rooms
    }

    var demoScenarios: [DemoScenario] {
        DemoScenario.allCases
    }

    private func applyDemoPayload(_ payload: DemoScenarioPayload) async throws {
        if liveActivityManager.contains(recordId: payload.activityId) {
            try await liveActivityManager.update(
                recordId: payload.activityId,
                title: payload.title,
                subtitle: payload.subtitle,
                displayName: payload.displayName,
                primaryState: payload.primaryState,
                secondaryState: payload.secondaryState,
                progress: payload.progress,
                value: payload.value,
                unit: payload.unit
            )
        } else {
            try await liveActivityManager.start(draft: payload.draft, allowsRemotePushUpdates: false)
            try await liveActivityManager.update(
                recordId: payload.activityId,
                title: payload.title,
                subtitle: payload.subtitle,
                displayName: payload.displayName,
                primaryState: payload.primaryState,
                secondaryState: payload.secondaryState,
                progress: payload.progress,
                value: payload.value,
                unit: payload.unit
            )
        }

        syncActivities()
    }

    private func startDemoLaundrySimulation() {
        demoSimulationTask?.cancel()
        demoSimulationTask = Task { [weak self] in
            for progress in [32, 48, 64, 82, 100] {
                do {
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                } catch {
                    return
                }
                await self?.advanceDemoLaundry(to: progress)
            }
        }
    }

    private func advanceDemoLaundry(to progress: Int) async {
        guard isDemoMode else { return }
        let remaining = max(0, 52 - Int(Double(progress) * 0.52))
        let payload = demoProvider.updateLaundry(
            progress: progress,
            power: progress >= 100 ? 4 : 690,
            remainingMinutes: remaining,
            subtitle: progress >= 100 ? L10n.string("Cycle complete") : L10n.format("%d min remaining", remaining)
        )
        entities = demoProvider.currentEntities()

        do {
            try await applyDemoPayload(payload)
            if progress >= 100 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                try? await liveActivityManager.end(recordId: payload.activityId)
                syncActivities()
                appendLog("Demo laundry cycle completed.")
            }
        } catch {
            lastErrorMessage = userFacingMessage(error)
        }
    }

    private static func notificationStatusTitle(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "notDetermined"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        case .provisional:
            return "provisional"
        case .ephemeral:
            return "ephemeral"
        @unknown default:
            return "unknown"
        }
    }
}

enum ManagedRelayCredentialInstallState: Equatable {
    case waiting
    case pending
    case installing
    case installed
    case failed

    var title: String {
        switch self {
        case .waiting:
            return L10n.string("Waiting for relay credential")
        case .pending:
            return L10n.string("Pending Home Assistant connection")
        case .installing:
            return L10n.string("Installing in Home Assistant")
        case .installed:
            return L10n.string("Installed in Home Assistant")
        case .failed:
            return L10n.string("Install failed")
        }
    }
}
