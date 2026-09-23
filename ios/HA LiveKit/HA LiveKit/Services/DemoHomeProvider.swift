import Foundation

enum HALiveKitDefaults {
    static let demoModeEnabledKey = "haLiveKitDemoModeEnabled"
    static let hasSeenIntegrationGuideKey = "hasSeenIntegrationGuide"
}

@MainActor
protocol HomeDataProvider {
    var homeName: String { get }
    func currentEntities() -> [HAEntity]
}

struct DemoRoom: Identifiable, Hashable {
    var name: String
    var iconName: String

    var id: String { name }
}

enum DemoScenario: String, CaseIterable, Codable, Identifiable {
    case doorOpened
    case laundryRunning
    case laundryProgressUpdate
    case vacuumCleaning
    case climateHeatingCooling
    case energySpike

    var id: String { rawValue }

    var title: String {
        switch self {
        case .doorOpened: L10n.string("Door opened")
        case .laundryRunning: L10n.string("Laundry running")
        case .laundryProgressUpdate: L10n.string("Laundry progress update")
        case .vacuumCleaning: L10n.string("Vacuum cleaning")
        case .climateHeatingCooling: L10n.string("Climate heating/cooling")
        case .energySpike: L10n.string("Energy spike")
        }
    }

    var subtitle: String {
        switch self {
        case .doorOpened: L10n.string("Entrance alert with lock status")
        case .laundryRunning: L10n.string("Starts a local laundry Live Activity")
        case .laundryProgressUpdate: L10n.string("Advances washing progress")
        case .vacuumCleaning: L10n.string("Shows room cleaning status")
        case .climateHeatingCooling: L10n.string("Updates bedroom comfort")
        case .energySpike: L10n.string("Highlights current energy usage")
        }
    }

    var iconName: String {
        switch self {
        case .doorOpened: "door.left.hand.open"
        case .laundryRunning, .laundryProgressUpdate: "washer.fill"
        case .vacuumCleaning: "sparkles"
        case .climateHeatingCooling: "thermometer.medium"
        case .energySpike: "bolt.fill"
        }
    }
}

struct DemoScenarioPayload: Hashable {
    var activityId: String
    var title: String
    var subtitle: String
    var displayName: String
    var primaryEntity: HAEntity
    var secondaryEntity: HAEntity?
    var displayStyle: HALiveActivityDisplayStyle
    var template: HALiveActivityTemplateKind
    var iconName: String
    var theme: HALiveActivityTheme
    var primaryState: String?
    var secondaryState: String?
    var progress: Double?
    var value: String?
    var unit: String?

    var draft: LiveActivityDraft {
        LiveActivityDraft(
            activityId: activityId,
            title: title,
            subtitle: subtitle,
            displayName: displayName,
            primaryEntity: primaryEntity,
            secondaryEntity: secondaryEntity,
            displayStyle: displayStyle,
            template: template,
            iconName: iconName,
            theme: theme
        )
    }
}

@MainActor
final class DemoHomeProvider: HomeDataProvider {
    let homeName = L10n.string("Demo Smart Home")

    let rooms: [DemoRoom] = [
        .init(name: L10n.string("Living Room"), iconName: "sofa.fill"),
        .init(name: L10n.string("Bedroom"), iconName: "bed.double.fill"),
        .init(name: L10n.string("Kitchen"), iconName: "fork.knife"),
        .init(name: L10n.string("Entrance"), iconName: "door.left.hand.closed"),
        .init(name: L10n.string("Laundry"), iconName: "washer.fill"),
        .init(name: L10n.string("Garage"), iconName: "car.fill")
    ]

    private var entities: [HAEntity]

    init() {
        self.entities = Self.makeInitialEntities()
    }

    func reset() -> [HAEntity] {
        entities = Self.makeInitialEntities()
        return entities
    }

    func currentEntities() -> [HAEntity] {
        entities.sorted { $0.entityId.localizedStandardCompare($1.entityId) == .orderedAscending }
    }

    func entity(withId entityId: String) -> HAEntity? {
        entities.first { $0.entityId == entityId }
    }

