import MessageUI
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(AppUpdateService.self) private var updateService
    @Environment(\.openURL) private var openURL

    @State private var baseURL = ""
    @State private var homeName = ""
    @State private var token = ""
    @State private var internalURL = ""
    @State private var externalURL = ""
    @State private var showAdvancedURLs = false
    @State private var isTesting = false
    @State private var isSavingConnection = false
    @State private var didSaveName = false
    @State private var didSaveConnection = false
    @State private var isRequestingNotifications = false
    @State private var sendSupportLogs = false
    @State private var supportErrorMessage: String?
    @State private var supportMailDraft: SupportMailDraft?
    @State private var languageSelection: String = AppLanguageManager.selectedCode
    @State private var showLanguageRestartNote = false

    var body: some View {
        NavigationStack {
            ZStack {
                PremiumBackground()
                ScrollView {
                    AdaptiveScreenContent {
                        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.large) {
                            demoModeSettings
                            connectionSettings
                            integrationSettings
                            backgroundLiveActivities
                            appLanguageSection
                            importantNoticesSection
                            iCloudSyncSection
                            supportSection
                            developerDetails
                            versionCard
                        }
                        .padding(.top, HALiveKitDesign.Spacing.standard)
                    }
                }
            }
            .navigationTitle("Settings")
        }
        .task {
            let editableConnection = appModel.connectionConfigurationForEditing
            baseURL = editableConnection?.baseURL.absoluteString ?? HomeAssistantURLNormalizer.defaultLocalAddress
            homeName = editableConnection?.instanceName ?? homeName
            internalURL = editableConnection?.internalURL?.absoluteString ?? ""
            externalURL = editableConnection?.externalURL?.absoluteString ?? ""
            if !internalURL.isEmpty || !externalURL.isEmpty {
                showAdvancedURLs = true
            }
            await appModel.refreshNotificationPermissionStatus()
        }
        .sheet(item: $supportMailDraft) { draft in
            SupportMailComposer(draft: draft) {
                supportErrorMessage = L10n.string("Support email could not be sent. Please try again.")
            }
        }
    }

    private var demoModeSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                title: "Demo Mode",
                subtitle: appModel.isDemoMode ? "Demo Home is active. Live Activities use local ActivityKit updates only." : "Try HA LiveKit without a Home Assistant connection."
            )

            if appModel.isDemoMode {
                NoticeBanner(
                    title: "Demo Home",
                    message: "\(appModel.entities.count) simulated entities are available. Switch to a real connection whenever you are ready.",
                    tone: .info
                )
            }

            LazyVGrid(columns: wideActionButtonColumns, spacing: 10) {
                Button {
                    appModel.startDemoMode()
                } label: {
                    SettingsButtonLabel(appModel.isDemoMode ? "Restart Demo" : "Try Demo Home", systemImage: "play.circle")
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await appModel.exitDemoMode() }
                } label: {
                    SettingsButtonLabel("Connect Home Assistant", systemImage: "house.and.flag")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var connectionSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(title: "Home Assistant", subtitle: "Changing the token replaces the secure Keychain entry. Demo Mode does not need URL or token.")

            FormFieldLabel(title: "Home Assistant URL")
            TextField(HomeAssistantURLNormalizer.defaultLocalAddress, text: $baseURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            Text("Use your local address or paste your Nabu Casa URL.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            FormFieldLabel(title: "Home name")
            TextField("Home name", text: $homeName)
                .textInputAutocapitalization(.words)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            FormFieldLabel(title: "Long-Lived Access Token")
            SecureField(L10n.string(appModel.configuration == nil ? "Long-Lived Access Token" : "Stored token hidden - paste to replace"), text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            advancedURLSection

            if connectionUsesUnencryptedHTTP {
                NoticeBanner(
                    title: "Security",
                    message: "HTTP sends the Home Assistant token without transport encryption. Prefer HTTPS or Nabu Casa, and use local HTTP only on a trusted home network.",
                    tone: .warning
                )
            }

            if let message = appModel.homeAssistantConnectionIssueMessage {
                NoticeBanner(title: "Connection issue", message: message, tone: .error)
            }
            if let message = appModel.foregroundUpdatesIssueMessage {
                NoticeBanner(title: "Foreground updates disconnected", message: message, tone: .warning)
            }
            if let testResult = appModel.lastConnectionTestResultLabel {
                NoticeBanner(
                    title: "Test connection",
                    message: testResult,
                    tone: appModel.lastConnectionTestSucceeded == false ? .warning : .info
                )
            }

            LazyVGrid(columns: compactActionButtonColumns, spacing: 10) {
                Button {
                    appModel.updateDisplayName(homeName)
                    homeName = appModel.configuration?.instanceName ?? homeName
                    didSaveName = true
                } label: {
                    SettingsButtonLabel(didSaveName ? "Saved" : "Auto Name", systemImage: didSaveName ? "checkmark.circle" : "text.cursor")
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await testConnection() }
                } label: {
                    SettingsButtonLabel(isTesting ? "Testing" : "Test", systemImage: "checkmark.seal")
                }
                .buttonStyle(.borderedProminent)
                .disabled(isTesting || !canTestConnection)

                Button {
                    Task { await saveConnection() }
                } label: {
                    SettingsButtonLabel(
                        isSavingConnection ? "Saving" : (didSaveConnection ? "Saved" : "Save"),
                        systemImage: didSaveConnection ? "checkmark.circle" : "key"
                    )
                }
                .buttonStyle(.bordered)
                .disabled(isSavingConnection || token.isEmpty)

                Button(role: .destructive) {
                    appModel.clearCredentials()
                    baseURL = HomeAssistantURLNormalizer.defaultLocalAddress
                    homeName = ""
                    token = ""
                    internalURL = ""
                    externalURL = ""
                    showAdvancedURLs = false
                    didSaveConnection = false
                } label: {
                    SettingsButtonLabel("Clear Credentials", systemImage: "trash")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var advancedURLSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: $showAdvancedURLs.animation()) {
                Text(L10n.string("Add separate Internal and External URLs"))
                    .font(.subheadline.weight(.semibold))
            }

            if showAdvancedURLs {
                Text(L10n.string("Optional. Use Internal URL on your home Wi-Fi and External URL when you are away. If both are set, HA LiveKit tries Internal first and falls back to External on connectivity errors."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                FormFieldLabel(title: "Internal URL (Optional)")
                TextField(L10n.string("Internal URL (Optional)"), text: $internalURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                Text(L10n.string("Used when you are on your home network."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                FormFieldLabel(title: "External URL (Optional)")
                TextField(L10n.string("External URL (Optional)"), text: $externalURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                Text(L10n.string("Used away from home or when the Internal URL is unreachable."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var developerDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Developer", subtitle: "Only needed for optional advanced device routing.")
            CopySnippetButton(title: "Copy Client Device ID", value: appModel.clientDeviceID)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var integrationSettings: some View {
        NavigationLink {
            IntegrationGuideView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "puzzlepiece.extension.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                    .frame(width: 42, height: 42)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text("Home Assistant Integration Guide")
                        .font(.headline)
                    Text("HACS install steps, event name and service examples.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(HALiveKitDesign.Spacing.standard)
            .glassPanel()
        }
        .buttonStyle(.plain)
    }

    private var backgroundLiveActivities: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                title: "Background Updates",
                subtitle: "Managed automatically after notification permission and device registration."
            )

            if relayUsesUnencryptedHTTP {
                NoticeBanner(
                    title: "Security",
                    message: "This relay uses HTTP. Switch to an HTTPS relay before sending device or Live Activity tokens.",
                    tone: .warning
                )
            }

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: backgroundStatusIcon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(backgroundStatusColor)
                    .frame(width: 38, height: 38)
                    .background(backgroundStatusColor.opacity(0.16), in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(appModel.backgroundUpdatesSettingsStatus)
                        .font(.headline)
                    Text(appModel.backgroundUpdatesSettingsDetail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !appModel.areNotificationsAllowed {
                Button {
                    Task { await requestNotificationPermission() }
                } label: {
                    Label(isRequestingNotifications ? "Requesting..." : "Enable Notifications", systemImage: "bell.badge")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isRequestingNotifications)
            }

            if appModel.notificationAuthorizationStatus == "denied" || !appModel.liveActivitiesEnabled {
                Button {
                    openSystemSettings()
                } label: {
                    Label("Open iOS Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var supportSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                title: "Help",
                subtitle: "Send a support email to the developer. Logs stay off unless you choose to include privacy-protected event summaries."
            )

            Toggle(isOn: $sendSupportLogs) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n.string("Send Logs"))
                        .font(.subheadline.weight(.semibold))
                    Text(L10n.string("Include privacy-protected diagnostic logs with this email."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            .onChange(of: sendSupportLogs) { _, _ in
                supportErrorMessage = nil
            }
            .accessibilityHint(L10n.string(sendSupportLogs
                ? "Only event categories, outcomes, repetition counts and HTTP status codes are included. Names, identifiers, URLs, IP addresses, credentials, server responses, error details and timestamps are excluded."
                : "Logs are off. The email includes only the app version and build number."
            ))

            Text(L10n.string(sendSupportLogs
                ? "Only event categories, outcomes, repetition counts and HTTP status codes are included. Names, identifiers, URLs, IP addresses, credentials, server responses, error details and timestamps are excluded."
                : "Logs are off. The email includes only the app version and build number."
            ))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let supportErrorMessage {
                NoticeBanner(title: "Help", message: supportErrorMessage, tone: .warning)
            }

            Button {
                openSupportEmail()
            } label: {
                Label("Email Developer", systemImage: "envelope")
                    .frame(maxWidth: .infinity, minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            }
            .buttonStyle(.bordered)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var appLanguageSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                title: "App Language",
                subtitle: "Override the language used inside HA LiveKit. The iOS system language keeps working too."
            )

            Picker(L10n.string("Language"), selection: $languageSelection) {
                Text(L10n.string("System Default")).tag(AppLanguageManager.systemDefaultCode)
                ForEach(AppLanguageManager.supportedCodes, id: \.self) { code in
                    Text(localeDisplayName(for: code)).tag(code)
                }
            }
            .pickerStyle(.menu)

            if showLanguageRestartNote {
                NoticeBanner(
                    title: "Language updated",
                    message: "Some screens may need an app restart to fully switch over.",
                    tone: .info
                )
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
        .onChange(of: languageSelection) { _, newValue in
            AppLanguageManager.apply(code: newValue)
            showLanguageRestartNote = true
        }
    }

    private func localeDisplayName(for code: String) -> String {
        let displayLocale = Locale(identifier: code)
        let inLanguageName = displayLocale.localizedString(forLanguageCode: code)?.capitalized(with: displayLocale)
        let inCurrentName = Locale.current.localizedString(forLanguageCode: code)?.capitalized(with: Locale.current)
        switch (inLanguageName, inCurrentName) {
        case let (native?, current?) where native != current:
            return "\(native) — \(current)"
        case let (native?, _):
            return native
        case let (_, current?):
            return current
        default:
            return code
        }
    }

    private var importantNoticesSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                title: "Important Notices",
                subtitle: "Critical app, HACS compatibility and reliability notices. Plain text only; Home Assistant tokens and relay credentials are never sent."
            )

            Toggle(isOn: Binding(
                get: { updateService.importantNoticesEnabled },
                set: { enabled in
                    Task { await updateService.setImportantNoticesEnabled(enabled) }
                }
            )) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n.string("Notify me about critical updates"))
                        .font(.subheadline.weight(.semibold))
                    Text(L10n.string("Rare local notifications only after the app securely discovers a new critical notice. Never marketing."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)

            HStack {
                Label(
                    updateService.lastCheckedAt.map {
                        L10n.format("Checked %@", $0.formatted(date: .abbreviated, time: .shortened))
                    } ?? L10n.string("Not checked yet"),
                    systemImage: "checkmark.shield"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                Spacer()
                if updateService.unreadNoticeCount > 0 {
                    Text(L10n.format("%d unread", updateService.unreadNoticeCount))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HALiveActivityTheme.homeAssistant.accentColor)
                }
            }

            if let error = updateService.lastNoticesError {
                NoticeBanner(title: "Notice check unavailable", message: error, tone: .warning)
            }

            if updateService.notices.isEmpty, !updateService.isRefreshing {
                Text(L10n.string("No active important notices."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(updateService.notices) { notice in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Label(notice.title, systemImage: notice.severity.systemImage)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(notice.severity.color)
                            Spacer()
                            if updateService.isNoticeUnread(notice) {
                                Text(L10n.string("Notice"))
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(notice.message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        if let actionURL = updateService.actionURL(for: notice.action) {
                            Button {
                                updateService.markNoticeRead(notice)
                                openURL(actionURL)
                            } label: {
                                Label(notice.action.buttonTitle, systemImage: "arrow.up.right.square")
                            }
                            .buttonStyle(.bordered)
                            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                        }

                        if updateService.isNoticeUnread(notice) {
                            Button {
                                updateService.markNoticeRead(notice)
                            } label: {
                                Label(L10n.string("Done"), systemImage: "checkmark")
                            }
                            .buttonStyle(.bordered)
                            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                        }
                    }
                    .padding(HALiveKitDesign.Spacing.medium)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
                }
            }

            Button {
                Task { await updateService.refresh(force: true) }
            } label: {
                Label(
                    updateService.isRefreshing ? "Checking..." : "Check Important Notices",
                    systemImage: "arrow.clockwise"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(updateService.isRefreshing)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var iCloudSyncSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                title: "iCloud Sync",
                subtitle: "Optional. Syncs non-sensitive preferences across your devices. Tokens always stay on this device."
            )

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: iCloudStatusIcon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(iCloudStatusColor)
                    .frame(width: 38, height: 38)
                    .background(iCloudStatusColor.opacity(0.16), in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(iCloudStatusTitle)
                        .font(.headline)
                    Text(iCloudStatusDetail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Toggle(isOn: Binding(
                get: { appModel.preferencesStore.iCloudSyncEnabled },
                set: { appModel.setiCloudSyncEnabled($0) }
            )) {
                Text(L10n.string("Sync preferences with iCloud"))
                    .font(.subheadline.weight(.semibold))
            }

            Text(L10n.string("Your Home Assistant token, relay secrets, and internal or external URLs are never written to iCloud."))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var iCloudStatusIcon: String {
        if !appModel.preferencesStore.iCloudSyncEnabled {
            return "icloud.slash"
        }
        switch appModel.cloudKitSyncStatus {
        case .on:
            return "checkmark.icloud.fill"
        case .syncing:
            return "arrow.triangle.2.circlepath.icloud"
        case .signedOut, .restricted:
            return "icloud.slash"
        case .unavailable:
            return "icloud.slash"
        case .error:
            return "exclamationmark.icloud"
        case .off:
            return "icloud"
        }
    }

    private var iCloudStatusColor: Color {
        if !appModel.preferencesStore.iCloudSyncEnabled {
            return .gray
        }
        switch appModel.cloudKitSyncStatus {
        case .on:
            return .green
        case .syncing:
            return HALiveActivityTheme.homeAssistant.accentColor
        case .signedOut, .restricted, .unavailable, .off:
            return .orange
        case .error:
            return .red
        }
    }

    private var iCloudStatusTitle: String {
        if !appModel.preferencesStore.iCloudSyncEnabled {
            return L10n.string("Off")
        }
        switch appModel.cloudKitSyncStatus {
        case .on: return L10n.string("On")
        case .syncing: return L10n.string("Syncing")
        case .off: return L10n.string("Off")
        case .signedOut: return L10n.string("iCloud signed out")
        case .restricted: return L10n.string("iCloud restricted")
        case .unavailable: return L10n.string("iCloud unavailable")
        case .error: return L10n.string("Sync error")
        }
    }

    private var iCloudStatusDetail: String {
        if !appModel.preferencesStore.iCloudSyncEnabled {
            return L10n.string("Local only. Your settings stay on this device.")
        }
        switch appModel.cloudKitSyncStatus {
        case .on:
            return L10n.string("Preferences sync across your devices that use the same Apple ID.")
        case .syncing:
            return L10n.string("Checking iCloud for the latest preferences.")
        case .off:
            return L10n.string("Local only. Your settings stay on this device.")
        case .signedOut:
            return L10n.string("Sign in to iCloud in iOS Settings to use iCloud Sync.")
        case .restricted:
            return L10n.string("iCloud is restricted on this device. Sync is unavailable.")
        case .unavailable:
            return L10n.string("iCloud is temporarily unavailable. The app keeps working locally.")
        case .error(let message):
            return message
        }
    }

    private var versionCard: some View {
        HStack {
            Label("HA LiveKit", systemImage: "app.badge")
            Spacer()
            Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var backgroundStatusIcon: String {
        switch appModel.backgroundLiveActivitiesStatus {
        case .ready:
            "checkmark.seal.fill"
        case .needsNotificationPermission:
            "bell.badge.fill"
        case .setupNeeded:
            "checklist"
        case .notificationsDisabled:
            "bell.slash.fill"
        case .liveActivitiesDisabled:
            "livephoto.slash"
        case .relayNotReady:
            "antenna.radiowaves.left.and.right.slash"
        case .error:
            "exclamationmark.triangle.fill"
        }
    }

    private var backgroundStatusColor: Color {
        switch appModel.backgroundLiveActivitiesStatus {
        case .ready:
            .green
        case .setupNeeded, .needsNotificationPermission:
            HALiveActivityTheme.homeAssistant.accentColor
        case .notificationsDisabled, .liveActivitiesDisabled:
            .orange
        case .relayNotReady, .error:
            .red
        }
    }

    private var wideActionButtonColumns: [GridItem] {
        [GridItem(.adaptive(minimum: 150), spacing: 10)]
    }

    private var compactActionButtonColumns: [GridItem] {
        [GridItem(.adaptive(minimum: 112), spacing: 10)]
    }

    private var canTestConnection: Bool {
        !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || appModel.hasStoredHomeAssistantCredential
    }

    private var connectionUsesUnencryptedHTTP: Bool {
        var enteredURLs = [baseURL]
        if showAdvancedURLs {
            enteredURLs.append(contentsOf: [internalURL, externalURL].filter {
                !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            })
        }
        return enteredURLs.contains(where: HomeAssistantURLNormalizer.usesUnencryptedHTTP)
    }

    private var relayUsesUnencryptedHTTP: Bool {
        guard appModel.relaySettings.effectiveMode != .disabled else { return false }
        return appModel.relaySettings.relayURL?.scheme?.lowercased() == "http"
    }

    private func backgroundStep<Content: View>(
        number: Int,
        title: String,
        status: String,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("\(number)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(HALiveActivityTheme.homeAssistant.accentColor, in: Circle())

                Label(L10n.string(title), systemImage: systemImage)
                    .font(.headline)

                Spacer()

                Text(L10n.string(status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            content()
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
    }

    private func testConnection() async {
        isTesting = true
        defer { isTesting = false }
        _ = await appModel.testCurrentConnection(
            baseURLString: baseURL,
            token: token,
            displayName: homeName,
            internalURLString: showAdvancedURLs ? internalURL : nil,
            externalURLString: showAdvancedURLs ? externalURL : nil
        )
    }

    private func saveConnection() async {
        isSavingConnection = true
        defer { isSavingConnection = false }
        let saved = await appModel.saveCurrentConnection(
            baseURLString: baseURL,
            token: token,
            displayName: homeName,
            internalURLString: showAdvancedURLs ? internalURL : nil,
            externalURLString: showAdvancedURLs ? externalURL : nil
        )
        if saved {
            didSaveConnection = true
            homeName = appModel.configuration?.instanceName ?? homeName
            internalURL = appModel.configuration?.internalURL?.absoluteString ?? internalURL
            externalURL = appModel.configuration?.externalURL?.absoluteString ?? externalURL
            token = ""
        }
    }

    private func requestNotificationPermission() async {
        isRequestingNotifications = true
        defer { isRequestingNotifications = false }
        await appModel.requestNotificationPermission()
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func openSupportEmail() {
        supportErrorMessage = nil

        let email = "support@efeer.im"
        let subject = L10n.string("HA LiveKit Support")
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        let body = L10n.format(
            sendSupportLogs
                ? "App version: %@\nBuild: %@\nDiagnostics: privacy-protected logs attached"
                : "App version: %@\nBuild: %@\nDiagnostics: not attached",
            version,
            build
        )

        if MFMailComposeViewController.canSendMail() {
            supportMailDraft = SupportMailDraft(
                recipient: email,
                subject: subject,
                body: body,
                logAttachment: sendSupportLogs ? Data(appModel.privacySafeSupportLogsText.utf8) : nil
            )
            return
        }

        guard !sendSupportLogs else {
            supportErrorMessage = L10n.string("To include logs, configure an email account in Apple Mail or turn Send Logs off.")
            return
        }

        var components = URLComponents()
        components.scheme = "mailto"
        components.path = email
        components.queryItems = [
            URLQueryItem(name: "subject", value: subject),
            URLQueryItem(name: "body", value: body)
        ]

        guard let url = components.url else {
            supportErrorMessage = L10n.string("Support email is not configured.")
            return
        }

        UIApplication.shared.open(url) { didOpen in
            if !didOpen {
                supportErrorMessage = L10n.string("Support email is not configured.")
            }
        }
    }
}

private struct SupportMailDraft: Identifiable {
    let id = UUID()
    let recipient: String
    let subject: String
    let body: String
    let logAttachment: Data?
}

private struct SupportMailComposer: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss

    let draft: SupportMailDraft
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(dismiss: dismiss, onFailure: onFailure)
    }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let controller = MFMailComposeViewController()
        controller.mailComposeDelegate = context.coordinator
        controller.setToRecipients([draft.recipient])
        controller.setSubject(draft.subject)
        controller.setMessageBody(draft.body, isHTML: false)
        if let logAttachment = draft.logAttachment {
            controller.addAttachmentData(
                logAttachment,
                mimeType: "text/plain",
                fileName: "ha-livekit-support-events.txt"
            )
        }
        return controller
    }

    func updateUIViewController(
        _ uiViewController: MFMailComposeViewController,
        context: Context
    ) {}

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        private let dismiss: DismissAction
        private let onFailure: () -> Void

        init(dismiss: DismissAction, onFailure: @escaping () -> Void) {
            self.dismiss = dismiss
            self.onFailure = onFailure
        }

        func mailComposeController(
            _ controller: MFMailComposeViewController,
            didFinishWith result: MFMailComposeResult,
            error: Error?
        ) {
            dismiss()
            if result == .failed || error != nil {
                onFailure()
            }
        }
    }
}

struct IntegrationGuideView: View {
    @Environment(\.dismiss) private var dismiss

    var showsPrimaryActions = false
    var onSkip: (() -> Void)?
    var onTryDemo: (() -> Void)?
    var onConnect: (() -> Void)?

    var body: some View {
        ZStack {
            PremiumBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    steps
                    copyActions
                    if showsPrimaryActions {
                        primaryActions
                    }
                }
                .padding(16)
                .padding(.bottom, 20)
            }
        }
        .navigationTitle("Set up HA LiveKit")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "puzzlepiece.extension.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                .frame(width: 58, height: 58)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text("Set up HA LiveKit")
                    .font(.title.weight(.bold))
                Text("Install the Home Assistant integration to trigger Live Activities from automations.")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("You can skip this guide, try the demo home, or connect directly if your Home Assistant token is ready.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "HACS Setup", subtitle: "Follow these steps once inside Home Assistant.")
            GuideStep(number: 1, text: "Open HACS in Home Assistant.")
            GuideStep(number: 2, text: "Add this repository as a custom repository.")
            GuideStep(number: 3, text: "Choose category: Integration.")
            GuideStep(number: 4, text: "Install \"HA LiveKit\".")
            GuideStep(number: 5, text: "Restart Home Assistant.")
            GuideStep(number: 6, text: "Settings > Devices & Services > Add Integration > HA LiveKit.")
            GuideStep(number: 7, text: "Create a Long-Lived Access Token.")
            GuideStep(number: 8, text: "Return to this app and connect.")
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var copyActions: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Copy Examples", subtitle: "Paste these in Home Assistant Developer Tools or automation YAML.")
            CopySnippetButton(title: "Repository URL", value: Self.repositoryURL)
            CopySnippetButton(title: "Event name", value: "ha_livekit_activity_request")
            CopySnippetButton(title: "Example service YAML", value: Self.exampleServiceYAML)
            CopySnippetButton(title: "Example door automation", value: Self.doorAutomationYAML)
            CopySnippetButton(title: "Example laundry automation", value: Self.laundryAutomationYAML)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var primaryActions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                onConnect?()
                dismiss()
            } label: {
                SettingsButtonLabel("Connect Home Assistant", systemImage: "house.and.flag.fill")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 10)], spacing: 10) {
                Button {
                    onTryDemo?()
                    dismiss()
                } label: {
                    SettingsButtonLabel("Try Demo Home", systemImage: "play.circle")
                }
                .buttonStyle(.bordered)

                Button {
                    onSkip?()
                    dismiss()
                } label: {
                    SettingsButtonLabel("Skip", systemImage: "forward.end")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private static let repositoryURL = "https://github.com/efeshinkawa/halivekit"

    private static let exampleServiceYAML = """
    service: ha_livekit.start_activity
    data:
      activity_id: door_front
      entity_id: binary_sensor.front_door
      title: "Front Door"
      subtitle: "Door opened"
      template: door
      display_name: "Entrance Door"
    """

    private static let doorAutomationYAML = """
    alias: "HA LiveKit - Front door opened"
    trigger:
      - platform: state
        entity_id: binary_sensor.front_door
        to: "on"
    action:
      - service: ha_livekit.start_activity
        data:
          activity_id: front_door
          entity_id: binary_sensor.front_door
          title: "Door Alert"
          display_name: "Front Door"
          subtitle: "Opened"
          template: door
    """

    private static let laundryAutomationYAML = """
    alias: "HA LiveKit - Washing started"
    trigger:
      - platform: numeric_state
        entity_id: sensor.washing_machine_power
        above: 5
    action:
      - service: ha_livekit.start_activity
        data:
          activity_id: washing_machine
          entity_id: sensor.washing_machine_power
          title: "Laundry"
          display_name: "Washing Machine"
          subtitle: "Running"
          template: laundry
    """
}

private struct GuideStep: View {
    var number: Int
    var text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(HALiveActivityTheme.homeAssistant.accentColor, in: Circle())
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
    }
}

private struct SettingsButtonLabel: View {
    var title: String
    var systemImage: String

    init(_ title: String, systemImage: String) {
        self.title = title
        self.systemImage = systemImage
    }

    var body: some View {
        Label {
            Text(L10n.string(title))
        } icon: {
            Image(systemName: systemImage)
        }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .frame(maxWidth: .infinity, minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            .contentShape(Rectangle())
    }
}

private struct CopySnippetButton: View {
    var title: String
    var value: String
    @State private var didCopy = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            didCopy = true
        } label: {
            HStack {
                Label(L10n.string(title), systemImage: didCopy ? "checkmark.circle.fill" : "doc.on.doc")
                Spacer()
                Image(systemName: "square.on.square")
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline.weight(.semibold))
            .padding(12)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct SettingsInfoRow: View {
    var title: String
    var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.string(title))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private extension ImportantNoticeSeverity {
    var systemImage: String {
        switch self {
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .critical: "exclamationmark.shield.fill"
        }
    }

    var color: Color {
        switch self {
        case .info: HALiveActivityTheme.homeAssistant.accentColor
        case .warning: .orange
        case .critical: .red
        }
    }
}

private extension ImportantNoticeAction {
    var buttonTitle: String {
        switch self {
        case .none: L10n.string("Learn More")
        case .appStore: L10n.string("Open App Store")
        case .hacsInstructions: L10n.string("Open HACS Instructions")
        }
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
        .environment(AppUpdateService())
}

#if DEBUG
#Preview("Integration Guide") {
    NavigationStack {
        IntegrationGuideView(showsPrimaryActions: true)
    }
}
#endif
