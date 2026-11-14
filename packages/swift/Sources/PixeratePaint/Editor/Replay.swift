import Foundation
import PixerateCore
import PixerateRaster
import PixerateGeometry

/**
 * Repeating a painting's log one item at a time (`replayItems`, `replayItem`, `advanceReplayClock`,
 * `replayStrokeInit` and `finishReplayStroke` in `paint-editor/replay.ts`): what the time-lapse, the
 * high-resolution export and the colour scheme's replay (`SchemeReplay.swift`) repaint with.
 */

/// One thing a replay repeats: a recorded stroke, a paint event or a wet event (`ReplayItem`).
enum ReplayItem {
    case stroke(RecordedStroke)
    case paint(PaintEvent)
    case wet(WetEvent)

    /// Which object of the log this is (the TS core compares the objects themselves).
    var key: Int {
        switch self {
        case .stroke(let st): return st.key
        case .paint(let e): return e.key
        case .wet(let e): return e.key
        }
    }
}

/// Strokes and events in the order they happened, with where each sorts (`replayItems`).
func replayItemsAt(_ doc: PaintDocumentState) -> [(item: ReplayItem, at: Double)] {
    var items: [(item: ReplayItem, at: Double, order: Int)] = []
    var order = 0
    for (i, st) in doc.strokes.enumerated() {
        items.append((.stroke(st), Double(i) + 0.5, order))
        order += 1
    }
    for e in doc.paintEvents ?? [] {
        items.append((.paint(e), Double(e.at), order))
        order += 1
    }
    for e in doc.wetEvents ?? [] {
        items.append((.wet(e), e.replayAt, order))
        order += 1
    }
    // `a.at - b.at || a.order - b.order`: a NaN difference falls back to the order, as 0 does.
    let sorted = jsSorted(items) { (a: (item: ReplayItem, at: Double, order: Int), b: (item: ReplayItem, at: Double, order: Int)) -> Double in
        let d: Double = a.at - b.at
        if d.isNaN || d == 0 { return Double(a.order - b.order) }
        return d
    }
    return sorted.map { (item: $0.item, at: $0.at) }
}

/// Strokes and events in the order they happened (`replayItems`).
func replayItems(_ doc: PaintDocumentState) -> [ReplayItem] {
    replayItemsAt(doc).map(\.item)
}

/// The clocks a replay item happens at: its first and its last (nil: it doesn't depend on the clock; `itemClocks`).
func itemClocks(_ item: ReplayItem) -> (first: Int, last: Int)? {
    switch item {
    case .wet(let e): return (e.clock, e.clock)
    case .stroke(let st):
        guard st.brush.engine == "wet", let steps = st.steps, let first = steps.first, let last = steps.last else { return nil }
        return (first, st.endStep ?? last)
    case .paint: return nil
    }
}

/// The latest wet clock a document's log records (its strokes' points and pen-ups, its wet events); 0 for none (`loggedWetClock`).
func loggedWetClock(strokes: [RecordedStroke], wetEvents: [WetEvent]?) -> Int {
    var most = 0
    for st in strokes where st.brush.engine == "wet" {
        if let last = st.steps?.last { most = Swift.max(most, st.endStep ?? last) }
    }
    for e in wetEvents ?? [] { most = Swift.max(most, e.clock) }
    return most
}

/// Whether a document's log has anything a wet clock is recorded for (`hasWetLog`).
func hasWetLog(_ doc: PaintDocumentState) -> Bool {
    if !(doc.wetEvents ?? []).isEmpty { return true }
    return doc.strokes.contains { $0.brush.engine == "wet" && !($0.steps ?? []).isEmpty }
}

/// The largest wet clock (steps) a document's log is taken at its word for (`MAX_WET_CLOCK`).
let MAX_WET_CLOCK = 2_147_483_647

/// Whether every clock a document's log records is a whole number of steps in 0...`MAX_WET_CLOCK` (`wetClocksInRange`).
private func wetClocksInRange(_ doc: PaintDocumentState) -> Bool {
    let ok: (Int) -> Bool = { v in v >= 0 && v <= MAX_WET_CLOCK }
    for st in doc.strokes where st.brush.engine == "wet" {
        guard let steps = st.steps else { continue }
        if !steps.allSatisfy(ok) { return false }
        if let end = st.endStep, !ok(end) { return false }
    }
    return (doc.wetEvents ?? []).allSatisfy { ok($0.clock) }
}

