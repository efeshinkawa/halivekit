import Foundation

enum EntityActivitySource: String, Hashable {
    case app
    case homeAssistant
    case shortcuts
    case demo
}

struct EntityLiveActivityBuildInput: Hashable {
    var activityId: String?
    var primaryEntity: HAEntity
    var secondaryEntity: HAEntity?
    var progressEntity: HAEntity?
    var template: HALiveActivityTemplateKind?
    var displayStyle: HALiveActivityDisplayStyle?
    var displayName: String?
    var title: String?
    var subtitle: String?
    var iconName: String?
    var theme: HALiveActivityTheme?
    var progress: Double?
    var source: EntityActivitySource
}

struct EntityLiveActivityBuild: Hashable {
    var activityId: String
    var draft: LiveActivityDraft
    var contentState: HALiveActivityAttributes.ContentState
}

enum EntityLiveActivityBuilder {
    static func build(_ input: EntityLiveActivityBuildInput) -> EntityLiveActivityBuild {
        let entity = input.primaryEntity
        let template = input.template ?? inferredTemplate(for: entity, progressEntity: input.progressEntity)
        let templateDefaults = LiveActivityTemplate.defaults.first { $0.id == template }
        let displayStyle = input.displayStyle ?? templateDefaults?.style ?? template.displayStyle
        let displayName = clean(input.displayName) ?? entity.friendlyName
        let title = clean(input.title) ?? displayName
        let primaryState = humanReadableState(for: entity, template: template)
        let secondaryState = secondaryState(for: entity, secondaryEntity: input.secondaryEntity, progressEntity: input.progressEntity, template: template)
        let progress = normalizedProgress(input.progress)
            ?? progressValue(for: input.progressEntity, style: displayStyle, allowUnitlessState: true)
            ?? progressValue(for: entity, style: displayStyle, allowUnitlessState: false)
        let value = entity.state
        let unit = entity.displayUnit
        let iconName = clean(input.iconName) ?? iconName(for: entity, template: template) ?? templateDefaults?.iconName ?? entity.suggestedIconName
        let theme = input.theme ?? templateDefaults?.theme ?? .homeAssistant
        let subtitle = clean(input.subtitle) ?? subtitleText(
            for: entity,
            displayName: displayName,
            primaryState: primaryState,
            secondaryState: secondaryState,
            progressEntity: input.progressEntity,
            template: template
        )
        let activityId = clean(input.activityId) ?? activityID(for: entity.entityId)

        let draft = LiveActivityDraft(
            activityId: activityId,
            title: title,
            subtitle: subtitle,
            displayName: displayName,
            primaryEntity: entity,
            secondaryEntity: input.secondaryEntity,
            displayStyle: displayStyle,
            template: template,
            iconName: iconName,
            theme: theme
        )
        let contentState = HALiveActivityAttributes.ContentState(
            title: title,
            subtitle: subtitle,
            displayName: displayName,
            entityId: entity.entityId,
            primaryState: primaryState,
            secondaryState: secondaryState,
            progress: progress,
            value: value,
            unit: unit,
            iconName: iconName,
            theme: theme,
            displayStyle: displayStyle,
            lastUpdated: .now
        )

        return EntityLiveActivityBuild(activityId: activityId, draft: draft, contentState: contentState)
    }

    static func activityID(for entityID: String) -> String {
        let objectID = entityID.split(separator: ".", maxSplits: 1).last.map(String.init) ?? entityID
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        let sanitized = objectID.unicodeScalars.map { scalar in
            allowed.contains(scalar) ? String(scalar) : "_"
        }
        let collapsed = sanitized
            .joined()
            .split(separator: "_", omittingEmptySubsequences: true)
            .joined(separator: "_")
        return collapsed.isEmpty ? "ha_livekit_activity" : collapsed
    }

    static func inferredTemplate(for entity: HAEntity, progressEntity: HAEntity? = nil) -> HALiveActivityTemplateKind {
        switch entity.domain {
        case .binarySensor:
            if doorDeviceClasses.contains(entity.attributes.normalizedDeviceClass) {
                return .security
            }
            return .custom
        case .lock:
            return .security
        case .vacuum:
            return .vacuum
        case .climate:
            return .climate
        case .timer:
            return .timer
        case .sensor:
            if progressEntity != nil {
                return .washingMachine
            }
            switch entity.attributes.normalizedDeviceClass {
            case "power", "energy", "voltage", "current":
                return .energy
            case "temperature":
                return .climate
            case "battery":
                return .energy
            default:
                return entity.displayUnit == "%" ? .washingMachine : .custom
            }
        case .light, .switch, .inputBoolean, .cover, .mediaPlayer, .other:
            return .custom
        }
    }

