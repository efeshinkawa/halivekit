import SwiftUI
import UIKit

struct DiagnosticsView: View {
    @Environment(AppModel.self) private var appModel
    @State private var didCopy = false
    @State private var isRequestingNotifications = false
    @State private var isRegisteringRelay = false
    @State private var isTestingRelay = false
    @State private var isTestingBackgroundSetup = false
    @State private var showsAdvancedRelayDiagnostics = false
    @State private var devicePendingRevocation: ManagedRelayDevice?

    var body: some View {
        NavigationStack {
            ZStack {
                PremiumBackground()
                ScrollView(.vertical) {
                    AdaptiveScreenContent {
                        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.large) {
                            HealthChecklistView(checklist: appModel.healthChecklist)
                            statusGrid
                            connectionDetails
                            backgroundDetails
                            if appModel.relaySettings.useManagedRelay && !appModel.isDemoMode {
                                relayDevices
                            }
                            errorDetails
                            debugLogsLink
                            copyButton
                        }
                        .padding(.top, HALiveKitDesign.Spacing.standard)
                    }
                    .containerRelativeFrame(.horizontal)
                    .padding(.bottom, HALiveKitDesign.Layout.floatingTabBarContentClearance)
                }
            }
            .navigationTitle("Health Center")
        }
        .task {
            await appModel.refreshNotificationPermissionStatus()
            await appModel.refreshHALiveKitIntegrationStatus()
            await appModel.refreshManagedRelayDevices()
        }
        .confirmationDialog(
            "Revoke Relay Device?",
            isPresented: Binding(
                get: { devicePendingRevocation != nil },
                set: { if !$0 { devicePendingRevocation = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let devicePendingRevocation {
                Button("Revoke Device", role: .destructive) {
                    let device = devicePendingRevocation
                    self.devicePendingRevocation = nil
                    Task { await appModel.revokeManagedRelayDevice(device) }
                }
            }
            Button("Cancel", role: .cancel) {
                devicePendingRevocation = nil
            }
        } message: {
            Text("This device will stop receiving relay updates until it pairs again.")
        }
    }

    private var statusGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 142), spacing: HALiveKitDesign.Spacing.medium)], spacing: HALiveKitDesign.Spacing.medium) {
            DiagnosticStatusCard(
                title: "REST",
                status: appModel.restStatus,
                iconName: "arrow.down.doc.fill"
            )
            DiagnosticStatusCard(
                title: "WebSocket",
                status: appModel.webSocketStatus,
                iconName: "dot.radiowaves.left.and.right"
            )
            DiagnosticStatusCard(
                title: "Entities",
                status: appModel.entityFetchStatus,
                iconName: "square.stack.3d.up.fill"
            )
        }
    }

    private var connectionDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Connection", subtitle: "Token is intentionally never shown.")
            DiagnosticRow(title: "Display Name", value: appModel.homeDisplayName)
            DiagnosticRow(title: "Normalized URL", value: appModel.isDemoMode ? "demo://home" : appModel.configuration?.redactedURLString ?? L10n.string("Not connected"))
            DiagnosticRow(
                title: "WebSocket URL",
                value: appModel.configuration.flatMap { HomeAssistantWebSocketManager.redactedWebSocketURLString(from: $0.baseURL) } ?? L10n.string("Not connected")
            )
            DiagnosticRow(title: "Client Device ID", value: appModel.clientDeviceID)
            DiagnosticRow(title: "Home Assistant instance ID", value: appModel.redactedHomeAssistantInstanceID)
            DiagnosticRow(
                title: "Subscribed events",
                value: appModel.subscribedEventTypes.isEmpty ? L10n.string("None") : appModel.subscribedEventTypes.joined(separator: ", ")
            )
            DiagnosticRow(title: "HA LiveKit integration", value: appModel.integrationSubscriptionStatusText)
            DiagnosticRow(
                title: "Integration compatibility",
                value: appModel.haLiveKitIntegrationNeedsUpdate
                    ? L10n.string("Update required")
                    : (appModel.haLiveKitIntegrationStatus?.integrationVersion ?? L10n.string("Checking"))
            )
            DiagnosticRow(title: "Last event", value: appModel.lastReceivedEventDescription)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var backgroundDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                title: "Background Live Activities",
                subtitle: "Foreground updates work through Home Assistant WebSocket. Background start and update require APNs relay."
            )
            DiagnosticRow(title: "Status", value: appModel.backgroundLiveActivitiesStatus.title)
            Text(appModel.backgroundUpdatesStatusText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            DiagnosticRow(title: "Notifications Permission", value: appModel.notificationPermissionChecklistStatus)
            DiagnosticRow(title: "Live Activities", value: appModel.liveActivitiesChecklistStatus)
            DiagnosticRow(title: "Push Token", value: appModel.pushTokenChecklistStatus)
            DiagnosticRow(title: "Relay", value: appModel.relayChecklistStatus)

            #if DEBUG
            if appModel.relaySettings.useManagedRelay,
               appModel.relaySettings.effectiveMode == .sandbox {
                NoticeBanner(
                    title: "Debug relay uses sandbox APNs",
                    message: "The public managed relay is production-only. This Debug build now checks the relay environment before sending any token or credential. Use a dedicated sandbox relay for background testing; release builds continue to use production.",
                    tone: .info
                )
            }
            #endif

            ViewThatFits(in: .horizontal) {
                HStack(spacing: HALiveKitDesign.Spacing.small) {
                    backgroundTestButton
                    notificationButton
                }

                VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.small) {
                    backgroundTestButton
                    notificationButton
                }
            }

            if appModel.notificationAuthorizationStatus == "denied" || !appModel.liveActivitiesEnabled {
                Button {
                    openSystemSettings()
                } label: {
                    Label("Open iOS Settings", systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
                .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            }

            if !appModel.backgroundSetupChecks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(appModel.backgroundSetupChecks) { check in
                        DiagnosticRow(
                            title: "\(check.title) - \(check.status)",
                            value: check.detail ?? (check.isPassing ? "OK" : L10n.string("Needs attention"))
                        )
                    }
                }
            }

            DisclosureGroup("Advanced Relay Diagnostics", isExpanded: $showsAdvancedRelayDiagnostics) {
                VStack(alignment: .leading, spacing: 12) {
                    DiagnosticRow(title: "Running on simulator", value: appModel.runningOnSimulatorText)
                    DiagnosticRow(title: "ActivityKit available", value: appModel.activityKitAvailableText)
                    DiagnosticRow(title: "Notification raw status", value: appModel.notificationAuthorizationStatus)
                    if let error = appModel.notificationPermissionError {
                        DiagnosticRow(title: "Notification permission error", value: error)
                    }
                    DiagnosticRow(title: "Live Activities available", value: appModel.liveActivitiesAvailableText)
                    DiagnosticRow(title: "Live Activities enabled", value: appModel.liveActivitiesEnabledText)
                    DiagnosticRow(title: "APNs entitlement", value: appModel.apnsEntitlementStatusText)
                    DiagnosticRow(title: "Push Notifications entitlement present", value: appModel.pushNotificationsEntitlementPresentText)
                    DiagnosticRow(title: "Push-to-start listener", value: appModel.relayDiagnostics.isObservingPushToStartToken ? L10n.string("Active") : L10n.string("Inactive"))
                    DiagnosticRow(title: "Push-to-start token received", value: appModel.relayDiagnostics.pushToStartTokenAvailable ? L10n.string("Yes") : L10n.string("No"))
                    DiagnosticRow(title: "Last push-to-start token update", value: appModel.formattedDate(appModel.relayDiagnostics.lastPushToStartTokenUpdateAt))
                    DiagnosticRow(title: "Last activity update token", value: appModel.formattedDate(appModel.relayDiagnostics.lastActivityTokenUpdateAt))
                    if let reason = appModel.pushTokenUnavailableReasonText {
                        DiagnosticRow(title: "Push token wait reason", value: reason)
                    }
                    DiagnosticRow(title: "Relay source", value: appModel.relaySettings.relaySourceTitle)
                    DiagnosticRow(title: "Managed relay URL present", value: appModel.managedRelayURLPresentText)
                    DiagnosticRow(title: "Legacy fallback app key present", value: appModel.managedRelayAppKeyPresentText)
                    DiagnosticRow(title: "Managed relay", value: ManagedRelayConfig.current.redactedManagedRelayURL)
                    DiagnosticRow(title: "Relay URL", value: appModel.relaySettings.redactedRelayURL)
                    DiagnosticRow(title: "Relay authentication", value: appModel.relayDiagnostics.authenticationProtocol.title)
                    DiagnosticRow(title: "Relay registered", value: appModel.relayDiagnostics.relayRegistered ? L10n.string("Yes") : L10n.string("No"))
                    DiagnosticRow(title: "Last relay registration attempt", value: appModel.formattedDate(appModel.relayDiagnostics.lastRegistrationAttemptAt))
                    DiagnosticRow(title: "Last relay registration HTTP", value: appModel.relayDiagnostics.lastRegistrationStatusCode.map(String.init) ?? L10n.string("None"))
                    DiagnosticRow(title: "Last relay registration error", value: appModel.relayDiagnostics.lastRegistrationError ?? L10n.string("None"))
                    DiagnosticRow(title: "Relay credential received", value: appModel.relayCredentialReceivedText)
                    DiagnosticRow(title: "HA credential install", value: appModel.managedRelayCredentialInstallStatusText)
                    DiagnosticRow(title: "Last HA configure attempt", value: appModel.formattedDate(appModel.lastManagedRelayCredentialInstallAttemptAt))
                    DiagnosticRow(title: "Last HA configure status", value: appModel.lastManagedRelayConfigureStatusText)
                    DiagnosticRow(title: "Last HA configure error", value: appModel.lastManagedRelayCredentialInstallError ?? L10n.string("None"))
                    DiagnosticRow(title: "Last relay health HTTP", value: appModel.relayDiagnostics.lastHealthStatusCode.map(String.init) ?? L10n.string("None"))
                    DiagnosticRow(title: "Last relay health error", value: appModel.relayDiagnostics.lastHealthError ?? L10n.string("None"))
                    DiagnosticRow(title: "Last APNs relay test", value: appModel.formattedDate(appModel.relayDiagnostics.lastAPNsAttemptAt))
                    DiagnosticRow(title: "Last APNs response HTTP", value: appModel.relayDiagnostics.lastAPNsStatusCode.map(String.init) ?? L10n.string("None"))
                    DiagnosticRow(title: "Last APNs response", value: appModel.relayDiagnostics.lastAPNsResponseSummary ?? L10n.string("None"))
                    DiagnosticRow(title: "Last APNs error", value: appModel.relayDiagnostics.lastAPNSError ?? L10n.string("None"))
                    DiagnosticRow(title: "Last relay/APNs error", value: appModel.relayDiagnostics.lastAPNSError ?? appModel.relayDiagnostics.lastRegistrationError ?? L10n.string("None"))
                    DiagnosticRow(title: "APNs mode", value: appModel.relayDiagnostics.mode.rawValue)

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: HALiveKitDesign.Spacing.small) {
                            registerAgainButton
                            relayHealthButton
                        }

                        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.small) {
                            registerAgainButton
                            relayHealthButton
                        }
                    }
                }
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var errorDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Errors", subtitle: "Latest REST and WebSocket failures.")
            DiagnosticRow(title: "Last REST error", value: appModel.lastRESTError ?? L10n.string("None"))
            DiagnosticRow(title: "Last WebSocket error", value: appModel.lastWebSocketError ?? L10n.string("None"))
            DiagnosticRow(title: "Last entity fetch error", value: appModel.lastEntityFetchError ?? L10n.string("None"))
            DiagnosticRow(title: "Last register error", value: appModel.relayDiagnostics.lastRegistrationError ?? L10n.string("None"))
            DiagnosticRow(title: "Last relay error", value: appModel.relayDiagnostics.lastAPNSError ?? appModel.relayDiagnostics.lastHealthError ?? L10n.string("None"))
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var relayDevices: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                title: "Relay Devices",
                subtitle: "Administrator-only inventory. Credentials and push tokens are never shown."
            )

            if appModel.isCheckingHALiveKitIntegration {
                ProgressView("Checking integration compatibility...")
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if appModel.haLiveKitIntegrationNeedsUpdate {
                NoticeBanner(
                    title: "Update the HACS integration",
                    message: "Update HA LiveKit in HACS, restart Home Assistant, then reopen this app. Existing foreground features and v1 compatibility stay available during the rollout.",
                    tone: .warning
                )
            } else if appModel.isLoadingManagedRelayDevices {
                ProgressView("Loading relay devices...")
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if let error = appModel.managedRelayDevicesError {
                NoticeBanner(
                    title: "Device inventory unavailable",
                    message: error,
                    tone: .warning
                )
            } else if appModel.managedRelayDevices.isEmpty {
                Text("No relay devices found.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(appModel.managedRelayDevices) { device in
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(device.friendlyDeviceName ?? "Relay Device")
                                .font(.subheadline.weight(.semibold))
                            Text("\(device.deviceID.prefix(8))… · \(device.authenticationProtocol.uppercased())")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        if device.deviceID == appModel.clientDeviceID {
                            Text("This device")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        } else {
                            Button("Revoke", role: .destructive) {
                                devicePendingRevocation = device
                            }
                            .buttonStyle(.bordered)
                            .disabled(appModel.revokingManagedRelayDeviceID != nil)
                            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            Button {
                Task {
                    await appModel.refreshHALiveKitIntegrationStatus()
                    await appModel.refreshManagedRelayDevices()
                }
            } label: {
                Label(
                    appModel.haLiveKitIntegrationNeedsUpdate ? "Check Again" : "Refresh Devices",
                    systemImage: "arrow.clockwise"
                )
            }
            .buttonStyle(.bordered)
            .disabled(
                appModel.isLoadingManagedRelayDevices
                    || appModel.isCheckingHALiveKitIntegration
            )
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var debugLogsLink: some View {
        let entries = appModel.redactedDebugLogs

        return NavigationLink {
            DebugLogsView()
        } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: HALiveKitDesign.Spacing.medium) {
                    Image(systemName: "ladybug.fill")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.tint)
                        .frame(width: 42, height: 42)
                        .background(
                            Color.accentColor.opacity(0.12),
                            in: RoundedRectangle(
                                cornerRadius: HALiveKitDesign.Radius.control,
                                style: .continuous
                            )
                        )

                    VStack(alignment: .leading, spacing: 3) {
                        Text("Debug Logs")
                            .font(.headline)
                        Text("Recent redacted network and activity events.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: HALiveKitDesign.Spacing.small)

                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }

                if let latest = entries.first {
                    Text(latest.formattedLine)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("No logs yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(HALiveKitDesign.Spacing.standard)
            .glassPanel()
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens redacted debug logs")
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = appModel.diagnosticsText
            didCopy = true
        } label: {
            Label(didCopy ? "Copied" : "Copy diagnostics", systemImage: didCopy ? "checkmark.circle.fill" : "doc.on.doc.fill")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
    }

    private var backgroundTestButton: some View {
        Button {
            Task { await testBackgroundSetup() }
        } label: {
            Label(isTestingBackgroundSetup ? "Testing..." : "Test Background Updates", systemImage: "checklist.checked")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isTestingBackgroundSetup)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
    }

    @ViewBuilder
    private var notificationButton: some View {
        if !appModel.areNotificationsAllowed {
            Button {
                Task { await requestNotificationPermission() }
            } label: {
                Label(isRequestingNotifications ? "Requesting..." : "Enable Notifications", systemImage: "bell.badge")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(isRequestingNotifications)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        }
    }

    private var registerAgainButton: some View {
        Button {
            Task { await registerRelayAgain() }
        } label: {
            Label(isRegisteringRelay ? "Registering..." : "Force Register Push Token", systemImage: "arrow.clockwise")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(isRegisteringRelay)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
    }

    private var relayHealthButton: some View {
        Button {
            Task { await testRelayHealth() }
        } label: {
            Label(isTestingRelay ? "Testing..." : "Test Relay Health", systemImage: "waveform.path.ecg")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(isTestingRelay || !appModel.relaySettings.hasRelayURL)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
    }

    private func requestNotificationPermission() async {
        isRequestingNotifications = true
        defer { isRequestingNotifications = false }
        await appModel.requestNotificationPermission()
    }

    private func registerRelayAgain() async {
        isRegisteringRelay = true
        defer { isRegisteringRelay = false }
        await appModel.registerRelayAgain()
    }

    private func testRelayHealth() async {
        isTestingRelay = true
        defer { isTestingRelay = false }
        await appModel.testRelayHealth()
    }

    private func testBackgroundSetup() async {
        isTestingBackgroundSetup = true
        defer { isTestingBackgroundSetup = false }
        await appModel.testBackgroundSetup()
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

private struct DebugLogsView: View {
    @Environment(AppModel.self) private var appModel
    @State private var didCopy = false

    var body: some View {
        ZStack {
            PremiumBackground()

            ScrollView {
                AdaptiveScreenContent {
                    VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.standard) {
                        NoticeBanner(
                            title: "Privacy protected",
                            message: "Tokens, credentials, secrets, request headers and raw network bodies are never shown here."
                        )

                        if entries.isEmpty {
                            EmptyStateView(
                                iconName: "ladybug",
                                title: "No logs yet.",
                                message: "Recent redacted network and activity events will appear here."
                            )
                        } else {
                            LazyVStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.small) {
                                ForEach(entries) { entry in
                                    DebugLogRow(entry: entry)
                                }
                            }
                            .padding(HALiveKitDesign.Spacing.standard)
                            .glassPanel()
                        }
                    }
                    .padding(.top, HALiveKitDesign.Spacing.standard)
                }
            }
        }
        .navigationTitle("Debug Logs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = appModel.redactedDebugLogsText
                    didCopy = true
                } label: {
                    Image(systemName: didCopy ? "checkmark.circle.fill" : "doc.on.doc")
                        .frame(
                            width: HALiveKitDesign.Layout.minimumTapTarget,
                            height: HALiveKitDesign.Layout.minimumTapTarget
                        )
                }
                .disabled(entries.isEmpty)
                .accessibilityLabel(
                    Text(L10n.string(didCopy ? "Copied" : "Copy redacted logs"))
                )
            }
        }
    }

    private var entries: [DebugLogEntry] {
        appModel.redactedDebugLogs
    }
}

private struct DebugLogRow: View {
    let entry: DebugLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.small) {
            HStack(spacing: HALiveKitDesign.Spacing.small) {
                Text(entry.timestampText)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)

                if entry.repetitionCount > 1 {
                    Text("×\(entry.repetitionCount)")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.tint)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.12), in: Capsule())
                }

                Spacer(minLength: 0)
            }

            Text(entry.message)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, HALiveKitDesign.Spacing.xSmall)
        .accessibilityElement(children: .combine)
    }
}

private struct DiagnosticStatusCard: View {
    var title: String
    var status: ConnectionDiagnosticStatus
    var iconName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: iconName)
                .font(.title3.weight(.bold))
                .foregroundStyle(statusColor)
                .frame(width: 36, height: 36)
                .background(statusColor.opacity(0.14), in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
            Text(L10n.string(title))
                .font(.caption)
                    .foregroundStyle(.secondary)
                Text(status.title)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }

    private var statusColor: Color {
        switch status {
        case .idle: .secondary
        case .connecting: .orange
        case .connected: .green
        case .disconnected: .orange
        case .failed: .red
        }
    }
}

private struct DiagnosticRow: View {
    var title: String
    var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.string(title))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

#Preview {
    DiagnosticsView()
        .environment(AppModel())
}
