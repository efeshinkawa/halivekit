import ActivityKit
import AppIntents
import Foundation
import SwiftUI
import WidgetKit

struct HALiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HALiveActivityAttributes.self) { context in
            LockScreenActivityView(
                attributes: context.attributes,
                state: context.state
            )
                .activityBackgroundTint(Color.black.opacity(0.22))
                .activitySystemActionForegroundColor(context.state.theme.accentColor)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    IslandIconView(state: context.state)
                        .padding(.leading, 8)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    IslandMetricView(state: context.state)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    ExpandedIslandBottomView(
                        attributes: context.attributes,
                        state: context.state
                    )
                }
            } compactLeading: {
                Image(systemName: context.state.iconName)
                    .foregroundStyle(context.state.theme.accentColor)
            } compactTrailing: {
                Text(compactValue(context.state))
                    .font(.caption2.weight(.bold))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 42, alignment: .trailing)
                    .foregroundStyle(context.state.theme.accentColor)
            } minimal: {
                Image(systemName: context.state.iconName)
                    .foregroundStyle(context.state.theme.accentColor)
            }
            .keylineTint(context.state.theme.accentColor)
        }
    }

    private func compactValue(_ state: HALiveActivityAttributes.ContentState) -> String {
        if let progress = state.progress {
            return "\(Int(progress * 100))%"
        }

        if let value = state.value, let unit = state.unit, value.count <= 4 {
            return "\(value)\(unit)"
        }

        let text = state.primaryState.trimmingCharacters(in: .whitespacesAndNewlines)
        switch text.lowercased() {
        case "running": return "Run"
        case "washing machine": return "Wash"
        case "23 min remaining": return "23m"
        default:
            if let minutes = text.split(separator: " ").first,
               Int(minutes) != nil,
               text.lowercased().contains("min") {
                return "\(minutes)m"
            }
            return text
        }
    }
}

private struct IslandMetricView: View {
    var state: HALiveActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(metricText)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .truncationMode(.tail)
                .multilineTextAlignment(.trailing)
                .layoutPriority(1)
            Text(state.lastUpdated, style: .time)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(width: 78, alignment: .trailing)
        .padding(.trailing, 8)
    }

    private var metricText: String {
        if let progress = state.progress {
            return "\(Int(progress * 100))%"
        }
        return state.primaryState
    }
}

