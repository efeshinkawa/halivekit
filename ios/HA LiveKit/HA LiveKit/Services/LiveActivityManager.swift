import ActivityKit
import Foundation

@MainActor
final class LiveActivityManager {
    private(set) var activeActivities: [ActiveActivityRecord] = []
    private var nameRegistry: [String: ActivityNameRegistryEntry] = [:]

    func syncFromSystem() {
        let reusableActivities = Activity<HALiveActivityAttributes>.activities.filter(Self.isReusable)
        activeActivities = reusableActivities.map { activity in
            ActiveActivityRecord(
                id: activity.attributes.activityId,
                activityKitId: activity.id,
                title: activity.content.state.title,
                subtitle: activity.content.state.subtitle,
                entityId: activity.attributes.primaryEntityId,
                displayStyle: activity.content.state.displayStyle,
                theme: activity.content.state.theme,
                lastState: activity.content.state
            )
        }
        reconcileNameRegistry(from: reusableActivities)
    }

    func start(
        draft: LiveActivityDraft,
        allowsRemotePushUpdates: Bool = false,
        allowsEntityControl: Bool? = nil,
        entityControlHomeAssistantInstanceID: String? = nil,
        homeAssistantInstanceID: String? = nil
    ) async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw HALiveKitError.liveActivitiesDisabled
        }

        let activityId = draft.activityId ?? UUID().uuidString
        let state = EntityLiveActivityBuilder.build(
            EntityLiveActivityBuildInput(
                activityId: activityId,
                primaryEntity: draft.primaryEntity,
                secondaryEntity: draft.secondaryEntity,
                progressEntity: nil,
                template: draft.template,
                displayStyle: draft.displayStyle,
                displayName: draft.displayName,
                title: draft.title,
                subtitle: draft.subtitle,
                iconName: draft.iconName,
                theme: draft.theme,
                progress: nil,
                source: .app
            )
        ).contentState
        let existingActivities = matchingActivities(recordId: activityId)
        let currentActivity = Self.canonicalActivity(from: existingActivities)
        let entityControl = resolvedEntityControlConfiguration(
            requested: allowsEntityControl,
            requestedHomeAssistantInstanceID: entityControlHomeAssistantInstanceID,
            current: currentActivity,
            primaryEntity: draft.primaryEntity
        )
        let homeAssistantInstanceID = try validatedHomeAssistantInstanceID(
            homeAssistantInstanceID
        )
        let attributes = HALiveActivityAttributes(
            activityId: activityId,
            primaryEntityId: draft.primaryEntity.entityId,
            secondaryEntityId: draft.secondaryEntity?.entityId,
            template: draft.template,
            homeAssistantInstanceId: homeAssistantInstanceID,
            allowsEntityControl: entityControl.allowsEntityControl,
            entityControlHomeAssistantInstanceId: entityControl.homeAssistantInstanceID
        )
        try rejectDuplicateDisplayNameIfNeeded(state.displayName ?? state.title, excludingActivityId: activityId)
        if let currentActivity,
           currentActivity.attributes == attributes,
           await updateExistingActivityIfNeeded(recordId: activityId, state: state) {
            return
        }
        await endActivitiesImmediately(existingActivities)

        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(60 * 30))

        let pushType: PushType? = allowsRemotePushUpdates ? .token : nil
        _ = try Activity<HALiveActivityAttributes>.request(
            attributes: attributes,
            content: content,
            pushType: pushType
        )

        syncFromSystem()
    }

    func start(
        build: EntityLiveActivityBuild,
        allowsRemotePushUpdates: Bool = false,
        endExistingActivity: Bool = false,
        allowsEntityControl: Bool? = nil,
        entityControlHomeAssistantInstanceID: String? = nil,
        homeAssistantInstanceID: String? = nil
    ) async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw HALiveKitError.liveActivitiesDisabled
        }

        let existingActivities = matchingActivities(recordId: build.activityId)
        let currentActivity = Self.canonicalActivity(from: existingActivities)
        let entityControl = resolvedEntityControlConfiguration(
            requested: allowsEntityControl,
            requestedHomeAssistantInstanceID: entityControlHomeAssistantInstanceID,
            current: currentActivity,
            primaryEntity: build.draft.primaryEntity
        )
        let homeAssistantInstanceID = try validatedHomeAssistantInstanceID(
            homeAssistantInstanceID
        )
        let attributes = HALiveActivityAttributes(
            activityId: build.activityId,
            primaryEntityId: build.draft.primaryEntity.entityId,
            secondaryEntityId: build.draft.secondaryEntity?.entityId,
            template: build.draft.template,
            homeAssistantInstanceId: homeAssistantInstanceID,
            allowsEntityControl: entityControl.allowsEntityControl,
            entityControlHomeAssistantInstanceId: entityControl.homeAssistantInstanceID
        )
        try rejectDuplicateDisplayNameIfNeeded(
            build.contentState.displayName ?? build.contentState.title,
            excludingActivityId: build.activityId
        )
        if !endExistingActivity,
           let currentActivity,
           currentActivity.attributes == attributes,
           await updateExistingActivityIfNeeded(recordId: build.activityId, state: build.contentState) {
            return
        }
        await endActivitiesImmediately(existingActivities)

        let content = ActivityContent(state: build.contentState, staleDate: Date().addingTimeInterval(60 * 30))
        let pushType: PushType? = allowsRemotePushUpdates ? .token : nil
        _ = try Activity<HALiveActivityAttributes>.request(
            attributes: attributes,
            content: content,
            pushType: pushType
        )

        syncFromSystem()
    }

    func contains(recordId: String) -> Bool {
        !matchingActivities(recordId: recordId).isEmpty
    }

    func updateActivities(for entity: HAEntity, allEntities: [HAEntity]) async {
        let matching = Activity<HALiveActivityAttributes>.activities.filter { activity in
            activity.attributes.primaryEntityId == entity.entityId || activity.attributes.secondaryEntityId == entity.entityId
        }

        for activity in matching {
            let current = activity.content.state
            let primaryEntity = allEntities.first(where: { $0.entityId == activity.attributes.primaryEntityId }) ?? entity
            let secondaryEntity = activity.attributes.secondaryEntityId.flatMap { id in
                allEntities.first(where: { $0.entityId == id })
            }

            let updated = EntityLiveActivityBuilder.build(
                EntityLiveActivityBuildInput(
                    activityId: activity.attributes.activityId,
                    primaryEntity: primaryEntity,
                    secondaryEntity: secondaryEntity,
                    progressEntity: nil,
                    template: activity.attributes.template,
                    displayStyle: current.displayStyle,
                    displayName: current.displayName,
                    title: current.title,
                    subtitle: nil,
                    iconName: current.iconName,
                    theme: current.theme,
                    progress: nil,
                    source: .app
                )
            ).contentState

            await activity.update(ActivityContent(state: updated, staleDate: Date().addingTimeInterval(60 * 30)))

            if shouldAutoEnd(activity: activity, state: updated) {
                await activity.end(ActivityContent(state: updated, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(60 * 10)))
            }
        }

        syncFromSystem()
    }

    func refresh(recordId: String, allEntities: [HAEntity]) async throws {
        guard let record = activeActivities.first(where: { $0.id == recordId }) else {
            throw HALiveKitError.activityNotFound
        }

        guard let entity = allEntities.first(where: { $0.entityId == record.entityId }) else {
            throw HALiveKitError.message("The primary entity is not in the current Home Assistant state list.")
        }

        await updateActivities(for: entity, allEntities: allEntities)
    }

    func update(
        recordId: String,
        title: String?,
        subtitle: String?,
        displayName: String?,
        primaryState: String?,
        secondaryState: String?,
        progress: Double?,
        value: String?,
        unit: String?
    ) async throws {
        guard let activity = Self.canonicalActivity(from: matchingActivities(recordId: recordId)) else {
            throw HALiveKitError.activityNotFound
        }

        let current = activity.content.state
        let updated = HALiveActivityAttributes.ContentState(
            title: title ?? current.title,
            subtitle: subtitle ?? current.subtitle,
            displayName: displayName ?? current.displayName,
            entityId: current.entityId,
            primaryState: primaryState ?? current.primaryState,
            secondaryState: secondaryState ?? current.secondaryState,
            progress: progress ?? current.progress,
            value: value ?? current.value,
            unit: unit ?? current.unit,
            iconName: current.iconName,
            theme: current.theme,
            displayStyle: current.displayStyle,
            lastUpdated: .now
        )

        try await update(recordId: recordId, state: updated)
    }

    func update(recordId: String, state: HALiveActivityAttributes.ContentState) async throws {
        let activities = matchingActivities(recordId: recordId)
        guard let activity = Self.canonicalActivity(from: activities) else {
            throw HALiveKitError.activityNotFound
        }
        guard !activity.attributes.isEntityControlEnabled
                || state.entityId == activity.attributes.primaryEntityId
        else {
            throw HALiveKitError.invalidResponse
        }
        guard await updateExistingActivityIfNeeded(recordId: recordId, state: state) else {
            throw HALiveKitError.activityNotFound
        }
    }

    func end(recordId: String) async throws {
        let activities = matchingActivities(recordId: recordId)
        guard !activities.isEmpty else {
            throw HALiveKitError.activityNotFound
        }

        for activity in activities {
            let finalState = activity.content.state
            await activity.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: .immediate)
        }
        syncFromSystem()
    }

    func reconcileDuplicateActivities() async {
        let grouped = Dictionary(grouping: Activity<HALiveActivityAttributes>.activities.filter(Self.isReusable)) {
            $0.attributes.activityId
        }
        for activities in grouped.values where activities.count > 1 {
            guard let keeper = Self.canonicalActivity(from: activities) else { continue }
            for activity in activities where activity.id != keeper.id {
                let finalState = activity.content.state
                await activity.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: .immediate)
            }
        }
        syncFromSystem()
    }

    private func updateExistingActivityIfNeeded(
        recordId: String,
        state: HALiveActivityAttributes.ContentState
    ) async -> Bool {
        let activities = matchingActivities(recordId: recordId)
        guard let activity = Self.canonicalActivity(from: activities) else {
            return false
        }

        await activity.update(ActivityContent(state: state, staleDate: Date().addingTimeInterval(60 * 30)))
        for duplicate in activities where duplicate.id != activity.id {
            let finalState = duplicate.content.state
            await duplicate.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: .immediate)
        }
        syncFromSystem()
        return true
    }

    private func resolvedEntityControlConfiguration(
        requested: Bool?,
        requestedHomeAssistantInstanceID: String?,
        current: Activity<HALiveActivityAttributes>?,
        primaryEntity: HAEntity
    ) -> (allowsEntityControl: Bool?, homeAssistantInstanceID: String?) {
        guard Self.supportsEntityControl(primaryEntity) else {
            return (nil, nil)
        }

        if let requested {
            guard requested,
                  let requestedHomeAssistantInstanceID,
                  HomeAssistantInstanceIdentity.isSafeIdentifier(requestedHomeAssistantInstanceID)
            else {
                return (nil, nil)
            }
            return (true, requestedHomeAssistantInstanceID)
        }

        guard let current,
              current.attributes.primaryEntityId == primaryEntity.entityId,
              current.attributes.isEntityControlEnabled,
              let currentInstanceID = current.attributes.entityControlHomeAssistantInstanceId,
              HomeAssistantInstanceIdentity.isSafeIdentifier(currentInstanceID),
              currentInstanceID == requestedHomeAssistantInstanceID
        else {
            return (nil, nil)
        }
        return (true, currentInstanceID)
    }

    private func validatedHomeAssistantInstanceID(_ instanceID: String?) throws -> String? {
        guard let instanceID else { return nil }
        guard HomeAssistantInstanceIdentity.isSafeIdentifier(instanceID) else {
            throw HALiveKitError.invalidResponse
        }
        return instanceID
    }

    private static func supportsEntityControl(_ entity: HAEntity) -> Bool {
        switch entity.domain {
        case .light, .switch, .inputBoolean:
            true
        default:
            false
        }
    }

    private func endActivitiesImmediately(
        _ activities: [Activity<HALiveActivityAttributes>]
    ) async {
        for activity in activities {
            let finalState = activity.content.state
            await activity.end(
                ActivityContent(state: finalState, staleDate: nil),
                dismissalPolicy: .immediate
            )
        }
        if !activities.isEmpty {
            syncFromSystem()
        }
    }

    private func rejectDuplicateDisplayNameIfNeeded(_ displayName: String?, excludingActivityId activityId: String) throws {
        syncFromSystem()
        let displayNameKey = Self.normalizedDisplayNameKey(displayName)
        guard !displayNameKey.isEmpty else { return }

        let hasConflict = nameRegistry.values.contains { entry in
            entry.displayNameKey == displayNameKey && entry.activityId != activityId
        }
        if hasConflict {
            throw HALiveKitError.duplicateActivityName
        }
    }

    private func reconcileNameRegistry(from activities: [Activity<HALiveActivityAttributes>]) {
        nameRegistry = Dictionary(
            uniqueKeysWithValues: activities
                .filter(Self.reservesDisplayName)
                .compactMap { activity -> (String, ActivityNameRegistryEntry)? in
                    let displayName = activity.content.state.displayName ?? activity.content.state.title
                    let displayNameKey = Self.normalizedDisplayNameKey(displayName)
                    guard !displayNameKey.isEmpty else { return nil }
                    return (
                        activity.id,
                        ActivityNameRegistryEntry(
                            activityId: activity.attributes.activityId,
                            activityKitId: activity.id,
                            displayNameKey: displayNameKey
                        )
                    )
                }
        )
    }

    private func matchingActivities(recordId: String) -> [Activity<HALiveActivityAttributes>] {
        Activity<HALiveActivityAttributes>.activities.filter {
            $0.attributes.activityId == recordId && Self.isReusable($0)
        }
    }

    private static func canonicalActivity(
        from activities: [Activity<HALiveActivityAttributes>]
    ) -> Activity<HALiveActivityAttributes>? {
        activities.max { left, right in
            left.content.state.lastUpdated < right.content.state.lastUpdated
        }
    }

    private static func isReusable(_ activity: Activity<HALiveActivityAttributes>) -> Bool {
        switch activity.activityState {
        case .active, .pending, .stale:
            return true
        case .ended, .dismissed:
            return false
        @unknown default:
            return true
        }
    }

    private static func reservesDisplayName(_ activity: Activity<HALiveActivityAttributes>) -> Bool {
        switch activity.activityState {
        case .active, .pending:
            return true
        case .stale, .ended, .dismissed:
            return false
        @unknown default:
            return true
        }
    }

    private static func normalizedDisplayNameKey(_ value: String?) -> String {
        (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
    }

    private func shouldAutoEnd(
        activity: Activity<HALiveActivityAttributes>,
        state: HALiveActivityAttributes.ContentState
    ) -> Bool {
        let lower = state.primaryState.lowercased()
        switch state.displayStyle {
        case .progress, .timer:
            return ["finished", "complete", "done", "00:00:00"].contains(lower)
        case .vacuum:
            return ["idle", "docked", "returning"].contains(lower)
        default:
            return false
        }
    }
}

private struct ActivityNameRegistryEntry: Hashable {
    var activityId: String
    var activityKitId: String
    var displayNameKey: String
}
