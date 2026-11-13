import Foundation

/**
 * Runs `body` for 0..<count on every core (inline for one item or one core). Only for work whose
 * items are independent: each may read shared state but must write only its own, so the result has
 * the same bits as running them in order.
 */
func paintParallel(_ count: Int, _ body: (Int) -> Void) {
    let workers = Swift.min(count, Swift.max(1, ProcessInfo.processInfo.activeProcessorCount))
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