private struct LockScreenActivityView: View {
    var attributes: HALiveActivityAttributes
    var state: HALiveActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: hasValidEntityControlBinding ? 8 : 14) {
            HStack(alignment: .top, spacing: 12) {
                IslandIconView(state: state)

                if hasValidEntityControlBinding {
                    ControlledActivityTextStack(state: state)
                } else {
                    ActivityTextStack(state: state)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 4) {
                    Text(state.primaryState)
                        .font(.title3.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .truncationMode(.tail)
                    Text(state.lastUpdated, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 112, alignment: .trailing)
            }

            if !hasValidEntityControlBinding {
                if let progress = state.progress {
                    ProgressView(value: progress)
                        .tint(state.theme.accentColor)
                } else if let secondary = state.secondaryState {
                    Label(secondary, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            if hasValidEntityControlBinding {
                LiveActivityEntityControlButtons(
                    attributes: attributes,
                    state: state
                )
            }
        }
        .padding(hasValidEntityControlBinding ? 12 : 16)
    }

    private var hasValidEntityControlBinding: Bool {
        attributes.isEntityControlEnabled
            && state.entityId == attributes.primaryEntityId
    }
}

private struct IslandIconView: View {
    var state: HALiveActivityAttributes.ContentState

    var body: some View {
        Image(systemName: state.iconName)
            .font(.title3.weight(.bold))
            .foregroundStyle(state.theme.gradient)
            .frame(width: 38, height: 38)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct ExpandedIslandBottomView: View {
    var attributes: HALiveActivityAttributes
    var state: HALiveActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .truncationMode(.tail)
                    if let subtitleText {
                        Text(subtitleText)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .truncationMode(.tail)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                .clipped()

                if let secondary = state.secondaryState {
                    Text(secondary)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .truncationMode(.tail)
                        .foregroundStyle(.secondary)
                        .frame(width: 78, alignment: .trailing)
                }
            }

            if !hasValidEntityControlBinding, let progress = state.progress {
                ProgressView(value: progress)
                    .tint(state.theme.accentColor)
            }

            if hasValidEntityControlBinding {
                LiveActivityEntityControlButtons(
                    attributes: attributes,
                    state: state
                )
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 4)
    }

    private var hasValidEntityControlBinding: Bool {
        attributes.isEntityControlEnabled
            && state.entityId == attributes.primaryEntityId
    }

    private var subtitleText: String? {
        let title = normalized(state.title) ?? state.title
        let displayName = normalized(state.displayName)
        let subtitle = conciseSubtitle
        var parts: [String] = []

        if let displayName,
           displayName.caseInsensitiveCompare(title) != .orderedSame,
           subtitle?.caseInsensitiveCompare(displayName) != .orderedSame {
            parts.append(displayName)
        }

        if let subtitle {
            parts.append(subtitle)
        }

        return parts.isEmpty ? nil : parts.joined(separator: " - ")
    }

    private var conciseSubtitle: String? {
        guard var text = normalized(state.subtitle) else { return nil }

        for duplicate in [state.displayName, state.title]
            .compactMap({ normalized($0) })
            .sorted(by: { $0.count > $1.count }) {
            text = removingLeadingDuplicate(duplicate, from: text)
        }

        if text.caseInsensitiveCompare(state.title) == .orderedSame {
            return nil
        }
        if let displayName = normalized(state.displayName),
           text.caseInsensitiveCompare(displayName) == .orderedSame {
            return nil
        }
        return text.isEmpty ? nil : text
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func removingLeadingDuplicate(_ duplicate: String, from text: String) -> String {
        let candidates = [
            "\(duplicate) - ",
            "\(duplicate): ",
            "\(duplicate) is ",
            "\(duplicate) "
        ]
        let lowercasedText = text.lowercased()

        for candidate in candidates {
            guard lowercasedText.hasPrefix(candidate.lowercased()) else { continue }
            let remaining = String(text.dropFirst(candidate.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            return remaining.prefix(1).uppercased() + String(remaining.dropFirst())
        }

        return text
    }
}

private struct LiveActivityEntityControlButtons: View {
    let attributes: HALiveActivityAttributes
    let state: HALiveActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 8) {
            controlButton(
                action: .turnOn,
                title: "On",
                systemImage: "power",
                isActive: normalizedState == "on"
            )
            controlButton(
                action: .turnOff,
                title: "Off",
                systemImage: "power.circle",
                isActive: normalizedState == "off"
            )
        }
    }

    private var normalizedState: String {
        let rawValue = state.value ?? state.primaryState
        return rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var entityName: String {
        let displayName = state.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return displayName.isEmpty ? attributes.primaryEntityId : displayName
    }

    private func controlButton(
        action: HALiveActivityEntityControlAction,
        title: String,
        systemImage: String,
        isActive: Bool
    ) -> some View {
        Button(
            intent: HALiveActivityEntityControlIntent(
                activityID: attributes.activityId,
                entityID: attributes.primaryEntityId,
                action: action
            )
        ) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text(L10n.string(title))
                if isActive {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                }
            }
            .font(.caption.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isActive ? Color.white : state.theme.accentColor)
        .background(
            isActive ? state.theme.accentColor : state.theme.accentColor.opacity(0.16),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(state.theme.accentColor.opacity(isActive ? 0.75 : 0.35), lineWidth: 1)
        }
        .accessibilityLabel(
            Text(L10n.format("Turn %@ %@", entityName, L10n.string(title).lowercased(with: Locale.current)))
        )
        .accessibilityHint(
            Text(L10n.string("Runs in Home Assistant without opening HA LiveKit. Authentication may be required."))
        )
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

private struct ActivityTextStack: View {
    var state: HALiveActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(state.title)
                .font(.headline)
                .lineLimit(1)
            if let displayName = state.displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty,
               displayName != state.title {
                Text(displayName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if !state.subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               state.subtitle != (state.displayName ?? "") {
                Text(state.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

private struct ControlledActivityTextStack: View {
    var state: HALiveActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(state.title)
                .font(.headline)
                .lineLimit(1)
            if let displayName = state.displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty,
               displayName != state.title {
                Text(displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

#Preview("Lock Screen", as: .content, using: HALiveActivityAttributes(
    activityId: "preview",
    primaryEntityId: "sensor.washing_machine_remaining_time",
    secondaryEntityId: nil,
    template: .washingMachine
)) {
    HALiveActivityWidget()
} contentStates: {
    HALiveActivityAttributes.ContentState(
        title: "Laundry",
        subtitle: "Washer is running",
        displayName: "Washing Machine",
        entityId: "sensor.washing_machine_remaining_time",
        primaryState: "28 min",
        secondaryState: "Running",
        progress: 0.62,
        value: "28",
        unit: "min",
        iconName: "washer.fill",
        theme: .homeAssistant,
        displayStyle: .progress,
        lastUpdated: .now
    )
}

#Preview("Dynamic Island Expanded Door", as: .dynamicIsland(.expanded), using: HALiveActivityAttributes(
    activityId: "door_preview",
    primaryEntityId: "binary_sensor.front_door",
    secondaryEntityId: nil,
    template: .security
)) {
    HALiveActivityWidget()
} contentStates: {
    HALiveActivityAttributes.ContentState(
        title: "Kapi Kapi",
        subtitle: "Kapi Kapi is closed",
        displayName: "Kapi Kapi",
        entityId: "binary_sensor.front_door",
        primaryState: "Closed",
        secondaryState: nil,
        progress: nil,
        value: nil,
        unit: nil,
        iconName: "door.left.hand.closed",
        theme: .rose,
        displayStyle: .doorWindow,
        lastUpdated: .now
    )
}

#Preview("Dynamic Island Expanded Controls", as: .dynamicIsland(.expanded), using: HALiveActivityAttributes(
    activityId: "light_preview",
    primaryEntityId: "light.masa_lambasi_masa_1",
    secondaryEntityId: nil,
    template: .custom,
    allowsEntityControl: true,
    entityControlHomeAssistantInstanceId: "preview-instance"
)) {
    HALiveActivityWidget()
} contentStates: {
    HALiveActivityAttributes.ContentState(
        title: "Masa Lambası Masa 1",
        subtitle: "Masa Lambası Masa 1 kapalı",
        displayName: "Masa Lambası Masa 1",
        entityId: "light.masa_lambasi_masa_1",
        primaryState: "Kapalı",
        secondaryState: nil,
        progress: 0,
        value: "off",
        unit: nil,
        iconName: "lightbulb",
        theme: .homeAssistant,
        displayStyle: .compactStatus,
        lastUpdated: .now
    )
}
