import ActivityKit
import AppIntents
import Foundation

struct OpenHALiveKitIntent: AppIntent {
    static var title: LocalizedStringResource = "Open HA LiveKit"
    static var description = IntentDescription("Open the HA LiveKit dashboard.")
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

struct StartLiveActivityIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Start Custom Live Activity"
    static var description = IntentDescription("Advanced manual action for starting a custom HA LiveKit Live Activity.")
    // LiveActivityIntent lets Activity.request run after iOS launches the
    // app process in the background, without presenting the app's UI.
    static var openAppWhenRun = false

    @Parameter(title: "Activity ID")
    var activityID: String?

    @Parameter(title: "Title")
    var titleText: String?

    @Parameter(title: "Subtitle")
    var subtitle: String?

    @Parameter(title: "Template")
    var template: ShortcutTemplateOption?

    @Parameter(title: "Display Style")
    var displayStyle: ShortcutDisplayStyleOption?

    @Parameter(title: "Entity ID")
    var entityID: String?

    @Parameter(title: "Display Name")
    var displayName: String?

    @Parameter(title: "Demo Scenario")
    var demoScenario: ShortcutDemoScenarioOption?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message: String
        do {
            message = try await IntentLiveActivityService().start(
                activityID: activityID,
                title: titleText,
                subtitle: subtitle,
                template: template?.template,
                displayStyle: displayStyle?.displayStyle,
                entityID: entityID,
                displayName: displayName,
                demoScenario: demoScenario?.scenario
            )
        } catch {
            message = IntentLiveActivityService.intentErrorMessage(error)
        }
        return .result(dialog: "\(message)")
    }
}

struct EndLiveActivityIntent: AppIntent {
    static var title: LocalizedStringResource = "End Live Activity"
    static var description = IntentDescription("End a HA LiveKit Live Activity by Activity ID.")
    static var openAppWhenRun = false

    @Parameter(title: "Activity ID")
    var activityID: String?

    @Parameter(title: "End reason")
    var endReason: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = await IntentLiveActivityService().end(activityID: activityID, reason: endReason)
        return .result(dialog: "\(message)")
    }
}

struct UpdateLiveActivityIntent: AppIntent {
    static var title: LocalizedStringResource = "Update Custom Live Activity"
    static var description = IntentDescription("Update the title, state, subtitle or progress of an existing HA LiveKit Live Activity.")
    static var openAppWhenRun = false

    @Parameter(title: "Activity ID")
    var activityID: String?

    @Parameter(title: "Title")
    var titleText: String?

    @Parameter(title: "Subtitle")
    var subtitle: String?

    @Parameter(title: "State")
    var state: String?

    @Parameter(title: "Progress")
    var progress: Double?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = await IntentLiveActivityService().update(
            activityID: activityID,
            title: titleText,
            subtitle: subtitle,
            state: state,
            progress: progress
        )
        return .result(dialog: "\(message)")
    }
}

struct StartEntityLiveActivityIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Start Entity Live Activity"
    static var description = IntentDescription("Start a Live Activity from a Home Assistant entity using the same entity-based layout as the app.")
    // LiveActivityIntent grants the local ActivityKit start while the app's
    // process remains in the background. Update/End are background-capable too.
    static var openAppWhenRun = false

    static var parameterSummary: some ParameterSummary {
        Summary("Start \(\.$entity)") {
            \.$template
            \.$endExistingActivity
            \.$showWhenRun
        }
    }

    @Parameter(title: "Entity")
    var entity: HAEntityShortcutEntity?

    @Parameter(title: "Entity ID")
    var entityID: String?

    @Parameter(title: "Activity ID")
    var activityID: String?

    @Parameter(title: "Template", default: .auto)
    var template: ShortcutTemplateOption

    @Parameter(title: "Display Name")
    var displayName: String?

    @Parameter(title: "End Existing Activity")
    var endExistingActivity: Bool?

    @Parameter(title: "Show When Run")
    var showWhenRun: Bool?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = await IntentLiveActivityService().startEntity(
            entity: entity,
            entityID: entityID,
            activityID: activityID,
            template: template.template,
            displayName: displayName,
            endExistingActivity: endExistingActivity
        )
        return .result(dialog: "\(message)")
    }
}

