import Foundation

// Text treatments (#887): how an agent's edits to text look, as `effects/text-treatment.ts` in the
// TypeScript core describes them. A treatment draws each stage of an edit (checking, selecting,
// typing, landed, and the agent's caret) over the host's text and never changes it: the host
// passes the range's line rectangles and the caret, and gets back a layer plan (rectangles,
// gradients, name tags, ribbons and their opacities, in the host's coordinates, y down) for a
// `TextTreatmentRenderer` to draw behind or above the text.
//
// Treatments come from a `TextTreatmentProvider` (Flair's catalog). Without one, hosts draw the
// built-in treatment (`BuiltInTextTreatment`): the editors' own look. Its plans match the
// TypeScript ones exactly (`@pixerate/conformance`, `domains/agent-text/treatment-plans.json`).

/// The stages of an agent's edit, in the order they play.
public enum TextTreatmentStage: String, Sendable, CaseIterable {
    /// The agent's insertion point, with a name tag when the target has a label (loops).
    case caret
    /// A sweep across the word or line being looked at.
    case checking
    /// The selection appearing over what will be replaced.
    case selecting
    /// The text being typed, with the caret at its end (loops while it types).
    case typing
    /// What changed, tinted, then fading.
    case landed
}

/// A colour's channels and alpha, 0 to 1.
public struct TextTreatmentRGBA: Equatable, Sendable {
    public var r: Double, g: Double, b: Double, a: Double
    public init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }

    /// `#rrggbb`, or nil.
    public init?(hex: String) {
        let text = hex.trimmingCharacters(in: .whitespaces)
        guard text.count == 7, text.hasPrefix("#"), let v = UInt32(text.dropFirst(), radix: 16) else { return nil }
        self.init(Double((v >> 16) & 0xff) / 255, Double((v >> 8) & 0xff) / 255, Double(v & 0xff) / 255, 1)
    }

    func with(alpha: Double) -> TextTreatmentRGBA { TextTreatmentRGBA(r, g, b, alpha) }
}

/// A rectangle in the host's coordinates, y down: one line of the range.
public struct TextTreatmentRect: Equatable, Sendable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// An insertion point: its x, the top of its line and the line's height.
public struct TextTreatmentCaret: Equatable, Sendable {
    public var x: Double, y: Double, height: Double
    public init(x: Double, y: Double, height: Double) {
        self.x = x
        self.y = y
        self.height = height
    }
}

/// What a treatment draws over. A host whose typing frames already change the text (the
/// `AgentTextDirector`) leaves out `text` and `background`, so the typed word is not drawn twice.
public struct TextTreatmentTarget: Equatable, Sendable {
    /// The range's lines, in reading order.
    public var lines: [TextTreatmentRect]
    /// The insertion point (for the caret and its tag).
    public var caret: TextTreatmentCaret?
    /// `typing`: what has been typed so far, for a treatment that draws it over the old text.
    public var text: String?
    /// A name tag for the caret (the agent's name).
    public var label: String?
    /// The text's colour.
    public var color: TextTreatmentRGBA?
    /// The colour behind the text, for a treatment that covers the old text while typing.
    public var background: TextTreatmentRGBA?
    /// The text's font (a CSS font on the web; a PostScript name for a native renderer).
    public var font: String?

    public init(lines: [TextTreatmentRect] = [], caret: TextTreatmentCaret? = nil, text: String? = nil, label: String? = nil,
                color: TextTreatmentRGBA? = nil, background: TextTreatmentRGBA? = nil, font: String? = nil) {
        self.lines = lines
        self.caret = caret
        self.text = text
        self.label = label
        self.color = color
        self.background = background
        self.font = font
    }
}

/// What a treatment is asked for: a stage `time` ms in, over `target`.
public struct TextTreatmentPlanRequest: Equatable, Sendable {
    public var stage: TextTreatmentStage
    /// Ms into the stage (0 or more).
    public var time: Double
    public var target: TextTreatmentTarget
    /// Draws the stage without motion: held, and faded (Reduce Motion).
    public var reduceMotion: Bool