    func apply(_ scenario: DemoScenario) -> DemoScenarioPayload {
        switch scenario {
        case .doorOpened:
            updateEntity("binary_sensor.front_door", state: "on")
            updateEntity("lock.front_door", state: "unlocked")
            let door = entity(withId: "binary_sensor.front_door")!
            let lock = entity(withId: "lock.front_door")
            return DemoScenarioPayload(
                activityId: "front_door",
                title: L10n.string("Front Door"),
                subtitle: L10n.string("Opened just now"),
                displayName: L10n.string("Entrance"),
                primaryEntity: door,
                secondaryEntity: lock,
                displayStyle: .doorWindow,
                template: .security,
                iconName: "door.left.hand.open",
                theme: .rose,
                primaryState: L10n.string("Open"),
                secondaryState: L10n.string("Lock unlocked"),
                progress: nil,
                value: "on",
                unit: nil
            )

        case .laundryRunning:
            return updateLaundry(progress: 18, power: 620, remainingMinutes: 42, subtitle: L10n.string("Running - 42 min left"))

        case .laundryProgressUpdate:
            let current = Int(entity(withId: "sensor.washing_machine_progress")?.state ?? "18") ?? 18
            let next = min(current + 22, 100)
            let remaining = max(0, 52 - Int(Double(next) * 0.52))
            return updateLaundry(
                progress: next,
                power: next >= 100 ? 4 : 710,
                remainingMinutes: remaining,
                subtitle: next >= 100 ? L10n.string("Cycle complete") : L10n.format("%d min remaining", remaining)
            )

        case .vacuumCleaning:
            updateEntity("vacuum.roborock", state: "cleaning")
            let vacuum = entity(withId: "vacuum.roborock")!
            return DemoScenarioPayload(
                activityId: "roborock",
                title: L10n.string("Robot Vacuum"),
                subtitle: L10n.string("Cleaning the kitchen"),
                displayName: "Roborock",
                primaryEntity: vacuum,
                secondaryEntity: nil,
                displayStyle: .vacuum,
                template: .vacuum,
                iconName: "sparkles",
                theme: .mint,
                primaryState: L10n.string("Cleaning"),
                secondaryState: L10n.string("Kitchen - 68% battery"),
                progress: nil,
                value: "cleaning",
                unit: nil
            )

        case .climateHeatingCooling:
            let currentMode = entity(withId: "climate.bedroom")?.state.lowercased() ?? "heating"
            let nextState = currentMode == "heating" ? "cooling" : "heating"
            let currentTemp = nextState == "heating" ? 20.8 : 24.2
            let targetTemp = nextState == "heating" ? 22.0 : 23.0
            updateEntity(
                "climate.bedroom",
                state: nextState,
                attributes: .init(
                    friendlyName: "Bedroom Climate",
                    icon: nil,
                    unitOfMeasurement: nil,
                    deviceClass: nil,
                    batteryLevel: nil,
                    currentTemperature: currentTemp,
                    temperature: targetTemp,
                    hvacMode: nextState
                )
            )
            let climate = entity(withId: "climate.bedroom")!
            return DemoScenarioPayload(
                activityId: "bedroom_climate",
                title: L10n.string("Bedroom Climate"),
                subtitle: nextState == "heating" ? L10n.string("Heating to 22 C") : L10n.string("Cooling to 23 C"),
                displayName: L10n.string("Bedroom"),
                primaryEntity: climate,
                secondaryEntity: nil,
                displayStyle: .climate,
                template: .climate,
                iconName: "thermometer.medium",
                theme: .ocean,
                primaryState: L10n.string(nextState.capitalized),
                secondaryState: L10n.format("Now %.1f C", currentTemp),
                progress: nil,
                value: nextState,
                unit: nil
            )

        case .energySpike:
            updateEntity("sensor.home_energy_now", state: "4.8")
            updateEntity("sensor.home_energy_today", state: "9.2")
            let current = entity(withId: "sensor.home_energy_now")!
            let today = entity(withId: "sensor.home_energy_today")
            return DemoScenarioPayload(
                activityId: "home_energy",
                title: L10n.string("Home Energy"),
                subtitle: L10n.string("Usage spike detected"),
                displayName: L10n.string("Energy Monitor"),
                primaryEntity: current,
                secondaryEntity: today,
                displayStyle: .energy,
                template: .energy,
                iconName: "bolt.fill",
                theme: .amber,
                primaryState: "4.8 kW",
                secondaryState: L10n.string("9.2 kWh today"),
                progress: nil,
                value: "4.8",
                unit: "kW"
            )
        }
    }