struct UpdateEntityLiveActivityIntent: AppIntent {
    static var title: LocalizedStringResource = "Update Entity Live Activity"
    static var description = IntentDescription("Update a Live Activity from the latest Home Assistant entity state.")
    static var openAppWhenRun = false

    static var parameterSummary: some ParameterSummary {
        Summary("Update \(\.$entity)") {
            \.$template
        }
    }

    @Parameter(title: "Entity")
    var entity: HAEntityShortcutEntity?

    @Parameter(title: "Entity ID")
    var entityID: String?

    @Parameter(title: "Activity ID")
    var activityID: String?

    @Parameter(title: "Template", default: .auto)
    var template: ShortcutTemplateOption

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = await IntentLiveActivityService().updateEntity(
            entity: entity,
            entityID: entityID,
            activityID: activityID,
            template: template.template
        )
        return .result(dialog: "\(message)")
    }
}

struct EndEntityLiveActivityIntent: AppIntent {
    static var title: LocalizedStringResource = "End Entity Live Activity"
    static var description = IntentDescription("End a Live Activity by entity or Activity ID.")
    static var openAppWhenRun = false

    static var parameterSummary: some ParameterSummary {
        Summary("End \(\.$entity)") {
            \.$reason
        }
    }

    @Parameter(title: "Entity")
    var entity: HAEntityShortcutEntity?

    @Parameter(title: "Entity ID")
    var entityID: String?

    @Parameter(title: "Activity ID")
    var activityID: String?

    @Parameter(title: "Reason")
    var reason: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = await IntentLiveActivityService().endEntity(
            entity: entity,
            entityID: entityID,
            activityID: activityID,
            reason: reason
        )
        return .result(dialog: "\(message)")
    }
}

struct HAEntityShortcutEntity: AppEntity, Identifiable {
    var id: String { entityID }
    var entityID: String
    var friendlyName: String
    var domain: String
    var state: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Home Assistant Entity"
    static let defaultQuery = HAEntityShortcutQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(friendlyName)",
            subtitle: "\(entityID) - \(state)"
        )
    }

    init(entity: HAEntity) {
        self.entityID = entity.entityId
        self.friendlyName = entity.friendlyName
        self.domain = entity.domain.rawValue
        self.state = EntityLiveActivityBuilder.humanReadableState(for: entity)
    }
}

struct HAEntityShortcutQuery: EntityQuery {
    func entities(for identifiers: [HAEntityShortcutEntity.ID]) async throws -> [HAEntityShortcutEntity] {
        let resolver = HAEntityShortcutResolver()
        let entities = await resolver.entities(matching: identifiers)
        return entities.map(HAEntityShortcutEntity.init(entity:))
    }

    func suggestedEntities() async throws -> [HAEntityShortcutEntity] {
        let resolver = HAEntityShortcutResolver()
        return await resolver.suggestedEntities().map(HAEntityShortcutEntity.init(entity:))
    }

    func defaultResult() async -> HAEntityShortcutEntity? {
        let resolver = HAEntityShortcutResolver()
        return await resolver.suggestedEntities().first.map(HAEntityShortcutEntity.init(entity:))
    }
}

enum ShortcutTemplateOption: String, AppEnum {
    case auto
    case custom
    case progress
    case washingMachine
    case dishwasher
    case vacuum
    case security
    case climate
    case energy
    case timer

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Template")
    static var caseDisplayRepresentations: [ShortcutTemplateOption: DisplayRepresentation] = [
        .auto: DisplayRepresentation(title: "Auto"),
        .custom: DisplayRepresentation(title: "Custom"),
        .progress: DisplayRepresentation(title: "Progress"),
        .washingMachine: DisplayRepresentation(title: "Washing Machine"),
        .dishwasher: DisplayRepresentation(title: "Dishwasher"),
        .vacuum: DisplayRepresentation(title: "Vacuum Cleaner"),
        .security: DisplayRepresentation(title: "Door / Security"),
        .climate: DisplayRepresentation(title: "Climate"),
        .energy: DisplayRepresentation(title: "Energy / Plug"),
        .timer: DisplayRepresentation(title: "Timer")
    ]