    public init(stage: TextTreatmentStage, time: Double, target: TextTreatmentTarget, reduceMotion: Bool = false) {
        self.stage = stage
        self.time = time
        self.target = target
        self.reduceMotion = reduceMotion
    }
}

/// A linear gradient in the host's coordinates, padded with its end colours past its ends.
public struct TextTreatmentGradient: Equatable, Sendable {
    public struct Stop: Equatable, Sendable {
        public var offset: Double
        public var color: TextTreatmentRGBA
        public init(offset: Double, color: TextTreatmentRGBA) {
            self.offset = offset
            self.color = color
        }
    }
    public var x0: Double, y0: Double, x1: Double, y1: Double
    public var stops: [Stop]
    public init(x0: Double, y0: Double, x1: Double, y1: Double, stops: [Stop]) {
        self.x0 = x0
        self.y0 = y0
        self.x1 = x1
        self.y1 = y1
        self.stops = stops
    }
}

/// A piece of a ribbon: a polygon filled in one colour.
public struct TextTreatmentSegment: Equatable, Sendable {
    public var points: [(x: Double, y: Double)]
    public var color: TextTreatmentRGBA
    public init(points: [(x: Double, y: Double)], color: TextTreatmentRGBA) {
        self.points = points
        self.color = color
    }

    public static func == (a: Self, b: Self) -> Bool {
        a.color == b.color && a.points.count == b.points.count && zip(a.points, b.points).allSatisfy { $0.x == $1.x && $0.y == $1.y }
    }
}

/// One thing to draw (see `TextTreatmentLayer` in the TypeScript core):
/// - `rect`: a rectangle with corner `radius`, filled with `color` (or `gradient`), or outlined `stroke` wide.
/// - `text`: `text` in `font`, left-aligned at `x`, centred down the line from `y` to `y + height`.
/// - `tag`: a pill `height` tall whose bottom-left corner is (`x`, `y + height`), holding `text`
///   (`size` pt, `textColor`) with `padX` either side; the renderer measures the text (`width` is 0).
/// - `path`: a ribbon, `segments` drawn as one group at `opacity`.
public struct TextTreatmentLayer: Equatable, Sendable {
    public enum Kind: String, Sendable { case rect, text, tag, path }
    public enum Z: String, Sendable { case behind, above }
    public var kind: Kind
    /// The provider's name for what made it (`fill`, `band`, `caret`, `tag`, …).
    public var source: String
    public var z: Z
    public var x: Double, y: Double, width: Double, height: Double
    public var radius: Double
    /// Multiplies `color`'s alpha.
    public var opacity: Double
    public var color: TextTreatmentRGBA
    public var gradient: TextTreatmentGradient?
    public var stroke: Double?
    public var glow: Double?
    /// `normal`, `multiply`, `screen` or `plus-lighter`.
    public var blend: String
    public var text: String?
    public var font: String?
    public var size: Double?
    public var padX: Double?
    public var textColor: TextTreatmentRGBA?
    public var segments: [TextTreatmentSegment]?

    public init(kind: Kind, source: String, z: Z, x: Double, y: Double, width: Double, height: Double, radius: Double = 0,
                opacity: Double = 1, color: TextTreatmentRGBA, gradient: TextTreatmentGradient? = nil, stroke: Double? = nil,
                glow: Double? = nil, blend: String = "normal", text: String? = nil, font: String? = nil, size: Double? = nil,
                padX: Double? = nil, textColor: TextTreatmentRGBA? = nil, segments: [TextTreatmentSegment]? = nil) {
        self.kind = kind
        self.source = source
        self.z = z
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.radius = radius
        self.opacity = opacity
        self.color = color
        self.gradient = gradient
        self.stroke = stroke
        self.glow = glow
        self.blend = blend
        self.text = text
        self.font = font
        self.size = size
        self.padX = padX
        self.textColor = textColor
        self.segments = segments
    }
}

