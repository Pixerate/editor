// Fitting words to a column (#813), ported line for line from packages/core/src/typography/fit.ts:
// the largest size (and, if asked, a tighter letter spacing) at which every word fits a width, and
// two staggered rows when one row is too tight. The caller measures text: `coreTextMeasure` does it
// with CoreText; tests pass a fixed-width stand-in.
import Foundation
import PixerateRaster
#if canImport(CoreText)
import CoreText
#endif

/// Width in px of a word set at `size` px with `letterSpacing` px added after each character.
public typealias MeasureText = (_ word: String, _ size: Double, _ letterSpacing: Double) -> Double

public struct FitTextResult: Sendable, Equatable {
    public var size: Double
    /// Letter spacing in px (0 unless tracking was needed).
    public var letterSpacing: Double
    public var fits: Bool
    /// The widest word at the result, which set the limit (nil with no words).
    public var word: String?
}

public enum FitTextError: Error, CustomStringConvertible, Equatable {
    case invalid(String)
    public var description: String { switch self { case .invalid(let m): return m } }
}

private func widest(_ words: [String], _ measure: MeasureText, _ size: Double, _ spacing: Double) -> (word: String?, width: Double) {
    var word: String? = nil
    var width = -Double.infinity
    for w in words {
        let m = measure(w, size, spacing)
        if m > width {
            width = m
            word = w
        }
    }
    return (word, width)
}

/// The largest size on the `step` grid from `min` up to `max` at which the widest word fits
/// `width` (`fitText` in the TS core). `tracking` is `(floor, step)` in em, off when nil.
public func fitText(_ words: [String], _ width: Double, measure: MeasureText, min minOption: Double = 8, max maxOption: Double = 32, step: Double = 0.5, tracking: (floor: Double, step: Double)? = nil) throws -> FitTextResult {
    let min = minOption
    let max = Swift.max(min, maxOption)
    if !(step > 0) { throw FitTextError.invalid("step must be a positive number of px.") }
    if words.isEmpty { return FitTextResult(size: max, letterSpacing: 0, fits: true, word: nil) }
    func fitsAt(_ size: Double, _ spacing: Double) -> Bool { widest(words, measure, size, spacing).width <= width }
    let top = JS.floor((max - min) / step + 1e-9)
    if fitsAt(min, 0) {
        var lo = 0.0
        var hi = top
        while lo < hi {
            let mid = JS.ceil((lo + hi) / 2)
            if fitsAt(min + mid * step, 0) { lo = mid } else { hi = mid - 1 }
        }
        let size = min + lo * step
        return FitTextResult(size: size, letterSpacing: 0, fits: true, word: widest(words, measure, size, 0).word)
    }
    if let tracking {
        let floor = Swift.min(0, tracking.floor)
        let tStep = tracking.step
        if !(tStep > 0) { throw FitTextError.invalid("tracking.step must be a positive number of em.") }
        let count = Int(JS.floor(-floor / tStep + 1e-9))
        if count >= 1 {
            for k in 1...count {
                let spacing = -Double(k) * tStep * min
                if fitsAt(min, spacing) { return FitTextResult(size: min, letterSpacing: spacing, fits: true, word: widest(words, measure, min, spacing).word) }
            }
        }
        let spacing = count > 0 ? -Double(count) * tStep * min : 0
        return FitTextResult(size: min, letterSpacing: spacing, fits: false, word: widest(words, measure, min, spacing).word)
    }
    return FitTextResult(size: min, letterSpacing: 0, fits: false, word: widest(words, measure, min, 0).word)
}

public struct StaggerRowsResult: Sendable, Equatable {
    /// Row of each word, in the words' order: 0, or 1 for the second row.
    public var rows: [Int]
    /// 1 when one row fits, otherwise 2.
    public var count: Int
    public var fits: Bool
}

/// Whether words centred at `positions` fit in one row, and if not, alternating rows
/// (`staggerRows` in the TS core).
public func staggerRows(_ words: [String], _ positions: [Double], measure: MeasureText, size: Double, letterSpacing: Double = 0, gap: Double = 4) -> StaggerRowsResult {
    let n = Swift.min(words.count, positions.count)
    let order = (0..<n).sorted { a, b in
        let d = positions[a] - positions[b]
        return d != 0 ? d < 0 : a < b
    }
    let half = order.map { measure(words[$0], size, letterSpacing) / 2 }
    func clear(_ stride: Int) -> Bool {
        var k = 0
        while k + stride < n {
            if positions[order[k]] + half[k] + gap > positions[order[k + stride]] - half[k + stride] { return false }
            k += 1
        }
        return true
    }
    var rows = [Int](repeating: 0, count: n)
    if clear(1) { return StaggerRowsResult(rows: rows, count: 1, fits: true) }
    for k in 0..<n { rows[order[k]] = k % 2 }
    return StaggerRowsResult(rows: rows, count: 2, fits: clear(2))
}

#if canImport(CoreText)
/// A `MeasureText` for a font by PostScript name, measured with CoreText (kerning on).
public func coreTextMeasure(fontName: String) -> MeasureText {
    { word, size, spacing in
        let font = CTFontCreateWithName(fontName as CFString, CGFloat(size), nil)
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTKernAttributeName as String): spacing
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: word, attributes: attributes))
        // CoreText adds the kern after every character, the last included; the TS measure doesn't.
        let count = Double(word.count)
        return Double(CTLineGetTypographicBounds(line, nil, nil, nil)) - (count > 0 ? spacing : 0)
    }
}
#endif