/// Whether `e` dries every layer at once, everywhere: no layer, no rectangle (`isDryAll`; a saved `layerId` or `data` that is there and not empty or null counts).
func isDryAll(_ e: WetEvent) -> Bool {
    if e.kind != "dry" { return false }
    if let raw = e.saved?["layerId"] { if raw != .string("") { return false } } else if let id = e.layerId, !id.isEmpty { return false }
    if let d = e.data, d != .null { return false }
    return true
}

/// A document's log as it is opened (`openedWetLog`).
struct OpenedWetLog {
    var strokes: [RecordedStroke]
    var wetEvents: [WetEvent]
    /// The clock the document's simulation goes on from.
    var clock: Int
    /// The dry added at the end (nil when the log already ended with one).
    var dry: WetEvent?
}

/**
 * The log of a document as it is opened, so a replay sees what happened (`openedWetLog`, #720): a
 * `dry` of every layer at the clock the save dried the paint (the saved wet clock, else the log's
 * latest) ends it, and the sessions of an older document, whose clocks start again at 0, are put in
 * order: each place the clocks go back gets a `dry` of everything at the latest clock before it, and
 * its clocks go on from the next multiple of `FREE_INTERVAL`. Nil when there is no wet log or a clock
 * is past `MAX_WET_CLOCK`.
 */
func openedWetLog(_ doc: PaintDocumentState, clock savedClock: Int?) -> OpenedWetLog? {
    if !hasWetLog(doc) || !wetClocksInRange(doc) { return nil }
    // Walk the log in replay order: a clock earlier than one before it starts a new session.
    var session: [Int: (index: Int, offset: Int)] = [:]
    var breaks: [(clock: Int, at: Double)] = []
    var offset = 0
    var latest = 0
    for (item, at) in replayItemsAt(doc) {
        guard let c = itemClocks(item) else { continue }
        if c.first + offset < latest {
            var breakAt = at
            if case .stroke(let st) = item { breakAt = Double(doc.strokes.firstIndex { $0.key == st.key } ?? 0) }
            breaks.append((clock: latest, at: breakAt))
            // The session's 0 goes on the next multiple of FREE_INTERVAL: the simulation frees tiles on those, so it steps as it did.
            offset = (latest + FREE_INTERVAL - 1) / FREE_INTERVAL * FREE_INTERVAL
        }
        session[item.key] = (index: breaks.count, offset: offset)
        latest = Swift.max(latest, c.last + offset)
    }
    var strokes = doc.strokes
    var wetEvents = doc.wetEvents ?? []
    if !breaks.isEmpty {
        strokes = strokes.map { st -> RecordedStroke in
            let d = session[st.key]?.offset ?? 0
            guard d != 0, let steps = st.steps else { return st }
            var out = st
            out.key = newStrokeKey()
            out.steps = steps.map { $0 + d }
            if let end = st.endStep { out.endStep = end + d }
            return out
        }
        // Break b goes in before the first wet event after it (a later `at`, or the same `at` in a later session).
        var next: [WetEvent] = []
        var b = 0
        for e in wetEvents {
            let s = session[e.key]
            let at = e.replayAt
            while b < breaks.count {
                let later: Bool = at > breaks[b].at
                let sameLater: Bool = at == breaks[b].at && (s.map { $0.index > b } ?? false)
                if !(later || sameLater) { break }
                next.append(WetEvent(clock: breaks[b].clock, at: Int(breaks[b].at), kind: "dry"))
                b += 1
            }
            if let s, s.offset != 0 {
                var moved = e
                moved.key = newStrokeKey()
                moved.clock = e.clock + s.offset
                next.append(moved)
            } else {
                next.append(e)
            }
        }
        while b < breaks.count {
            next.append(WetEvent(clock: breaks[b].clock, at: Int(breaks[b].at), kind: "dry"))
            b += 1
        }
        wetEvents = next
    }
    let end = Swift.max(latest, savedClock ?? 0)
    if let last = wetEvents.last, isDryAll(last), last.clock == end, last.replayAt >= Double(strokes.count) {
        return OpenedWetLog(strokes: strokes, wetEvents: wetEvents, clock: end, dry: nil)
    }
    let dry = WetEvent(clock: end, at: strokes.count, kind: "dry")
    return OpenedWetLog(strokes: strokes, wetEvents: wetEvents + [dry], clock: end, dry: dry)
}