/// A stage at a moment, ready to draw.
public struct TextTreatmentPlan: Equatable, Sendable {
    public var stage: TextTreatmentStage
    /// Ms into the stage, as asked.
    public var time: Double
    /// Ms the stage takes for this target (a looping stage's one pass).
    public var duration: Double
    /// Whether it has finished (never, for a looping stage): see `textTreatmentFrame`.
    public var done: Bool
    /// Whether it was drawn without motion.
    public var reduced: Bool
    public var layers: [TextTreatmentLayer]

    public init(stage: TextTreatmentStage, time: Double, duration: Double, done: Bool, reduced: Bool, layers: [TextTreatmentLayer]) {
        self.stage = stage
        self.time = time
        self.duration = duration
        self.done = done
        self.reduced = reduced
        self.layers = layers
    }
}

/// What went wrong planning a treatment: `unknown_effect`, `invalid_values` or `unsupported`, as the effects contract's errors.
public struct TextTreatmentError: Error, LocalizedError, Equatable {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    public var errorDescription: String? { message }
}

/// Checks a request's time and target, as `checkTextTreatmentRequest` does.
public func checkTextTreatmentRequest(_ request: TextTreatmentPlanRequest) throws {
    guard request.time.isFinite, request.time >= 0 else {
        throw TextTreatmentError("unsupported", "The time is ms into the stage, 0 or more; it was \(jsNumber(request.time)).")
    }
    for (i, l) in request.target.lines.enumerated() where !(l.x.isFinite && l.y.isFinite && l.width.isFinite && l.height.isFinite && l.width >= 0 && l.height >= 0) {
        throw TextTreatmentError("unsupported", "Line \(i) of the target is { x, y, width, height } in px, with width and height 0 or more.")
    }
    if let c = request.target.caret, !(c.x.isFinite && c.y.isFinite && c.height.isFinite && c.height >= 0) {
        throw TextTreatmentError("unsupported", "The target's caret is { x, y, height } in px (y the top of its line).")
    }
}

private func jsNumber(_ v: Double) -> String {
    if v.isNaN { return "NaN" }
    if v.isInfinite { return v > 0 ? "Infinity" : "-Infinity" }
    return v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
}

// MARK: - Providers

/// A source of text treatments (`EffectProvider.textTreatmentPlan` with `supportsTextTreatments`):
/// Flair's `FlairTextTreatments`. Planning is synchronous and pure, so a host can call it every frame.
public protocol TextTreatmentProvider: AnyObject {
    /// The treatment drawn when nobody has chosen one, or nil for the built-in one.
    var defaultTextTreatment: String? { get }
    /// What treatment `id` draws for `request` (see `TextTreatmentPlan`). Every treatment has a
    /// `color` value (the agent's colour, `#rrggbb`). Throws `TextTreatmentError` (or the
    /// provider's own error) for an unknown id, bad values or a bad request.
    func textTreatmentPlan(_ id: String, _ request: TextTreatmentPlanRequest, values: JSONObject?) throws -> TextTreatmentPlan
}

/// Draws plans over a host's text: `FlairTextTreatmentRenderer` with Core Animation layers, or a
/// host's own overlay. Each call replaces what it drew before; `[]` clears it.
@MainActor
public protocol TextTreatmentRenderer: AnyObject {
    /// Draws `plans` in order: every plan's `behind` layers under the text, its `above` layers over it.
    func draw(_ plans: [TextTreatmentPlan])
}

/// Plans `request` with the provider's treatment (`id`, else its default), or the built-in one when
/// there is none (which reads only `color` from `values`).
public func planTextTreatment(_ provider: TextTreatmentProvider?, _ request: TextTreatmentPlanRequest, id: String? = nil, values: JSONObject? = nil) throws -> TextTreatmentPlan {
    if let provider, let id = id ?? provider.defaultTextTreatment {
        return try provider.textTreatmentPlan(id, request, values: values)
    }
    return try BuiltInTextTreatment.plan(request, color: values?["color"]?.stringValue)
}

/// The plan to draw for `stage` at `time`, or nil when there is nothing to draw: a finished
/// `checking` or `landed` stage is removed, and a finished `selecting` stage holds its last frame.
public func textTreatmentFrame(_ stage: TextTreatmentStage, at time: Double, planAt: (Double) throws -> TextTreatmentPlan) rethrows -> TextTreatmentPlan? {
    let plan = try planAt(time)
    if !plan.done { return plan }
    if stage == .selecting { return plan.time == plan.duration ? plan : try planAt(plan.duration) }
    return nil
}

