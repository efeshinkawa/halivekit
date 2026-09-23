import SwiftUI
import UIKit

struct ActivityBuilderView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let primaryEntity: HAEntity

    @State private var title: String
    @State private var subtitle: String
    @State private var displayName: String
    @State private var secondaryEntity: HAEntity?
    @State private var displayStyle: HALiveActivityDisplayStyle
    @State private var template: HALiveActivityTemplateKind
    @State private var iconName: String
    @State private var theme: HALiveActivityTheme
    @State private var isStarting = false
    @State private var errorMessage: String?
    @State private var isSecondaryPickerPresented = false
    @State private var previewMode: BuilderPreviewMode = .lockScreen
    @State private var isYAMLPresented = false
    @State private var showsAllPresets = false
    @State private var allowsEntityControl = false

    init(primaryEntity: HAEntity, template: LiveActivityTemplate? = nil) {
        self.primaryEntity = primaryEntity
        let selectedTemplate = template?.id ?? EntityLiveActivityBuilder.inferredTemplate(for: primaryEntity)
        let build = EntityLiveActivityBuilder.build(
            EntityLiveActivityBuildInput(
                activityId: nil,
                primaryEntity: primaryEntity,
                secondaryEntity: nil,
                progressEntity: nil,
                template: selectedTemplate,
                displayStyle: template?.style,
                displayName: nil,
                title: nil,
                subtitle: nil,
                iconName: template?.id == .custom ? nil : template?.iconName,
                theme: template?.theme,
                progress: nil,
                source: .app
            )
        )

        _title = State(initialValue: build.draft.title)
        _subtitle = State(initialValue: build.draft.subtitle)
        _displayName = State(initialValue: build.draft.displayName)
        _displayStyle = State(initialValue: build.draft.displayStyle)
        _template = State(initialValue: build.draft.template)
        _iconName = State(initialValue: build.draft.iconName)
        _theme = State(initialValue: build.draft.theme)
    }

    var body: some View {
        ZStack {
            PremiumBackground()
            ScrollView {
                AdaptiveScreenContent {
                    VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.large) {
                        previewCard
                        presetCard
                        formCard
                        entityControlCard
                        automationCard
                        startButton
                    }
                    .padding(.top, HALiveKitDesign.Spacing.standard)
                }
            }
        }
        .navigationTitle("Live Activity")
        .navigationBarTitleDisplayMode(.inline)
        .tint(theme.accentColor)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    isYAMLPresented = true
                } label: {
                    Image(systemName: "doc.text")
                        .frame(width: HALiveKitDesign.Layout.minimumTapTarget, height: HALiveKitDesign.Layout.minimumTapTarget)
                }
                .accessibilityLabel("Show Home Assistant YAML")
            }
        }
        .sheet(isPresented: $isYAMLPresented) {
            AutomationYAMLSheet(yaml: automationYAML)
        }
    }

    private var previewCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(title: "Live Preview", subtitle: primaryEntity.entityId)

            Picker("Preview Style", selection: $previewMode) {
                ForEach(BuilderPreviewMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.iconName).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)

            Group {
                switch previewMode {
                case .lockScreen:
                    LockScreenBuilderPreview(
                        build: previewBuild,
                        iconName: iconName,
                        title: resolvedTitle,
                        subtitle: subtitle,
                        theme: theme,
                        showsEntityControls: isEntityControlEnabled
                    )
                case .dynamicIsland:
                    DynamicIslandBuilderPreview(
                        build: previewBuild,
                        iconName: iconName,
                        title: resolvedTitle,
                        theme: theme,
                        showsEntityControls: isEntityControlEnabled
                    )
                }
            }
            .animation(reduceMotion ? nil : HALiveKitDesign.Motion.quick, value: previewMode)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var presetCard: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.medium) {
            HStack(alignment: .top, spacing: HALiveKitDesign.Spacing.small) {
                SectionHeader(
                    title: "Quick Presets",
                    subtitle: "Start from a purpose-built layout, then fine-tune any field."
                )

                Button {
                    withAnimation(reduceMotion ? nil : HALiveKitDesign.Motion.standard) {
                        showsAllPresets.toggle()
                    }
                } label: {
                    Label(
                        L10n.string(showsAllPresets ? "Show Less" : "Show More"),
                        systemImage: showsAllPresets ? "chevron.up" : "chevron.down"
                    )
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
                .accessibilityValue(
                    Text(L10n.string(showsAllPresets ? "Expanded" : "Collapsed"))
                )
            }

            if showsAllPresets {
                LazyVGrid(
                    columns: [
                        GridItem(
                            .adaptive(minimum: 148),
                            spacing: HALiveKitDesign.Spacing.small,
                            alignment: .top
                        )
                    ],
                    spacing: HALiveKitDesign.Spacing.small
                ) {
                    ForEach(LiveActivityTemplate.defaults) { preset in
                        ActivityPresetButton(
                            preset: preset,
                            isSelected: template == preset.id,
                            showsSubtitle: true
                        ) {
                            selectPreset(preset.id)
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            } else {
                HStack(alignment: .top, spacing: HALiveKitDesign.Spacing.small) {
                    ForEach(LiveActivityTemplate.defaults.prefix(2)) { preset in
                        ActivityPresetButton(
                            preset: preset,
                            isSelected: template == preset.id,
                            showsSubtitle: false
                        ) {
                            selectPreset(preset.id)
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var formCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(title: "Builder", subtitle: "Choose the content and visual style for ActivityKit.")

            FormFieldLabel(title: "Title")
            TextField("Title", text: $title)
                .textInputAutocapitalization(.words)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            FormFieldLabel(title: "Subtitle")
            TextField("Subtitle", text: $subtitle)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            FormFieldLabel(title: "Display name")
            TextField("Display name", text: $displayName)
                .textInputAutocapitalization(.words)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            LabeledContent("Primary") {
                Text(primaryEntity.friendlyName)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Picker("Template", selection: $template) {
                ForEach(HALiveActivityTemplateKind.allCases) { template in
                    Text(template.title).tag(template)
                }
            }
            .pickerStyle(.menu)
            .onChange(of: template) { _, newTemplate in
                applyTemplate(newTemplate)
            }

            LabeledContent("Secondary") {
                Button {
                    isSecondaryPickerPresented = true
                } label: {
                    HStack(spacing: 8) {
                        Text(secondaryEntity?.friendlyName ?? L10n.string("None"))
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }

            Picker("Display Style", selection: $displayStyle) {
                ForEach(HALiveActivityDisplayStyle.allCases) { style in
                    Text(style.title).tag(style)
                }
            }
            .pickerStyle(.menu)

            Picker("Theme", selection: $theme) {
                ForEach(HALiveActivityTheme.allCases) { theme in
                    Text(theme.title).tag(theme)
                }
            }
            .pickerStyle(.segmented)

            FormFieldLabel(title: "SF Symbol")
            TextField("SF Symbol", text: $iconName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
        .sheet(isPresented: $isSecondaryPickerPresented) {
            NavigationStack {
                ActivityBuilderEntityPickerSheet(
                    primaryEntityId: primaryEntity.entityId,
                    selectedEntity: $secondaryEntity,
                    theme: theme
                )
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private var entityControlCard: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.medium) {
            SectionHeader(
                title: "Action Buttons",
                subtitle: "Optionally control this entity from the Lock Screen or Dynamic Island without opening HA LiveKit."
            )

            if supportsEntityControl {
                Toggle(isOn: $allowsEntityControl) {
                    VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.xSmall) {
                        Text("Add On / Off buttons")
                            .font(.headline)
                        Text(primaryEntity.friendlyName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .tint(theme.accentColor)
                .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                .disabled(!canEnableEntityControl)
                .accessibilityHint("Adds authenticated controls that run without opening the app.")

                if !canEnableEntityControl {
                    Label(entityControlUnavailableMessage, systemImage: "lock.trianglebadge.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if isEntityControlEnabled {
                    EntityControlPreviewRow(
                        currentState: primaryEntity.state,
                        theme: theme
                    )

                    Label(
                        "For security, iPhone may require authentication before a command runs.",
                        systemImage: "faceid"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Label("This entity is view-only", systemImage: "eye")
                    .font(.subheadline.weight(.semibold))

                Text("Choose a light, switch, or input boolean as the primary entity to add On / Off buttons.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
        .onChange(of: canEnableEntityControl) { _, canEnable in
            if !canEnable {
                allowsEntityControl = false
            }
        }
    }

    private var automationCard: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.medium) {
            SectionHeader(
                title: "Home Assistant YAML",
                subtitle: "Copy a safe Set Live Activity action matching this preview."
            )

            Button {
                isYAMLPresented = true
            } label: {
                Label("Review & Copy YAML", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)

            if isEntityControlEnabled {
                Label(
                    "Action Buttons are stored on this iPhone and are not added to the Home Assistant YAML.",
                    systemImage: "iphone"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var startButton: some View {
        Button {
            Task { await start() }
        } label: {
            Label(isStarting ? "Starting..." : "Start Live Activity", systemImage: "livephoto")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        .disabled(isStarting || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var resolvedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? primaryEntity.friendlyName : title
    }

    private var supportsEntityControl: Bool {
        switch primaryEntity.domain {
        case .light, .switch, .inputBoolean:
            true
        default:
            false
        }
    }

    private var canEnableEntityControl: Bool {
        supportsEntityControl
            && !appModel.isDemoMode
            && appModel.hasStoredHomeAssistantCredential
            && appModel.homeAssistantInstanceID.map(HomeAssistantInstanceIdentity.isSafeIdentifier) == true
    }

    private var isEntityControlEnabled: Bool {
        allowsEntityControl && canEnableEntityControl
    }

    private var entityControlUnavailableMessage: String {
        if appModel.isDemoMode {
            return L10n.string("Connect to Home Assistant to enable real device controls.")
        }
        return L10n.string("Save a Home Assistant connection before enabling device controls.")
    }

    private var automationYAML: String {
        let build = previewBuild
        let templateValue = template == .washingMachine ? "washing_machine" : template.rawValue
        return """
        action: ha_livekit.set_activity
        data:
          activity_id: \(yamlQuoted(build.activityId))
          entity_id: \(yamlQuoted(primaryEntity.entityId))
          template: \(yamlQuoted(templateValue))
          title: \(yamlQuoted(resolvedTitle))
          display_name: \(yamlQuoted(displayName.isEmpty ? primaryEntity.friendlyName : displayName))
          subtitle: \(yamlQuoted(subtitle))
          icon_name: \(yamlQuoted(iconName))
          data:
            display_style: \(yamlQuoted(displayStyle.rawValue))
            theme: \(yamlQuoted(theme.rawValue))
          device_id: \(yamlQuoted(appModel.clientDeviceID))
        """
    }

    private func yamlQuoted(_ value: String) -> String {
        let singleLine = value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        return "'\(singleLine.replacingOccurrences(of: "'", with: "''"))'"
    }

    private var previewBuild: EntityLiveActivityBuild {
        EntityLiveActivityBuilder.build(
            EntityLiveActivityBuildInput(
                activityId: EntityLiveActivityBuilder.activityID(for: primaryEntity.entityId),
                primaryEntity: primaryEntity,
                secondaryEntity: secondaryEntity,
                progressEntity: nil,
                template: template,
                displayStyle: displayStyle,
                displayName: displayName,
                title: title,
                subtitle: subtitle,
                iconName: iconName,
                theme: theme,
                progress: nil,
                source: .app
            )
        )
    }

    private func start() async {
        isStarting = true
        errorMessage = nil
        defer { isStarting = false }

        do {
            let build = EntityLiveActivityBuilder.build(
                EntityLiveActivityBuildInput(
                    activityId: EntityLiveActivityBuilder.activityID(for: primaryEntity.entityId),
                    primaryEntity: primaryEntity,
                    secondaryEntity: secondaryEntity,
                    progressEntity: nil,
                    template: template,
                    displayStyle: displayStyle,
                    displayName: displayName,
                    title: title,
                    subtitle: subtitle,
                    iconName: iconName,
                    theme: theme,
                    progress: nil,
                    source: .app
                )
            )
            try await appModel.startLiveActivity(
                build: build,
                allowsEntityControl: isEntityControlEnabled
            )
            dismiss()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func applyTemplate(_ kind: HALiveActivityTemplateKind) {
        guard let template = LiveActivityTemplate.defaults.first(where: { $0.id == kind }) else {
            displayStyle = kind.displayStyle
            return
        }

        let build = EntityLiveActivityBuilder.build(
            EntityLiveActivityBuildInput(
                activityId: nil,
                primaryEntity: primaryEntity,
                secondaryEntity: secondaryEntity,
                progressEntity: nil,
                template: kind,
                displayStyle: template.style,
                displayName: displayName,
                title: nil,
                subtitle: nil,
                iconName: kind == .custom ? nil : template.iconName,
                theme: template.theme,
                progress: nil,
                source: .app
            )
        )
        title = build.draft.title
        subtitle = build.draft.subtitle
        displayStyle = template.style
        iconName = build.draft.iconName
        theme = template.theme
    }

    private func selectPreset(_ kind: HALiveActivityTemplateKind) {
        if template == kind {
            applyTemplate(kind)
        } else {
            template = kind
        }
    }
}

private struct ActivityPresetButton: View {
    let preset: LiveActivityTemplate
    let isSelected: Bool
    let showsSubtitle: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.small) {
                HStack {
                    Image(systemName: preset.iconName)
                        .font(.headline)
                    Spacer(minLength: HALiveKitDesign.Spacing.small)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                    }
                }
                Text(preset.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text(preset.style.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if showsSubtitle {
                    Text(preset.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .foregroundStyle(foregroundColor)
            .frame(
                maxWidth: .infinity,
                minHeight: showsSubtitle ? 142 : 104,
                alignment: .topLeading
            )
            .padding(HALiveKitDesign.Spacing.medium)
            .background(
                backgroundColor,
                in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
                    .stroke(borderColor, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var foregroundColor: Color {
        isSelected ? preset.theme.accentColor : .primary
    }

    private var backgroundColor: Color {
        isSelected ? preset.theme.accentColor.opacity(0.12) : .clear
    }

    private var borderColor: Color {
        isSelected ? preset.theme.accentColor.opacity(0.55) : .secondary.opacity(0.18)
    }
}

private enum BuilderPreviewMode: String, CaseIterable, Identifiable {
    case lockScreen
    case dynamicIsland

    var id: String { rawValue }

    var title: String {
        switch self {
        case .lockScreen: L10n.string("Lock Screen")
        case .dynamicIsland: L10n.string("Dynamic Island")
        }
    }

    var iconName: String {
        switch self {
        case .lockScreen: "iphone"
        case .dynamicIsland: "capsule.fill"
        }
    }
}

private struct LockScreenBuilderPreview: View {
    let build: EntityLiveActivityBuild
    let iconName: String
    let title: String
    let subtitle: String
    let theme: HALiveActivityTheme
    let showsEntityControls: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.medium) {
            HStack(alignment: .top, spacing: HALiveKitDesign.Spacing.medium) {
                Image(systemName: iconName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(theme.gradient, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.xSmall) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(2)
                    Text(build.contentState.displayName ?? build.contentState.entityId)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.68))
                        .lineLimit(1)
                }

                Spacer(minLength: HALiveKitDesign.Spacing.small)

                Text(build.contentState.primaryState)
                    .font(.title3.weight(.bold))
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
            }

            if !showsEntityControls {
                if let progress = build.contentState.progress {
                    ProgressView(value: progress)
                        .tint(theme.accentColor)
                } else if let secondaryState = build.contentState.secondaryState,
                          !secondaryState.isEmpty {
                    Text(secondaryState)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white.opacity(0.78))
                } else if !subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.78))
                }
            }

            if showsEntityControls {
                EntityControlPreviewRow(
                    currentState: build.contentState.value,
                    theme: theme
                )
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .foregroundStyle(.white)
        .background(Color.black.opacity(0.88), in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.feature, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.feature, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L10n.format("Lock Screen preview for %@", title))
    }
}

private struct DynamicIslandBuilderPreview: View {
    let build: EntityLiveActivityBuild
    let iconName: String
    let title: String
    let theme: HALiveActivityTheme
    let showsEntityControls: Bool

    var body: some View {
        VStack(spacing: HALiveKitDesign.Spacing.small) {
            HStack(spacing: HALiveKitDesign.Spacing.medium) {
                Image(systemName: iconName)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(theme.accentColor)
                    .frame(width: 36, height: 36)
                    .background(theme.accentColor.opacity(0.16), in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(build.contentState.secondaryState ?? build.contentState.displayStyle.title)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.66))
                        .lineLimit(1)
                }

                Spacer(minLength: HALiveKitDesign.Spacing.small)

                Text(build.contentState.primaryState)
                    .font(.headline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }

            if showsEntityControls {
                EntityControlPreviewRow(
                    currentState: build.contentState.value,
                    theme: theme
                )
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .frame(minHeight: 72)
        .foregroundStyle(.white)
        .background(Color.black.opacity(0.94), in: RoundedRectangle(cornerRadius: 32, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 32, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L10n.format("Dynamic Island preview for %@", title))
    }
}

private struct EntityControlPreviewRow: View {
    let currentState: String?
    let theme: HALiveActivityTheme

    var body: some View {
        HStack(spacing: HALiveKitDesign.Spacing.small) {
            previewControl(
                title: "On",
                systemImage: "power",
                isActive: normalizedState == "on"
            )
            previewControl(
                title: "Off",
                systemImage: "power.circle",
                isActive: normalizedState == "off"
            )
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(L10n.string("Preview of On and Off Live Activity buttons")))
        .accessibilityValue(Text(accessibilityStateValue))
    }

    private var normalizedState: String {
        currentState?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private var accessibilityStateValue: String {
        switch normalizedState {
        case "on": L10n.string("Currently on")
        case "off": L10n.string("Currently off")
        default: L10n.string("Current state unavailable")
        }
    }

    private func previewControl(
        title: String,
        systemImage: String,
        isActive: Bool
    ) -> some View {
        HStack(spacing: HALiveKitDesign.Spacing.xSmall) {
            Label {
                Text(L10n.string(title))
            } icon: {
                Image(systemName: systemImage)
            }
            if isActive {
                Image(systemName: "checkmark")
                    .font(.caption2.weight(.bold))
            }
        }
            .font(.caption.weight(.semibold))
            .foregroundStyle(isActive ? Color.white : theme.accentColor)
            .frame(maxWidth: .infinity, minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            .background(
                isActive ? theme.accentColor : theme.accentColor.opacity(0.16),
                in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
                    .stroke(theme.accentColor.opacity(isActive ? 0.75 : 0.35), lineWidth: 1)
            }
    }
}

private struct AutomationYAMLSheet: View {
    let yaml: String

    @Environment(\.dismiss) private var dismiss
    @State private var didCopy = false

    var body: some View {
        NavigationStack {
            ZStack {
                PremiumBackground()
                ScrollView {
                    AdaptiveScreenContent {
                        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.standard) {
                            NoticeBanner(
                                title: "Review before saving",
                                message: "This action targets the current device. Home Assistant permissions still apply.",
                                tone: .info
                            )

                            Text(yaml)
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(HALiveKitDesign.Spacing.standard)
                                .background(
                                    .regularMaterial,
                                    in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
                                )

                            Button {
                                UIPasteboard.general.string = yaml
                                didCopy = true
                            } label: {
                                Label(didCopy ? "Copied" : "Copy YAML", systemImage: didCopy ? "checkmark.circle.fill" : "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)

                            ShareLink(item: yaml) {
                                Label("Share YAML", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                        }
                        .padding(.top, HALiveKitDesign.Spacing.standard)
                    }
                }
            }
            .navigationTitle("Home Assistant YAML")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct ActivityBuilderEntityPickerSheet: View {
    @Environment(AppModel.self) private var appModel

    let primaryEntityId: String
    @Binding var selectedEntity: HAEntity?
    let theme: HALiveActivityTheme

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    var body: some View {
        ZStack {
            PremiumBackground()
            ScrollView {
                LazyVStack(spacing: 10) {
                    noneButton

                    if availableEntities.isEmpty {
                        emptyEntityState
                    } else if filteredEntities.isEmpty {
                        EmptyStateView(
                            iconName: "magnifyingglass",
                            title: "No matching entities",
                            message: "Adjust the search, or choose None to use only the primary entity."
                        )
                    } else {
                        ForEach(filteredEntities) { entity in
                            Button {
                                selectedEntity = entity
                                dismiss()
                            } label: {
                                EntitySelectionRow(
                                    entity: entity,
                                    isSelected: selectedEntity?.entityId == entity.entityId,
                                    theme: theme
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(16)
            }
        }
        .navigationTitle("Secondary Entity")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search entity")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") {
                    dismiss()
                }
            }
        }
        .task {
            guard appModel.entities.isEmpty,
                  appModel.entityFetchStatus != .connecting
            else {
                return
            }
            await appModel.refreshEntities()
        }
    }

    private var noneButton: some View {
        Button {
            selectedEntity = nil
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "minus.circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 42, height: 42)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text("None")
                        .font(.headline)
                    Text("Use only the primary entity")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if selectedEntity == nil {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(theme.accentColor)
                }
            }
            .padding(14)
            .glassPanel()
        }
        .buttonStyle(.plain)
    }

    private var filteredEntities: [HAEntity] {
        let entities = availableEntities
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return entities }

        return entities.filter { entity in
            entity.entityId.localizedCaseInsensitiveContains(query) ||
            entity.friendlyName.localizedCaseInsensitiveContains(query) ||
            entity.state.localizedCaseInsensitiveContains(query)
        }
    }

    private var availableEntities: [HAEntity] {
        appModel.entities
            .filter { $0.entityId != primaryEntityId }
            .sorted { $0.entityId.localizedStandardCompare($1.entityId) == .orderedAscending }
    }

    @ViewBuilder
    private var emptyEntityState: some View {
        switch appModel.entityFetchStatus {
        case .idle, .connecting:
            ProgressView("Loading entities...")
                .frame(maxWidth: .infinity)
                .padding(22)
                .glassPanel()
        case .failed:
            EmptyStateView(
                iconName: "exclamationmark.triangle.fill",
                title: "Could not load entities",
                message: "Refresh from Home Assistant and try again."
            )
            Button {
                Task { await appModel.refreshEntities() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accentColor)
        default:
            EmptyStateView(
                iconName: "square.stack.3d.up.slash",
                title: "No secondary entities",
                message: "Choose None, or refresh entities from Home Assistant."
            )
        }
    }
}

private struct EntitySelectionRow: View {
    let entity: HAEntity
    let isSelected: Bool
    let theme: HALiveActivityTheme

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: entity.suggestedIconName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(theme.gradient)
                .frame(width: 42, height: 42)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(entity.friendlyName)
                    .font(.headline)
                    .lineLimit(1)
                Text(entity.entityId)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(entity.state)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let unit = entity.displayUnit {
                    Text(unit)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(theme.accentColor)
            }
        }
        .padding(14)
        .glassPanel()
    }
}

#Preview {
    NavigationStack {
        ActivityBuilderView(primaryEntity: MockData.washingMachine)
            .environment(AppModel())
    }
}
