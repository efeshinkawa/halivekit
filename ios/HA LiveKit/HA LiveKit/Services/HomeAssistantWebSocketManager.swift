import Foundation

@MainActor
final class HomeAssistantWebSocketManager {
    var onEntityChanged: ((HAEntity, UUID) -> Void)?
    var onActivityRequest: ((HALiveKitActivityRequest, UUID) -> Void)?
    var onStatusChanged: ((ConnectionDiagnosticStatus, String?, UUID) -> Void)?
    var onSubscribedEventTypesChanged: (([String], UUID) -> Void)?
    var onEventReceived: ((String, UUID) -> Void)?
    var onLog: ((String, UUID) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var listenTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var configuration: ConnectionConfiguration?
    private var connectionID: UUID?
    private var shouldReconnect = false
    private var reconnectAttempts = 0
    private var nextMessageId = 1
    private let session: URLSession

    init(session: URLSession = .haliveKit) {
        self.session = session
    }

    func connect(configuration: ConnectionConfiguration, connectionID: UUID) async throws {
        self.configuration = configuration
        self.connectionID = connectionID
        shouldReconnect = true
        reconnectAttempts = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        closeSocket()

        do {
            try await withTimeout(seconds: 10, timeoutError: .webSocketTimeout) {
                try await self.openSocket(
                    configuration: configuration,
                    connectionID: connectionID
                )
            }
        } catch {
            guard isCurrentConnection(connectionID), !(error is CancellationError) else {
                throw error
            }
            closeSocket()
            onStatusChanged?(.failed, error.localizedDescription, connectionID)
            throw error
        }
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        closeSocket()
        configuration = nil
        connectionID = nil
    }

    private func openSocket(
        configuration: ConnectionConfiguration,
        connectionID: UUID
    ) async throws {
        guard isCurrentConnection(connectionID), shouldReconnect else {
            throw CancellationError()
        }
        closeSocket()
        onStatusChanged?(.connecting, nil, connectionID)
        onSubscribedEventTypesChanged?([], connectionID)
        let socketURL = try webSocketURL(from: configuration.baseURL)
        let socketTask = session.webSocketTask(with: socketURL)
        task = socketTask
        socketTask.resume()

        let authRequired = try await receiveEnvelope(from: socketTask)
        try requireCurrent(socketTask, connectionID: connectionID)
        guard authRequired.type == "auth_required" else {
            throw HALiveKitError.invalidResponse
        }

        try await sendJSON([
            "type": "auth",
            "access_token": configuration.token
        ], to: socketTask)
        try requireCurrent(socketTask, connectionID: connectionID)

        let auth = try await receiveEnvelope(from: socketTask)
        try requireCurrent(socketTask, connectionID: connectionID)
        guard auth.type == "auth_ok" else {
            throw HALiveKitError.webSocketAuthFailed(auth.message)
        }

        try await subscribe(
            eventType: "state_changed",
            socketTask: socketTask,
            connectionID: connectionID
        )
        try await subscribe(
            eventType: "ha_livekit_activity_request",
            socketTask: socketTask,
            connectionID: connectionID
        )
        try requireCurrent(socketTask, connectionID: connectionID)

        onLog?("WebSocket subscribed to state and HA LiveKit events.", connectionID)
        onStatusChanged?(.connected, nil, connectionID)
        onSubscribedEventTypesChanged?(["state_changed", "ha_livekit_activity_request"], connectionID)
        reconnectAttempts = 0
        listenTask = Task { [weak self, socketTask] in
            await self?.listenLoop(socketTask: socketTask, connectionID: connectionID)
        }
    }

    private func closeSocket() {
        listenTask?.cancel()
        listenTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func listenLoop(
        socketTask: URLSessionWebSocketTask,
        connectionID: UUID
    ) async {
        while !Task.isCancelled {
            do {
                let data = try await receiveData(from: socketTask)
                try requireCurrent(socketTask, connectionID: connectionID)
                handleEventData(data, connectionID: connectionID)
            } catch {
                if !Task.isCancelled,
                   isCurrent(socketTask, connectionID: connectionID),
                   !(error is CancellationError) {
                    onLog?("WebSocket disconnected: \(error.localizedDescription)", connectionID)
                    onStatusChanged?(.disconnected, error.localizedDescription, connectionID)
                    scheduleReconnect(connectionID: connectionID)
                }
                return
            }
        }
    }

    private func scheduleReconnect(connectionID: UUID) {
        guard shouldReconnect,
              isCurrentConnection(connectionID),
              reconnectTask == nil,
              let configuration
        else { return }

        reconnectAttempts += 1
        let delay = min(pow(2.0, Double(reconnectAttempts)), 30)
        onStatusChanged?(.connecting, "Reconnecting in \(Int(delay))s", connectionID)
        onLog?("Reconnecting WebSocket in \(Int(delay))s.", connectionID)

        reconnectTask = Task { [weak self, configuration] in
            do {
                try await Task.sleep(for: .seconds(delay))
                try Task.checkCancellation()
                await self?.retryConnection(
                    configuration: configuration,
                    connectionID: connectionID
                )
            } catch {
                return
            }
        }
    }

    private func retryConnection(
        configuration: ConnectionConfiguration,
        connectionID: UUID
    ) async {
        guard isCurrentConnection(connectionID), shouldReconnect else { return }
        reconnectTask = nil

        do {
            try await withTimeout(seconds: 10, timeoutError: .webSocketTimeout) {
                try await self.openSocket(
                    configuration: configuration,
                    connectionID: connectionID
                )
            }
        } catch {
            guard isCurrentConnection(connectionID), !(error is CancellationError) else { return }
            onStatusChanged?(.failed, error.localizedDescription, connectionID)
            onLog?("WebSocket reconnect failed: \(error.localizedDescription)", connectionID)
            scheduleReconnect(connectionID: connectionID)
        }
    }

    private func receiveEnvelope(
        from socketTask: URLSessionWebSocketTask
    ) async throws -> HAWebSocketEnvelope {
        let data = try await receiveData(from: socketTask)
        return try JSONDecoder.homeAssistant.decode(HAWebSocketEnvelope.self, from: data)
    }

    private func subscribe(
        eventType: String,
        socketTask: URLSessionWebSocketTask,
        connectionID: UUID
    ) async throws {
        try requireCurrent(socketTask, connectionID: connectionID)
        let subscribeId = nextId()
        try await sendJSON([
            "id": subscribeId,
            "type": "subscribe_events",
            "event_type": eventType
        ], to: socketTask)

        let subscribe = try await receiveResult(
            id: subscribeId,
            socketTask: socketTask,
            connectionID: connectionID
        )
        guard subscribe.success != false else {
            throw HALiveKitError.message(subscribe.message ?? L10n.format("Could not subscribe to %@.", eventType))
        }
    }

    private func receiveResult(
        id: Int,
        socketTask: URLSessionWebSocketTask,
        connectionID: UUID
    ) async throws -> HAWebSocketEnvelope {
        while true {
            let data = try await receiveData(from: socketTask)
            try requireCurrent(socketTask, connectionID: connectionID)

            if let envelope = try? JSONDecoder.homeAssistant.decode(HAWebSocketEnvelope.self, from: data),
               envelope.type == "result",
               envelope.id == id {
                return envelope
            }

            handleEventData(data, connectionID: connectionID)
        }
    }

    private func handleEventData(_ data: Data, connectionID: UUID) {
        guard isCurrentConnection(connectionID) else { return }
        if let envelope = try? JSONDecoder.homeAssistant.decode(HAWebSocketEnvelope.self, from: data),
           envelope.event?.eventType == "state_changed",
           let entity = envelope.event?.data.newState {
            onEventReceived?("state_changed", connectionID)
            onEntityChanged?(entity, connectionID)
            return
        }

        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = object["event"] as? [String: Any],
              event["event_type"] as? String == "ha_livekit_activity_request",
              let requestData = event["data"] as? [String: Any],
              let request = HALiveKitActivityRequest(dictionary: requestData)
        else {
            return
        }

        onEventReceived?("ha_livekit_activity_request", connectionID)
        onActivityRequest?(request, connectionID)
    }

    private func receiveData(from socketTask: URLSessionWebSocketTask) async throws -> Data {
        let message = try await socketTask.receive()
        switch message {
        case .data(let data):
            return data
        case .string(let string):
            return Data(string.utf8)
        @unknown default:
            throw HALiveKitError.invalidResponse
        }
    }

    private func sendJSON(
        _ object: [String: Any],
        to socketTask: URLSessionWebSocketTask
    ) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let string = String(data: data, encoding: .utf8) else {
            throw HALiveKitError.invalidResponse
        }

        try await socketTask.send(.string(string))
    }

    private func isCurrentConnection(_ connectionID: UUID) -> Bool {
        self.connectionID == connectionID
    }

    private func isCurrent(
        _ socketTask: URLSessionWebSocketTask,
        connectionID: UUID
    ) -> Bool {
        isCurrentConnection(connectionID) && task === socketTask
    }

    private func requireCurrent(
        _ socketTask: URLSessionWebSocketTask,
        connectionID: UUID
    ) throws {
        try Task.checkCancellation()
        guard isCurrent(socketTask, connectionID: connectionID) else {
            throw CancellationError()
        }
    }

    private func nextId() -> Int {
        defer { nextMessageId += 1 }
        return nextMessageId
    }

    private func webSocketURL(from baseURL: URL) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw HALiveKitError.invalidURL
        }

        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        case "http":
            components.scheme = "ws"
        default:
            throw HALiveKitError.invalidURL
        }

        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? "/api/websocket" : "/\(basePath)/api/websocket"

        guard let url = components.url else {
            throw HALiveKitError.invalidURL
        }

        return url
    }

    static func webSocketURLString(from baseURL: URL) -> String? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        case "http":
            components.scheme = "ws"
        default:
            return nil
        }

        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? "/api/websocket" : "/\(basePath)/api/websocket"
        return components.url?.absoluteString
    }

    static func redactedWebSocketURLString(from baseURL: URL) -> String? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        case "http":
            components.scheme = "ws"
        default:
            return nil
        }

        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        components.path = "/api/websocket"
        guard let url = components.url else {
            return nil
        }
        return LogSanitizer.redactedURLString(url, includePath: true)
    }
}

private struct HAWebSocketEnvelope: Decodable {
    var id: Int?
    var type: String
    var success: Bool?
    var message: String?
    var event: HAStateChangedEvent?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case success
        case message
        case event
    }
}

private struct HAStateChangedEvent: Decodable {
    var eventType: String?
    var data: HAStateChangedData

    enum CodingKeys: String, CodingKey {
        case eventType = "event_type"
        case data
    }
}

private struct HAStateChangedData: Decodable {
    var entityId: String
    var newState: HAEntity?

    enum CodingKeys: String, CodingKey {
        case entityId = "entity_id"
        case newState = "new_state"
    }
}
