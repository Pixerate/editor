import Foundation

/// At most this many cores for the paint engine's parallel work (nil: every core). For measuring
/// how the engine does on a device with fewer cores (an iPad) on a Mac (#826); set it before
/// making the editor (a wet world reads it once).
nonisolated(unsafe) var paintMaxCores: Int?

/// The cores the paint engine's parallel work runs on: every active core, or `paintMaxCores`.
@usableFromInline func paintCoreCount() -> Int {
    let all = Swift.max(1, ProcessInfo.processInfo.activeProcessorCount)
    return paintMaxCores.map { Swift.max(1, Swift.min(all, $0)) } ?? all
}

/**
 * Runs `body` for 0..<count on every core (inline for one item or one core). Only for work whose
 * items are independent: each may read shared state but must write only its own, so the result has
 * the same bits as running them in order.
 */
func paintParallel(_ count: Int, _ body: (Int) -> Void) {
    let workers = Swift.min(count, paintCoreCount())
    if workers <= 1 {
        for i in 0..<count { body(i) }
        return
    }
    withoutActuallyEscaping(body) { body in
        nonisolated(unsafe) let fn = body
        DispatchQueue.concurrentPerform(iterations: workers) { c in
            for i in stride(from: c, to: count, by: workers) { fn(i) }
        }
    }
}