    var template: HALiveActivityTemplateKind? {
        guard self != .auto else { return nil }
        return HALiveActivityTemplateKind(rawValue: rawValue) ?? .custom
    }
}

enum ShortcutDisplayStyleOption: String, AppEnum {
    case compactStatus
    case progress
    case timer
    case security
    case energy
    case vacuum
    case climate
    case doorWindow

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Display Style")
    static var caseDisplayRepresentations: [ShortcutDisplayStyleOption: DisplayRepresentation] = [
        .compactStatus: DisplayRepresentation(title: "Compact Status"),
        .progress: DisplayRepresentation(title: "Progress"),
        .timer: DisplayRepresentation(title: "Timer"),
        .security: DisplayRepresentation(title: "Security"),
        .energy: DisplayRepresentation(title: "Energy"),
        .vacuum: DisplayRepresentation(title: "Vacuum"),
        .climate: DisplayRepresentation(title: "Climate"),
        .doorWindow: DisplayRepresentation(title: "Door / Window")
    ]

    var displayStyle: HALiveActivityDisplayStyle {
        HALiveActivityDisplayStyle(rawValue: rawValue) ?? .compactStatus
    }
}

enum ShortcutDemoScenarioOption: String, AppEnum {
    case none
    case doorOpened
    case laundryRunning
    case laundryProgressUpdate
    case vacuumCleaning
    case climateHeatingCooling
    case energySpike

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Demo Scenario")
    static var caseDisplayRepresentations: [ShortcutDemoScenarioOption: DisplayRepresentation] = [
        .none: DisplayRepresentation(title: "None"),
        .doorOpened: DisplayRepresentation(title: "Door opened"),
        .laundryRunning: DisplayRepresentation(title: "Laundry running"),
        .laundryProgressUpdate: DisplayRepresentation(title: "Laundry progress update"),
        .vacuumCleaning: DisplayRepresentation(title: "Vacuum cleaning"),
        .climateHeatingCooling: DisplayRepresentation(title: "Climate heating/cooling"),
        .energySpike: DisplayRepresentation(title: "Energy spike")
    ]

    var scenario: DemoScenario? {
        guard self != .none else { return nil }
        return DemoScenario(rawValue: rawValue)
    }
}

struct HALiveKitShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartEntityLiveActivityIntent(),
            phrases: [
                "Start entity Live Activity in \(.applicationName)",
                "Start Home Assistant entity in \(.applicationName)"
            ],
            shortTitle: "Start Entity",
            systemImageName: "livephoto"
        )

        AppShortcut(
            intent: UpdateEntityLiveActivityIntent(),
            phrases: [
                "Update entity Live Activity in \(.applicationName)",
                "Refresh Home Assistant entity in \(.applicationName)"
            ],
            shortTitle: "Update Entity",
            systemImageName: "arrow.triangle.2.circlepath"
        )

        AppShortcut(
            intent: EndEntityLiveActivityIntent(),
            phrases: [
                "End entity Live Activity in \(.applicationName)",
                "Stop Home Assistant entity in \(.applicationName)"
            ],
            shortTitle: "End Entity",
            systemImageName: "stop.circle"
        )

        AppShortcut(
            intent: StartLiveActivityIntent(),
            phrases: [
                "Start custom Live Activity in \(.applicationName)",
                "Start custom HA LiveKit activity in \(.applicationName)"
            ],
            shortTitle: "Start Custom",
            systemImageName: "slider.horizontal.3"
        )

        AppShortcut(
            intent: OpenHALiveKitIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Show Home Assistant in \(.applicationName)"
            ],
            shortTitle: "Open HA LiveKit",
            systemImageName: "livephoto"
        )
    }
}