/// How a replay paints: at what scale, and where it lets the host in while wet paint flows (`ReplayItemOptions`).
struct ReplayItemOptions {
    /// Paint at this many times the size (default 1).
    var scale: Double = 1
    /// Step the simulation at most this many steps at a time (default: all at once).
    var wetChunk: Int?
    /// Called after each chunk of wet steps (with `wetChunk`).
    var onWetSteps: (() async throws -> Void)?
    /// A wet stroke takes at most this many points at a time (default: all those applied at one clock).
    var pointChunk: Int?
    /// Called between two chunks of a wet stroke's points (with `pointChunk`).
    var onPoints: (() async -> Void)?
}

/**
 * Steps `target`'s wet simulation up to `clock` (in chunks of `wetChunk`); without a simulation
 * yet, its clock is set there. Returns how far the clock moved.
 *
 * The TS core's chunk is `Math.max(1, wetChunk ?? 0) || Infinity`, which is never `Infinity`: without
 * a `wetChunk` it steps one step per call (and calls `onWetSteps` after each). The steps and pixels
 * are the same either way, so this port steps all at once then, as the expression means to (GOTCHAS).
 */
@discardableResult
func advanceReplayClock(_ target: PaintEditorController, _ clock: Int, _ options: ReplayItemOptions = ReplayItemOptions()) async throws -> Int {
    let chunk = options.wetChunk.map { Swift.max(1, $0) } ?? Int.max
    let start = target.wet.clock
    var left = clock - start
    while left > 0 {
        let n = Swift.min(left, chunk)
        let ran = Int(try target.advanceWet(steps: n, seconds: nil)["steps"]?.numberValue ?? 0)
        if chunk != Int.max { try await options.onWetSteps?() }
        if ran <= 0 {
            // No simulation yet: nothing flows, but the clock goes on (a world made later starts there, as it did).
            target.wet.setClock(clock)
            break
        }
        left -= ran
    }
    return (target.wet.clock) - start
}

/// What a recorded stroke replays with (`beginStroke` / `paintStroke` options without the points), at `scale` (`replayStrokeInit`).
func replayStrokeInit(_ st: RecordedStroke, scale s: Double = 1) -> PaintStrokeInit {
    var i = PaintStrokeInit(layerId: st.layerId, color: st.color, seed: st.seed, copies: st.copies ?? [], load: st.load)
    i.fixedBrush = st.brush
    i.paint = st.effect?.json ?? st.paint?.json
    i.targets = st.targets
    i.snapToPerspective = false
    i.stencils = false
    i.maskStencils = (st.stencils ?? []).map { s == 1 ? $0 : scaleStencil($0, s) }
    i.scrapeLayerIds = st.scrapeLayerIds
    return i
}

/// Ends a replayed wet stroke (`finishReplayStroke`; the Swift simulation applies all of it at once).
func finishReplayStroke(_ target: PaintEditorController, _ session: PaintLiveStroke) throws {
    _ = try session.end()
}

/**
 * Repeats one recorded stroke or event (`replayItems`) on `target` (`replayItem`): strokes paint
 * exactly as recorded (wet ones point by point, each at its clock), events change what they
 * changed. A stroke's effect paint must already be prepared (`prepareEffectPaints`), except a
 * path-mapped one, which is prepared here.
 */
