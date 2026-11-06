import Foundation

/// The histories a call's changes land in, for `originMiddleware`.
public enum OriginHistories {
    case one(HistoryManager)
    case many([HistoryManager])
    /// Chosen per call (e.g. by `call.provider.id`); `nil` or empty leaves the call alone.
    case perCall((ToolMiddlewareCall) -> [HistoryManager]?)
}

/**
 A `ToolRegistry` middleware that records the changes a tool call makes as the calling agent's
 (`agent:<actor.id>`, or `fallbackOrigin` without an actor), as `createOriginMiddleware` in
 `tools/origin.ts`. Read-only tools pass straight through. While a handler runs, other changes
 recorded on the same history are stamped with the agent's origin too.
 */
public func originMiddleware(_ histories: OriginHistories, fallbackOrigin: String = "agent:anonymous") -> ToolMiddleware {
    { call, next in
        if call.tool.definition.annotations?.readOnlyHint == true { return try await next() }
        let targets: [HistoryManager]
        switch histories {
        case .one(let h): targets = [h]
        case .many(let list): targets = list
        case .perCall(let pick): targets = pick(call) ?? []
        }
        if targets.isEmpty { return try await next() }
        let origin = call.context.actor.map { agentOrigin($0.id) } ?? fallbackOrigin
        // The first history wraps the rest, as reduceRight builds it in TS.
        nonisolated(nonsending) func run(_ i: Int) async throws -> ToolOutput {
            i < targets.count ? try await targets[i].withOrigin(origin) { try await run(i + 1) } : try await next()
        }
        return try await run(0)
    }
}
