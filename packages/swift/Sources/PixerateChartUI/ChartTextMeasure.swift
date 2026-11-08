import CoreGraphics
import CoreText
import Foundation
import PixerateChart

/// Measures chart text width in points using CoreText (`CTFont` + `CTLineGetTypographicBounds`).
/// Conformance tests continue to use the deterministic `estimateChartTextWidth` formula; real
/// macOS and iOS apps can pass `coreTextChartMeasureText` to `ChartControllerOptions` or
/// `ChartLayoutOptions` for exact system font metrics.
public func coreTextChartMeasureText(_ text: String, _ size: Double, _ weight: Double?) -> Double {
    guard !text.isEmpty else { return 0 }
    guard size.isFinite, size > 0 else { return estimateChartTextWidth(text, size, weight) }
    let ctFont = makeChartCTFont(size: size, weight: weight)
    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): ctFont
    ]
    let attrString = NSAttributedString(string: text, attributes: attrs)
    let line = CTLineCreateWithAttributedString(attrString)
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    return width.isFinite && width > 0 ? Double(width) : estimateChartTextWidth(text, size, weight)
}

/// Builds a `CTFont` for system UI rendering at the given point size and CSS weight (100...900).
internal func makeChartCTFont(size: Double, weight: Double?) -> CTFont {
    let cgSize = CGFloat(Swift.max(1.0, size))
    let isBold = (weight ?? 400.0) >= 600.0
    let baseFont = CTFontCreateUIFontForLanguage(isBold ? .emphasizedSystem : .system, cgSize, nil)
        ?? CTFontCreateWithName("Helvetica" as CFString, cgSize, nil)
    guard let w = weight, w != 400.0, w != 600.0, w != 700.0 else {
        return baseFont
    }
    // Map CSS weight (100...900) to CoreText weight trait (-0.8 ... +0.6).
    let normalized = Swift.max(-0.8, Swift.min(0.6, ((w - 400.0) / 500.0) * 0.6))
    let traits: [CFString: Any] = [
        kCTFontWeightTrait: normalized
    ]
    let attrs: [CFString: Any] = [
        kCTFontTraitsAttribute: traits
    ]
    let desc = CTFontDescriptorCreateWithAttributes(attrs as CFDictionary)
    return CTFontCreateCopyWithAttributes(baseFont, cgSize, nil, desc)
}

/// A real-time / controllable frame ticker for bar-chart race playback (`ChartRaceTicker`).
/// In apps, `ChartDisplayTicker()` schedules frame callbacks on the main queue at `intervalMs`
/// (default 16 ms ≈ 60 fps); in tests, `manual: true` lets callers advance time with `advance(_:)`
/// and verify frame callbacks deterministically.
public final class ChartDisplayTicker: @unchecked Sendable {
    private let lock = NSLock()
    private let manual: Bool
    private let intervalMs: Int
    private var currentTimeMs: Double
    private var nextId: Int = 1
    private var pending: [Int: @Sendable () -> Void] = [:]

    public init(intervalMs: Int = 16, manual: Bool = false, initialTimeMs: Double = 0) {
        self.intervalMs = Swift.max(1, intervalMs)
        self.manual = manual
        self.currentTimeMs = manual ? initialTimeMs : ProcessInfo.processInfo.systemUptime * 1000.0
    }

    /// The `ChartRaceTicker` to pass to `ChartControllerOptions(raceTicker:)`.
    public var raceTicker: ChartRaceTicker {
        ChartRaceTicker(
            now: { [weak self] in
                guard let self else { return ProcessInfo.processInfo.systemUptime * 1000.0 }
                return self.now()
            },
            next: { [weak self] step in
                guard let self else { return {} }
                return self.schedule(step)
            }
        )
    }

    /// Current timestamp in milliseconds.
    public func now() -> Double {
        lock.lock()
        defer { lock.unlock() }
        if !manual {
            currentTimeMs = ProcessInfo.processInfo.systemUptime * 1000.0
        }
        return currentTimeMs
    }

    /// Schedules the next frame callback and returns a cancellation closure.
    public func schedule(_ step: @escaping @Sendable () -> Void) -> (@Sendable () -> Void) {
        lock.lock()
        let id = nextId
        nextId += 1
        pending[id] = step
        let isManual = manual
        let delayMs = intervalMs
        lock.unlock()

        if !isManual {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs)) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let callback = self.pending.removeValue(forKey: id)
                self.lock.unlock()
                callback?()
            }
        }

        return { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.pending.removeValue(forKey: id)
            self.lock.unlock()
        }
    }

    /// Number of currently scheduled callbacks.
    public var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }

    /// Advances the clock by `deltaMs` and fires all currently scheduled frame callbacks.
    public func advance(_ deltaMs: Double) {
        lock.lock()
        currentTimeMs += Swift.max(0, deltaMs)
        let callbacks = Array(pending.values)
        pending.removeAll()
        lock.unlock()
        for cb in callbacks {
            cb()
        }
    }
}