    static func humanReadableState(for entity: HAEntity, template: HALiveActivityTemplateKind? = nil) -> String {
        let state = entity.state.trimmed
        let lower = state.lowercased()
        let deviceClass = entity.attributes.normalizedDeviceClass

        if lower == "unknown" || lower == "unavailable" {
            return L10n.string(lower.capitalized)
        }

        switch entity.domain {
        case .binarySensor:
            if doorDeviceClasses.contains(deviceClass) {
                if openStates.contains(lower) { return L10n.string("Open") }
                if closedStates.contains(lower) { return L10n.string("Closed") }
            }
            if detectionDeviceClasses.contains(deviceClass) {
                if lower == "on" { return L10n.string("Detected") }
                if lower == "off" { return L10n.string("Clear") }
            }
            return onOffState(lower) ?? titleCase(state)

        case .switch, .light, .inputBoolean:
            return onOffState(lower) ?? titleCase(state)

        case .lock:
            if lower == "locked" { return L10n.string("Locked") }
            if lower == "unlocked" { return L10n.string("Unlocked") }
            return titleCase(state)

        case .cover:
            if ["open", "closed", "opening", "closing"].contains(lower) {
                return titleCase(state)
            }
            if let position = entity.attributes.currentPosition {
                return "\(Int(position))%"
            }
            return titleCase(state)

        case .vacuum:
            return titleCase(state)

        case .climate:
            if let currentTemperature = entity.attributes.currentTemperature {
                return temperatureText(currentTemperature, unit: entity.displayUnit)
            }
            return titleCase(state)

        case .sensor:
            return stateWithUnit(entity)

        case .timer:
            if lower == "active" { return L10n.string("Active") }
            if lower == "paused" { return L10n.string("Paused") }
            if lower == "idle" { return L10n.string("Idle") }
            return titleCase(state)

        case .mediaPlayer, .other:
            return titleCase(state)
        }
    }

    static func progressValue(
        for entity: HAEntity?,
        style: HALiveActivityDisplayStyle,
        allowUnitlessState: Bool
    ) -> Double? {
        guard let entity else { return nil }

        if let value = entity.attributes.progress {
            return normalizedProgress(value)
        }
        if let value = entity.attributes.percentage {
            return normalizedProgress(value)
        }
        if let value = entity.attributes.brightness, entity.domain == .light {
            return min(max(value / 255, 0), 1)
        }
        if entity.displayUnit == "%" || allowUnitlessState {
            if let number = Double(entity.state.trimmed) {
                if number <= 1, entity.displayUnit != "%" { return min(max(number, 0), 1) }
                if number <= 100 { return min(max(number / 100, 0), 1) }
            }
        }
        if style == .security || style == .doorWindow {
            return nil
        }

        switch entity.state.lowercased() {
        case "finished", "complete", "done":
            return 1
        case "idle", "off", "paused":
            return 0
        default:
            return nil
        }
    }