private struct HAEntityShortcutResolver {
    func entities(matching identifiers: [String]) async -> [HAEntity] {
        guard !identifiers.isEmpty else { return [] }
        let allEntities = await suggestedEntities()
        let matched = allEntities.filter { identifiers.contains($0.entityId) }
        if matched.count == identifiers.count {
            return matched
        }

        var resolved = matched
        for identifier in identifiers where !resolved.contains(where: { $0.entityId == identifier }) {
            if let fetched = await fetchRealEntity(entityID: identifier) {
                resolved.append(fetched)
            }
        }
        return resolved.sorted { $0.entityId.localizedStandardCompare($1.entityId) == .orderedAscending }
    }

    func suggestedEntities() async -> [HAEntity] {
        if UserDefaults.standard.bool(forKey: HALiveKitDefaults.demoModeEnabledKey) {
            return await MainActor.run {
                DemoHomeProvider().currentEntities()
            }
        }

        let cached = HAEntityCacheStore().load()
        if !cached.isEmpty {
            return cached
        }

        guard let fetched = await fetchAllRealEntities() else {
            return []
        }
        await HAEntityCacheStore().save(fetched)
        return fetched
    }

    func resolve(selection: HAEntityShortcutEntity?, entityID: String?) async -> HAEntity? {
        let requestedID = trimmed(entityID) ?? selection?.entityID
        if UserDefaults.standard.bool(forKey: HALiveKitDefaults.demoModeEnabledKey) {
            return await MainActor.run {
                let provider = DemoHomeProvider()
                if let requestedID {
                    return provider.entity(withId: requestedID)
                }
                return selection.flatMap { provider.entity(withId: $0.entityID) }
                    ?? provider.currentEntities().first
            }
        }

        if let requestedID {
            if let cached = HAEntityCacheStore().entity(withID: requestedID) {
                return cached
            }
            if let fetched = await fetchRealEntity(entityID: requestedID) {
                return fetched
            }
        }

        if let selection {
            if let cached = HAEntityCacheStore().entity(withID: selection.entityID) {
                return cached
            }
            return await fetchRealEntity(entityID: selection.entityID)
        }

        return nil
    }

    private func fetchRealEntity(entityID: String) async -> HAEntity? {
        do {
            guard let configuration = try KeychainCredentialStore().load() else { return nil }
            let client = try await resolveClient(configuration: configuration)
            return try await client.fetchState(entityID: entityID)
        } catch {
            return nil
        }
    }

    private func fetchAllRealEntities() async -> [HAEntity]? {
        do {
            guard let configuration = try KeychainCredentialStore().load() else { return nil }
            let client = try await resolveClient(configuration: configuration)
            let (entities, _) = try await client.fetchStates()
            return entities
        } catch {
            return nil
        }
    }

    private func resolveClient(configuration: ConnectionConfiguration) async throws -> HomeAssistantClient {
        let candidates = configuration.orderedCandidateURLs
        if candidates.count <= 1 {
            return HomeAssistantClient(configuration: configuration)
        }
        let resolver = HomeAssistantConnectionResolver(configuration: configuration)
        let resolved = try await resolver.resolve()
        return resolved.client
    }

    private func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

@MainActor
private struct IntentLiveActivityService {
    func startEntity(
        entity: HAEntityShortcutEntity?,
        entityID: String?,
        activityID: String?,
        template: HALiveActivityTemplateKind?,
        displayName: String?,
        endExistingActivity: Bool?
    ) async -> String {
        // This runs inside a LiveActivityIntent, so the local ActivityKit
        // request remains immediate and does not need to present the app UI.
        guard let resolvedEntity = await HAEntityShortcutResolver().resolve(selection: entity, entityID: entityID) else {
            return L10n.string("Entity not found or Home Assistant is not connected.")
        }

        do {
            let build = EntityLiveActivityBuilder.build(
                EntityLiveActivityBuildInput(
                    activityId: trimmed(activityID),
                    primaryEntity: resolvedEntity,
                    secondaryEntity: nil,
                    progressEntity: nil,
                    template: template,
                    displayStyle: nil,
                    displayName: trimmed(displayName),
                    title: nil,
                    subtitle: nil,
                    iconName: nil,
                    theme: nil,
                    progress: nil,
                    source: .shortcuts
                )
            )
            try await LiveActivityManager().start(
                build: build,
                allowsRemotePushUpdates: false,
                endExistingActivity: endExistingActivity ?? false
            )
            return L10n.format("Started or updated Live Activity %@.", build.activityId)
        } catch {
            return Self.intentErrorMessage(error)
        }
    }