func replayItem(_ target: PaintEditorController, _ item: ReplayItem, _ options: ReplayItemOptions = ReplayItemOptions()) async throws {
    let s = options.scale
    let m: Affine = [s, 0, 0, s, 0, 0]
    func sr(_ r: JSONValue?) -> JSONValue? {
        guard let o = r?.objectValue else { return nil }
        var out = o
        for k in ["x", "y", "width", "height"] { if let v = o[k]?.numberValue { out[k] = .number(v * s) } }
        return .object(out)
    }
    switch item {
    case .paint(let e):
        let d = e.data ?? [:]
        if e.kind == "magnets" {
            let list = magnetsFromJSON(.array(d["magnets"]?.arrayValue ?? [])).map { m -> PaintMagnet in
                if s == 1 { return m }
                return PaintMagnet(id: m.id, x: m.x * s, y: m.y * s, strength: m.strength, radius: Swift.min(2000, Swift.max(8, m.radius * s)))
            }
            try target.replaceMagnets(list, advect: d["advect"] == .bool(true))
            return
        }
        if target.getLayer(e.layerId) == nil { return }
        switch e.kind {
        case "fill":
            _ = try target.fillLayer(layerId: e.layerId, color: d["color"]?.stringValue, opacity: d["opacity"]?.numberValue, grain: d["grain"]?.numberValue, pressure: d["pressure"]?.numberValue, blend: d["blend"]?.stringValue)
        case "fill-region":
            var pts: [FillRegionPoint] = []
            if let arr = d["points"]?.arrayValue {
                for p in arr {
                    if let po = p.objectValue, let px = po["x"]?.numberValue, let py = po["y"]?.numberValue {
                        pts.append(FillRegionPoint(x: px * s, y: py * s))
                    }
                }
            } else if let px = d["x"]?.numberValue, let py = d["y"]?.numberValue {
                pts.append(FillRegionPoint(x: px * s, y: py * s))
            }
            let cg = d["closeGap"]?.numberValue.map { Swift.min(32, $0 * s) }
            let exp = d["expand"]?.numberValue.map { Swift.max(-16, Swift.min(16, $0 * s)) }
            _ = try target.fillRegion(
                points: pts,
                layerId: e.layerId,
                reference: d["reference"]?.stringValue,
                color: d["color"]?.stringValue,
                opacity: d["opacity"]?.numberValue,
                blend: d["blend"]?.stringValue,
                tolerance: d["tolerance"]?.numberValue,
                closeGap: cg,
                expand: exp,
                antialias: d["antialias"]?.boolValue,
                grain: d["grain"]?.numberValue,
                pressure: d["pressure"]?.numberValue,
                wet: d["wet"]?.boolValue
            )
        case "clear":
            _ = try target.clearLayer(e.layerId)
        case "live-strokes":
            if d["rasterized"] == .bool(true) { try target.replaceLiveStrokes(e.layerId, nil) } else {
                let list = (e.strokes ?? []).map { st -> RecordedStroke in
                    if s == 1 { return st }
                    var v = varyStroke(st, m)
                    if let sts = st.stencils { v.stencils = sts.map { scaleStencil($0, s) } }
                    return v
                }
                try await target.prepareEffectPaints(list.compactMap(\.effect))
                try target.replaceLiveStrokes(e.layerId, list)
            }
        case "stickers":
            let list = (d["stickers"]?.arrayValue ?? []).compactMap(Sticker.init(json:)).map { x -> Sticker in
                if s == 1 { return x }
                var y = x
                y.x *= s; y.y *= s; y.size *= s
                return y
            }
            try target.replaceStickers(e.layerId, list)
        case "flatten":
            _ = try target.flattenRelief(e.layerId)
        case "cure-ferrofluid":
            _ = try target.cureFerrofluid(e.layerId)
        case "culture-grow":
            try target.applyCultureGrowEvent(e.layerId, d, scale: s)
        default:
            return
        }
    case .wet(let e):
        try await advanceReplayClock(target, e.clock, options)
        // An event that no longer applies (its layer went away) is skipped.
        switch e.kind {
        case "dry":
            let ids = e.layerId?.split(separator: ",").map(String.init).filter { !$0.isEmpty } ?? []
            if !ids.isEmpty { for id in ids { _ = try? target.dryPaint(layerId: id, rect: sr(e.data)) } } else { _ = try? target.dryPaint(rect: sr(e.data)) }
        case "tilt":
            let d = e.data?.objectValue ?? [:]
            _ = try? target.setCanvasTilt(angle: d["angle"]?.numberValue, direction: d["direction"]?.numberValue)
        case "params":
            if let id = e.layerId, target.getLayer(id) != nil { _ = try? target.setWetParams(id, e.data?.objectValue ?? [:]) }
        case "flow":
            var f = e.data?.objectValue ?? [:]
            if let c = f["center"]?.objectValue, let x = c["x"]?.numberValue, let y = c["y"]?.numberValue { f["center"] = pointJSON(x * s, y * s) }
            if let sc = f["scale"]?.numberValue, sc != 0 { f["scale"] = .number(Swift.min(1024, sc * s)) }
            if let id = e.layerId, target.getLayer(id) != nil { _ = try? target.setFlowMap(id, f) }
        case "wet-paper":
            let d = e.data?.objectValue ?? [:]
            if let id = e.layerId, target.getLayer(id) != nil { _ = try? target.wetPaper(layerId: id, rect: sr(d["rect"]), amount: d["amount"]?.numberValue) }
        case "live-patterns":
            if let id = e.layerId, target.getLayer(id) != nil {
                if var d = e.data?.objectValue {
                    if let sc = d["scale"]?.numberValue { d["scale"] = .number(Swift.min(4, sc * s)) }
                    d["enabled"] = .bool(true)
                    _ = try? target.setLivePatterns(id, d)
                } else {
                    _ = try? target.setLivePatterns(id, ["enabled": .bool(false)])
                }
            }
        case "seed-live-patterns":
            let d = e.data?.objectValue ?? [:]
            if let id = e.layerId, target.getLayer(id) != nil, let pts = d["points"]?.arrayValue {
                let scaledPts: [JSONValue] = pts.compactMap { item in
                    guard var o = item.objectValue, let x = o["x"]?.numberValue, let y = o["y"]?.numberValue else { return nil }
                    o["x"] = .number(x * s)
                    o["y"] = .number(y * s)
                    return .object(o)
                }
                var args: JSONObject = [
                    "layerId": .string(id),
                    "points": .array(scaledPts),
                    "radius": .number(Swift.min(512, (d["radius"]?.numberValue ?? 16) * s)),
                ]
                if let seed = d["seed"] { args["seed"] = seed }
                if let st = d["settings"]?.objectValue {
                    for (k, v) in st { args[k] = v }
                    if let sc = st["scale"]?.numberValue { args["scale"] = .number(Swift.min(4, sc * s)) }
                }
                _ = try? target.seedLivePatterns(args)
            }
        case "ghost-release":
            let d = e.data?.objectValue ?? [:]
            if let id = e.layerId, target.getLayer(id) != nil { target.wet.releaseGhost(id, linger: d["linger"]?.numberValue) }
        case "ghost-keep":
            if let id = e.layerId, target.getLayer(id) != nil { target.wet.keepGhost(id) }
        default:
            break
        }
    case .stroke(let recorded):
        let st = s == 1 ? recorded : varyStroke(recorded, m)
        if target.getLayer(st.layerId) == nil { return }
        if let e = st.effect, e.map?.by == "path" { try await target.prepareEffectPaints([e]) }
        var i = replayStrokeInit(st, scale: s)
        if st.brush.engine == "wet", let steps = st.steps, steps.count == st.points.count, !steps.isEmpty {
            // Each point at the clock it was recorded at, the simulation stepped in between.
            try await advanceReplayClock(target, steps[0], options)
            i.start = Point2(x: st.points[0].x, y: st.points[0].y)
            let session = try target.beginStroke(i)
            // Points applied at the same clock go in together (the same dabs as one by one, without a display update each).
            let n = st.points.count
            let most = options.pointChunk ?? Int.max
            var k = 0
            while k < n {
                var j = k + 1
                while j < n && steps[j] == steps[k] && j - k < most { j += 1 }
                try await advanceReplayClock(target, steps[k], options)
                session.push(Array(st.points[k..<j]))
                if options.pointChunk != nil && j < n { await options.onPoints?() }
                k = j
            }
            // The pen lifted later than the last point: the paint flowed under the open stroke until then.
            if let end = st.endStep { try await advanceReplayClock(target, end, options) }
            try finishReplayStroke(target, session)
        } else {
            _ = try target.paintStroke(i, points: st.points)
        }
    }
}