    private static func secondaryState(
        for entity: HAEntity,
        secondaryEntity: HAEntity?,
        progressEntity: HAEntity?,
        template: HALiveActivityTemplateKind
    ) -> String? {
        if let secondaryEntity {
            return humanReadableState(for: secondaryEntity)
        }
        if let progressEntity {
            return stateWithUnit(progressEntity)
        }

        switch entity.domain {
        case .light:
            if let brightness = entity.attributes.brightness {
                return L10n.format("%d%% brightness", Int((brightness / 255) * 100))
            }
        case .climate:
            let mode = entity.attributes.hvacMode ?? entity.state
            if let target = entity.attributes.temperature {
                return "\(titleCase(mode)) -> \(temperatureText(target, unit: entity.displayUnit))"
            }
            return titleCase(mode)
        case .vacuum:
            let room = entity.attributes.room
            let battery = entity.attributes.batteryLevel
            if let room, let battery {
                return L10n.format("%@ - %d%% battery", room, Int(battery))
            }
            if let battery {
                return L10n.format("%d%% battery", Int(battery))
            }
            if let status = entity.attributes.status {
                return status
            }
        case .timer:
            if let remaining = entity.attributes.remaining ?? entity.attributes.remainingTime {
                return remaining
            }
        case .cover:
            if let position = entity.attributes.currentPosition {
                return L10n.format("%d%% open", Int(position))
            }
        case .sensor:
            if entity.attributes.normalizedDeviceClass == "battery" {
                return stateWithUnit(entity)
            }
        case .binarySensor, .switch, .lock, .inputBoolean, .mediaPlayer, .other:
            break
        }

        if template == .washingMachine || template == .dishwasher {
            if let remaining = entity.attributes.remaining ?? entity.attributes.remainingTime {
                return L10n.format("%@ remaining", remaining)
            }
        }
        return nil
    }

    private static func subtitleText(
        for entity: HAEntity,
        displayName: String,
        primaryState: String,
        secondaryState: String?,
        progressEntity: HAEntity?,
        template: HALiveActivityTemplateKind
    ) -> String {
        switch entity.domain {
        case .binarySensor, .lock, .cover:
            return L10n.format("%@ is %@", displayName, primaryState.lowercased())
        case .light, .switch, .inputBoolean:
            return L10n.format("%@ is %@", displayName, primaryState.lowercased())
        case .climate:
            return secondaryState ?? "\(displayName): \(primaryState)"
        case .vacuum:
            return secondaryState ?? "\(displayName): \(primaryState)"
        case .sensor:
            if progressEntity != nil || template == .progress || template == .washingMachine || template == .dishwasher {
                return secondaryState ?? "\(displayName): \(primaryState)"
            }
            return "\(displayName): \(primaryState)"
        case .timer:
            return secondaryState ?? "\(displayName): \(primaryState)"
        case .mediaPlayer, .other:
            return "\(displayName): \(primaryState)"
        }
    }

    private static func iconName(for entity: HAEntity, template: HALiveActivityTemplateKind) -> String? {
        switch template {
        case .progress:
            return "progress.indicator"
        case .washingMachine:
            return "washer.fill"
        case .dishwasher:
            return "dishwasher.fill"
        case .vacuum:
            return "sparkles"
        case .security:
            if entity.domain == .lock {
                return entity.state.lowercased() == "unlocked" ? "lock.open.fill" : "lock.fill"
            }
            return entity.state.lowercased() == "on" ? "door.left.hand.open" : "door.left.hand.closed"
        case .climate:
            return "thermometer.medium"
        case .energy:
            return "bolt.fill"
        case .timer:
            return "timer"
        case .custom:
            return entity.suggestedIconName
        }
    }

    private static func stateWithUnit(_ entity: HAEntity) -> String {
        let value = entity.state.trimmed
        guard let unit = entity.displayUnit, !unit.isEmpty, !value.contains(unit) else {
            return value
        }
        return "\(value) \(unit)"
    }

    private static func temperatureText(_ value: Double, unit: String?) -> String {
        let formatted = value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
        return unit.map { "\(formatted)\($0)" } ?? formatted
    }

    private static func normalizedProgress(_ value: Double?) -> Double? {
        guard let value else { return nil }
        let normalized = value > 1 ? value / 100 : value
        return min(max(normalized, 0), 1)
    }

    private static func onOffState(_ value: String) -> String? {
        switch value {
        case "on": L10n.string("On")
        case "off": L10n.string("Off")
        default: nil
        }
    }

    private static func titleCase(_ value: String) -> String {
        L10n.string(value.replacingOccurrences(of: "_", with: " ").capitalized)
    }

    private static func clean(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static let doorDeviceClasses = Set(["door", "garage_door", "gate", "opening", "window"])
    private static let detectionDeviceClasses = Set(["motion", "occupancy", "presence", "moisture", "smoke", "gas", "problem", "safety"])
    private static let openStates = Set(["on", "open", "opening"])
    private static let closedStates = Set(["off", "closed", "closing"])
}

private extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private extension HAEntityAttributes {
    var normalizedDeviceClass: String {
        deviceClass?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }
}