    func updateEntity(
        entity: HAEntityShortcutEntity?,
        entityID: String?,
        activityID: String?,
        template: HALiveActivityTemplateKind?
    ) async -> String {
        guard let resolvedEntity = await HAEntityShortcutResolver().resolve(selection: entity, entityID: entityID) else {
            return L10n.string("Entity not found or Home Assistant is not connected.")
        }

        let build = EntityLiveActivityBuilder.build(
            EntityLiveActivityBuildInput(
                activityId: trimmed(activityID),
                primaryEntity: resolvedEntity,
                secondaryEntity: nil,
                progressEntity: nil,
                template: template,
                displayStyle: nil,
                displayName: nil,
                title: nil,
                subtitle: nil,
                iconName: nil,
                theme: nil,
                progress: nil,
                source: .shortcuts
            )
        )

        do {
            try await LiveActivityManager().update(recordId: build.activityId, state: build.contentState)
            return L10n.format("Updated Live Activity %@.", build.activityId)
        } catch {
            return L10n.format("No Live Activity found for %@.", build.activityId)
        }
    }

    func endEntity(
        entity: HAEntityShortcutEntity?,
        entityID: String?,
        activityID: String?,
        reason: String?
    ) async -> String {
        let resolvedActivityID = trimmed(activityID)
            ?? trimmed(entityID).map(EntityLiveActivityBuilder.activityID(for:))
            ?? entity.map { EntityLiveActivityBuilder.activityID(for: $0.entityID) }

        guard let resolvedActivityID else {
            return L10n.string("Choose an entity or enter an Activity ID.")
        }

        do {
            try await LiveActivityManager().end(recordId: resolvedActivityID)
            if let reason = trimmed(reason) {
                return L10n.format("Ended Live Activity %@: %@.", resolvedActivityID, reason)
            }
            return L10n.format("Ended Live Activity %@.", resolvedActivityID)
        } catch {
            return L10n.format("No Live Activity found for %@.", resolvedActivityID)
        }
    }

    func start(
        activityID: String?,
        title: String?,
        subtitle: String?,
        template: HALiveActivityTemplateKind?,
        displayStyle: HALiveActivityDisplayStyle?,
        entityID: String?,
        displayName: String?,
        demoScenario: DemoScenario?
    ) async throws -> String {
        // LiveActivityIntent permits the local ActivityKit request while iOS
        // keeps the app UI closed, preserving immediate device-side feedback.
        if let demoScenario {
            let provider = DemoHomeProvider()
            let payload = provider.apply(demoScenario)
            try await start(payload: payload)
            return L10n.format("Started Live Activity %@.", payload.activityId)
        }

        let isDemoMode = UserDefaults.standard.bool(forKey: HALiveKitDefaults.demoModeEnabledKey)
        let provider = DemoHomeProvider()
        let resolvedEntity = await resolveEntity(entityID: entityID, displayName: displayName, title: title, isDemoMode: isDemoMode, provider: provider)
        let resolvedActivityID = trimmed(activityID)
            ?? trimmed(entityID).map { EntityLiveActivityBuilder.activityID(for: $0) }
            ?? "shortcut_activity"
        let resolvedTemplate = template ?? EntityLiveActivityBuilder.inferredTemplate(for: resolvedEntity)
        let resolvedDisplayStyle = displayStyle ?? resolvedTemplate.displayStyle
        let resolvedDisplayName = trimmed(displayName) ?? resolvedEntity.friendlyName
        let resolvedTitle = trimmed(title) ?? resolvedDisplayName
        let resolvedSubtitle = trimmed(subtitle) ?? resolvedEntity.state

        let draft = LiveActivityDraft(
            activityId: resolvedActivityID,
            title: resolvedTitle,
            subtitle: resolvedSubtitle,
            displayName: resolvedDisplayName,
            primaryEntity: resolvedEntity,
            secondaryEntity: nil,
            displayStyle: resolvedDisplayStyle,
            template: resolvedTemplate,
            iconName: resolvedEntity.suggestedIconName,
            theme: .homeAssistant
        )

        let manager = LiveActivityManager()
        try await manager.start(draft: draft, allowsRemotePushUpdates: false)
        return L10n.format("Started or updated Live Activity %@.", resolvedActivityID)
    }