// MARK: - The built-in treatment

/// The editors' own look, drawn without a provider: a 2 pt caret with a name tag, a tinted selection
/// (28%) and a tint on what changed (18%, until the host clears it), plus a soft band sweeping
/// across the lines while checking (with Reduce Motion, the lines fade in and out instead).
public enum BuiltInTextTreatment {
    public static let id = "built-in"
    /// The agent's colour when none is given (`defaultAgentCaretColor`).
    public static let color = "#8b5cf6"
    /// How long the checking sweep takes, in ms.
    public static let checkMs: Double = 480
    /// One pass of a looping stage, in ms.
    public static let loopMs: Double = 1000

    private static let selectAlpha = 0.28
    private static let changedAlpha = 0.18
    private static let sweepAlpha = 0.22
    private static let sweepWidth = 0.4
    private static let tagSize = 11.0
    private static let tagHeight = 16.5
    private static let tagPadX = 5.0
    private static let tagRadius = 3.0
    private static let caretWidth = 2.0

    private static func clamp01(_ x: Double) -> Double { x < 0 ? 0 : x > 1 ? 1 : x }

    /// The plan for `request` in the agent's `color` (`#rrggbb`, default violet). Pure, and the same
    /// as the TypeScript `builtInTextTreatmentPlan`.
    public static func plan(_ request: TextTreatmentPlanRequest, color hex: String? = nil) throws -> TextTreatmentPlan {
        try checkTextTreatmentRequest(request)
        guard let color = TextTreatmentRGBA(hex: hex ?? Self.color) else {
            throw TextTreatmentError("invalid_values", "Invalid values for effect \"\(id)\":\n- /color: must be a colour \"#rrggbb\"; it was \"\(hex ?? "")\".")
        }
        let stage = request.stage
        let time = request.time
        let target = request.target
        let lines = target.lines.filter { $0.width > 0 && $0.height > 0 }
        var layers: [TextTreatmentLayer] = []

        func fills(_ source: String, _ alpha: Double, opacity: Double = 1) {
            guard opacity > 0 else { return }
            for l in lines {
                layers.append(TextTreatmentLayer(kind: .rect, source: source, z: .behind, x: l.x, y: l.y, width: l.width, height: l.height, opacity: opacity, color: color.with(alpha: alpha)))
            }
        }
        func caret() {
            guard let c = target.caret, c.height > 0 else { return }
            layers.append(TextTreatmentLayer(kind: .rect, source: "caret", z: .above, x: c.x - caretWidth / 2, y: c.y, width: caretWidth, height: c.height, color: color))
            if let label = target.label, !label.isEmpty {
                layers.append(TextTreatmentLayer(kind: .tag, source: "tag", z: .above, x: c.x - caretWidth / 2, y: c.y - tagHeight, width: 0, height: tagHeight,
                                                 radius: tagRadius, color: color, text: label, size: tagSize, padX: tagPadX, textColor: TextTreatmentRGBA(1, 1, 1, 1)))
            }
        }
        func plan(_ duration: Double, loop: Bool) -> TextTreatmentPlan {
            TextTreatmentPlan(stage: stage, time: time, duration: duration, done: !loop && time >= duration, reduced: request.reduceMotion, layers: layers)
        }

        switch stage {
        case .caret, .typing:
            caret()
            return plan(loopMs, loop: true)
        case .selecting:
            fills("selection", selectAlpha)
            caret()
            return plan(0, loop: false)
        case .landed:
            fills("changed", changedAlpha)
            return plan(loopMs, loop: true)
        case .checking:
            let u = clamp01(time / checkMs)
            if request.reduceMotion {
                fills("sweep", sweepAlpha, opacity: clamp01(min(u / 0.3, (1 - u) / 0.3)))
                return plan(checkMs, loop: false)
            }
            if time >= checkMs { return plan(checkMs, loop: false) }
            var length = 0.0
            for l in lines { length += l.width }
            let band = sweepWidth * length
            if band <= 0 { return plan(checkMs, loop: false) }
            let start = u * u * (3 - 2 * u) * (length + band) - band
            var offset = 0.0
            for l in lines {
                let from = max(start, offset)
                let to = min(start + band, offset + l.width)
                if to - from > 0.01 {
                    let x0 = l.x + start - offset
                    let midY = l.y + l.height / 2
                    let gradient = TextTreatmentGradient(x0: x0, y0: midY, x1: x0 + band, y1: midY, stops: [
                        .init(offset: 0, color: color.with(alpha: 0)),
                        .init(offset: 0.5, color: color.with(alpha: sweepAlpha)),
                        .init(offset: 1, color: color.with(alpha: 0)),
                    ])
                    layers.append(TextTreatmentLayer(kind: .rect, source: "sweep", z: .behind, x: l.x + from - offset, y: l.y, width: to - from, height: l.height,
                                                     color: color.with(alpha: sweepAlpha), gradient: gradient))
                }
                offset += l.width
            }
            return plan(checkMs, loop: false)
        }
    }
}

