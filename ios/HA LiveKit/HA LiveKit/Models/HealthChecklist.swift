import Foundation

enum HealthRowState: Equatable {
    case ok
    case info
    case attention
    case off
    case unknown
}

struct HealthChecklistRow: Identifiable, Equatable {
    var id: String
    var title: String
    var status: String
    var state: HealthRowState
    var detail: String?
}

struct HealthChecklist: Equatable {
    var rows: [HealthChecklistRow]
}