    func update(
        activityID: String?,
        title: String?,
        subtitle: String?,
        state: String?,
        progress: Double?
    ) async -> String {
        guard let activityID = trimmed(activityID) else {
            return L10n.string("Activity ID is required to update a Live Activity.")
        }

        do {
            let manager = LiveActivityManager()
            try await manager.update(
                recordId: activityID,
                title: trimmed(title),
                subtitle: trimmed(subtitle),
                displayName: nil,
                primaryState: trimmed(state),
                secondaryState: nil,
                progress: normalizedProgress(progress),
                value: trimmed(state),
                unit: nil
            )
            return L10n.format("Updated Live Activity %@.", activityID)
        } catch {
            return L10n.string("No Live Activity found for this ID.")
        }
    }

    func end(activityID: String?, reason: String?) async -> String {
        guard let activityID = trimmed(activityID) else {
            return L10n.string("Activity ID is required to end a Live Activity.")
        }

        do {
            let manager = LiveActivityManager()
            try await manager.end(recordId: activityID)
            if let reason = trimmed(reason) {
                return L10n.format("Ended Live Activity %@: %@.", activityID, reason)
            }
            return L10n.format("Ended Live Activity %@.", activityID)
        } catch {
            return L10n.string("No Live Activity found for this ID.")
        }
    }

    private func start(payload: DemoScenarioPayload) async throws {
        let manager = LiveActivityManager()
        try await manager.start(draft: payload.draft, allowsRemotePushUpdates: false)
        try await manager.update(
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

    private func resolveEntity(
        entityID: String?,
        displayName: String?,
        title: String?,
        isDemoMode: Bool,
        provider: DemoHomeProvider
    ) async -> HAEntity {
        if isDemoMode {
            let requested = trimmed(entityID)
            return requested.flatMap { provider.entity(withId: $0) }
                ?? provider.entity(withId: "binary_sensor.front_door")
                ?? provider.currentEntities()[0]
        }

        if let entityID = trimmed(entityID),
           let realEntity = await fetchRealEntity(entityID: entityID) {
            return realEntity
        }

        let fallbackID = trimmed(entityID) ?? "ha_livekit.shortcut"
        return HAEntity(
            entityId: fallbackID,
            state: L10n.string("unknown"),
            attributes: .init(
                friendlyName: trimmed(displayName) ?? trimmed(title) ?? fallbackID,
                icon: nil,
                unitOfMeasurement: nil,
                deviceClass: nil,
                batteryLevel: nil,
                currentTemperature: nil,
                temperature: nil,
                hvacMode: nil
            ),
            lastChanged: .now,
            lastUpdated: .now
        )
    }

    private func fetchRealEntity(entityID: String) async -> HAEntity? {
        do {
            guard let configuration = try KeychainCredentialStore().load() else {
                return nil
            }
            let client = try await resolveClient(configuration: configuration)
            return try await client.fetchState(entityID: entityID)
        } catch {
            return nil
        }
    }

    private func resolveClient(configuration: ConnectionConfiguration) async throws -> HomeAssistantClient {
        let candidates = configuration.orderedCandidateURLs
        if candidates.count <= 1 {
            return HomeAssistantClient(configuration: configuration)
        }
        let resolver = HomeAssistantConnectionResolver(configuration: configuration)
        let resolved = try await resolver.resolve()
        return resolved.client
    }

    private func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizedProgress(_ value: Double?) -> Double? {
        guard let value else { return nil }
        let normalized = value > 1 ? value / 100 : value
        return min(max(normalized, 0), 1)
    }

    nonisolated static func intentErrorMessage(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