    func updateLaundry(
        progress: Int,
        power: Int? = nil,
        remainingMinutes: Int? = nil,
        subtitle: String? = nil
    ) -> DemoScenarioPayload {
        let clampedProgress = min(max(progress, 0), 100)
        let remaining = remainingMinutes ?? max(0, 52 - Int(Double(clampedProgress) * 0.52))
        updateEntity("sensor.washing_machine_progress", state: "\(clampedProgress)")
        updateEntity("sensor.washing_machine_remaining_time", state: "\(remaining)")
        updateEntity("sensor.washing_machine_power", state: "\(power ?? (clampedProgress >= 100 ? 3 : 680))")

        let progressEntity = entity(withId: "sensor.washing_machine_progress")!
        let remainingEntity = entity(withId: "sensor.washing_machine_remaining_time")
        return DemoScenarioPayload(
            activityId: "washing_machine",
            title: "Laundry",
            subtitle: subtitle ?? L10n.format("%d min remaining", remaining),
            displayName: L10n.string("Laundry"),
            primaryEntity: progressEntity,
            secondaryEntity: remainingEntity,
            displayStyle: .progress,
            template: .washingMachine,
            iconName: "washer.fill",
            theme: .homeAssistant,
            primaryState: clampedProgress >= 100 ? L10n.string("Complete") : "\(clampedProgress)%",
            secondaryState: clampedProgress >= 100 ? L10n.string("Ready to unload") : L10n.format("%d min remaining", remaining),
            progress: Double(clampedProgress) / 100,
            value: "\(clampedProgress)",
            unit: "%"
        )
    }

    private func updateEntity(_ entityId: String, state: String, attributes: HAEntityAttributes? = nil) {
        guard let index = entities.firstIndex(where: { $0.entityId == entityId }) else { return }
        let current = entities[index]
        entities[index] = HAEntity(
            entityId: current.entityId,
            state: state,
            attributes: attributes ?? current.attributes,
            lastChanged: current.state == state ? current.lastChanged : .now,
            lastUpdated: .now
        )
    }

    private static func makeInitialEntities() -> [HAEntity] {
        [
            entity("light.living_room", "on", L10n.string("Living Room Lights")),
            HAEntity(
                entityId: "climate.bedroom",
                state: "heating",
                attributes: .init(
                    friendlyName: L10n.string("Bedroom Climate"),
                    icon: nil,
                    unitOfMeasurement: nil,
                    deviceClass: nil,
                    batteryLevel: nil,
                    currentTemperature: 20.8,
                    temperature: 22.0,
                    hvacMode: "heating"
                ),
                lastChanged: .now.addingTimeInterval(-540),
                lastUpdated: .now
            ),
            entity("binary_sensor.front_door", "off", L10n.string("Front Door"), deviceClass: "door"),
            entity("sensor.washing_machine_power", "2", L10n.string("Washing Machine Power"), unit: "W", deviceClass: "power"),
            entity("sensor.washing_machine_progress", "0", L10n.string("Washing Machine Progress"), unit: "%"),
            entity("sensor.washing_machine_remaining_time", "0", L10n.string("Washing Machine Remaining Time"), unit: "min", deviceClass: "duration"),
            entity("vacuum.roborock", "docked", "Roborock"),
            entity("lock.front_door", "locked", L10n.string("Front Door Lock")),
            entity("sensor.home_energy_now", "0.8", L10n.string("Home Energy Now"), unit: "kW", deviceClass: "power"),
            entity("sensor.home_energy_today", "7.4", L10n.string("Home Energy Today"), unit: "kWh", deviceClass: "energy"),
            entity("media_player.living_room_tv", "playing", L10n.string("Living Room TV")),
            entity("cover.bedroom_blinds", "65", L10n.string("Bedroom Blinds"), unit: "%")
        ]
    }

    private static func entity(
        _ entityId: String,
        _ state: String,
        _ friendlyName: String,
        unit: String? = nil,
        deviceClass: String? = nil
    ) -> HAEntity {
        HAEntity(
            entityId: entityId,
            state: state,
            attributes: .init(
                friendlyName: friendlyName,
                icon: nil,
                unitOfMeasurement: unit,
                deviceClass: deviceClass,
                batteryLevel: nil,
                currentTemperature: nil,
                temperature: nil,
                hvacMode: nil
            ),
            lastChanged: .now.addingTimeInterval(-300),
            lastUpdated: .now
        )
    }
}