// MARK: - Agents' carets

/// How a host draws agents' carets with text treatments: the provider (nil for the built-in look),
/// the treatment for agents that don't choose one, and whether to draw without motion.
public struct AgentTextTreatments {
    public var provider: TextTreatmentProvider?
    /// Default the provider's `defaultTextTreatment`.
    public var treatment: String?
    public var reduceMotion: Bool

    public init(provider: TextTreatmentProvider? = nil, treatment: String? = nil, reduceMotion: Bool = false) {
        self.provider = provider
        self.treatment = treatment
        self.reduceMotion = reduceMotion
    }

    /// The plans to draw for `carets` at `now` (the store's clock, ms), back to front: each
    /// caret's landed tint, then its stage. `lines` gives a range's line rectangles and `caretAt`
    /// an insertion point, in the overlay's coordinates. A treatment that fails is drawn with the
    /// built-in one instead.
    public func plans(for carets: [AgentCaret], at now: Double, lines: (NSRange) -> [TextTreatmentRect], caretAt: (Int) -> TextTreatmentCaret?) -> [TextTreatmentPlan] {
        var out: [TextTreatmentPlan] = []
        for caret in carets {
            let id = caret.treatment ?? treatment
            let hex = TextTreatmentRGBA(hex: caret.color) != nil ? caret.color : BuiltInTextTreatment.color
            let values: JSONObject = ["color": .string(hex)]
            func frame(_ stage: TextTreatmentStage, _ time: Double, _ target: TextTreatmentTarget) {
                let planAt = { (t: Double) -> TextTreatmentPlan in
                    let request = TextTreatmentPlanRequest(stage: stage, time: max(0, t), target: target, reduceMotion: reduceMotion)
                    if let plan = try? planTextTreatment(provider, request, id: id, values: values) { return plan }
                    return (try? BuiltInTextTreatment.plan(request, color: hex))
                        ?? TextTreatmentPlan(stage: stage, time: t, duration: 0, done: true, reduced: reduceMotion, layers: [])
                }
                if let plan = textTreatmentFrame(stage, at: time, planAt: planAt) { out.append(plan) }
            }
            if !caret.changed.isEmpty, let since = caret.changedSince {
                frame(.landed, now - since, TextTreatmentTarget(lines: caret.changed.flatMap(lines)))
            }
            let time = now - caret.stageSince
            let head = caretAt(caret.head)
            switch caret.stage {
            case .selecting:
                frame(.selecting, time, TextTreatmentTarget(lines: lines(caret.selection), caret: head, label: caret.name))
            case .typing:
                frame(.typing, time, TextTreatmentTarget(lines: caret.typed.map(lines) ?? [], caret: head, label: caret.name))
            case .checking, .caret:
                if caret.stage == .checking, let check = caret.check { frame(.checking, time, TextTreatmentTarget(lines: lines(check))) }
                frame(.caret, time, TextTreatmentTarget(caret: head, label: caret.name))
            }
        }
        return out
    }
}
