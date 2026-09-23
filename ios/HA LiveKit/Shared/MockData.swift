import Foundation

enum MockData {
    static let washingMachine = HAEntity(
        entityId: "sensor.washing_machine_progress",
        state: "62",
        attributes: .init(
            friendlyName: "Washing Machine Progress",
            icon: "mdi:washing-machine",
            unitOfMeasurement: "%",
            deviceClass: nil,
            batteryLevel: nil,
            currentTemperature: nil,
            temperature: nil,
            hvacMode: nil
        ),
        lastChanged: .now.addingTimeInterval(-900),
        lastUpdated: .now
    )

    static let frontDoor = HAEntity(
        entityId: "binary_sensor.front_door_contact",
        state: "off",
        attributes: .init(
            friendlyName: "Front Door",
            icon: nil,
            unitOfMeasurement: nil,
            deviceClass: "door",
            batteryLevel: nil,
            currentTemperature: nil,
            temperature: nil,
            hvacMode: nil
        ),
        lastChanged: .now.addingTimeInterval(-300),
        lastUpdated: .now
    )

    static let entities: [HAEntity] = [
        washingMachine,
        frontDoor,
        .init(
            entityId: "climate.bedroom",
            state: "heat",
            attributes: .init(
                friendlyName: "Bedroom Climate",
                icon: nil,
                unitOfMeasurement: nil,
                deviceClass: nil,
                batteryLevel: nil,
                currentTemperature: 21.4,
                temperature: 22,
                hvacMode: "heat"
            ),
            lastChanged: .now.addingTimeInterval(-120),
            lastUpdated: .now
        ),
        .init(
            entityId: "sensor.desk_plug_power",
            state: "128",
            attributes: .init(
                friendlyName: "Desk Plug Power",
                icon: "mdi:flash",
                unitOfMeasurement: "W",
                deviceClass: "power",
                batteryLevel: nil,
                currentTemperature: nil,
                temperature: nil,
                hvacMode: nil
            ),
            lastChanged: .now.addingTimeInterval(-60),
            lastUpdated: .now
        )
    ]
}
