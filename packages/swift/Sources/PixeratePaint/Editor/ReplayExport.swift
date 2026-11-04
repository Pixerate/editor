import Foundation
import PixerateCore
import PixerateRaster

/**
 * Replaying a painting from its data (`paint-editor/replay.ts`): every recorded stroke and the
 * changes recorded between them (fills, clears, stroke layers), repainted into a fresh editor.
 *
 * - **Time-lapse**: frames of the painting as it is repainted, as PNGs, and a video project of the
 *   frames as stills with the ffmpeg command that renders it (the video editor's export path,
 *   `toVideoFfmpeg`, for a timeline of stills).
 * - **High-resolution export**: the same replay at a larger scale (points, brush sizes, paper grain
 *   scaled), so the picture is painted again with more pixels instead of upscaled.
 *
 * What was not recorded as data (merges, transforms of layers) is not repeated: those layers start
 * empty. Wet-media events are not ported (#545).
 */

/// The layer tree with every pixel layer empty (what a replay paints into).
func emptiedLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
    layers.map { l in
        if let children = l.children { return l.withChildren(emptiedLayers(children)) }
        return l.withSurface(emptySurface(4), offset: LayerOffset(x: 0, y: 0))
    }
}

/// A stencil `k` times the size (`scaleStencil`).
func scaleStencil(_ s: Stencil, _ k: Double) -> Stencil {
    var o = s
    func p(_ q: Point2) -> Point2 { Point2(x: q.x * k, y: q.y * k) }
    if let f = s.from { o.from = p(f) }
    if let t = s.to { o.to = p(t) }
    if let c = s.center { o.center = p(c); o.radius = s.radius! * k }
    if let r = s.rect { o.rect = GuideRect(x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k) }
    if let pts = s.points { o.points = pts.map(p) }
    o.snap = s.snap * k
    o.feather = s.feather * k
    return o
}

/// A time-lapse of a painting (`TimeLapse`).
public struct PaintTimeLapse {
    public var fps: Double
    public var width: Int
    public var height: Int
    /// Each frame as PNG bytes.
    public var frames: [[UInt8]]
    /// The frames as stills on a video timeline (assets `frame-0001.png`…).
    public var video: JSONValue
    /// The ffmpeg command that renders `video` to `timelapse.mp4` from the frame files.
    public var ffmpeg: String
    public var durationMs: Double
}

/// `String(Math.round(ms) / 1000)`.
private func sec(_ ms: Double) -> String { jsText(JS.round(ms) / 1000) }
private func even(_ v: Double) -> Int { Swift.max(2, 2 * Int(JS.round(v / 2))) }

/// Quotes an argument for a POSIX shell when it needs it (`videoShellQuote`).
func videoShellQuote(_ s: String) -> String {
    if !s.isEmpty, s.range(of: "^[A-Za-z0-9_@%+=:,./-]+$", options: .regularExpression) != nil { return s }
    return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/**
 * Frames as stills on a video timeline, `1 / fps` each, with the last held for `holdMs`
 * (`timeLapseVideo`), and the ffmpeg command `toVideoFfmpeg` writes for it.
 */
func timeLapseVideo(_ frameCount: Int, _ width: Int, _ height: Int, _ fps: Double, _ holdMs: Double, name: String = "Time-lapse") throws -> (video: JSONValue, ffmpeg: String, durationMs: Double) {
    let w = even(Double(width)), h = even(Double(height))
    let frameMs = 1000 / fps
    var assets: [JSONValue] = []
    var clips: [(id: String, asset: String, start: Double, duration: Double)] = []
    for i in 0..<frameCount {
        let id = "frame-\(String(i + 1).leftPad(4))"
        assets.append(["id": .string(id), "kind": "image", "src": .string("\(id).png"), "name": .string("\(id).png"), "width": .number(Double(width)), "height": .number(Double(height))])
        let start = JS.round(Double(i) * frameMs * 1000) / 1000
        let end = i == frameCount - 1 ? start + frameMs + holdMs : JS.round(Double(i + 1) * frameMs * 1000) / 1000
        clips.append(("clip-\(i + 1)", id, start, end - start))
    }
    let clipJSON: [JSONValue] = clips.map { ["id": .string($0.id), "type": "media", "asset": .string($0.asset), "start": .number($0.start), "duration": .number($0.duration)] }
    let video: JSONValue = [
        "version": 1, "name": .string(name), "width": .number(Double(w)), "height": .number(Double(h)), "fps": .number(fps), "background": "#000000",
        "assets": .array(assets), "tracks": [["id": "v1", "kind": "video", "clips": .array(clipJSON)]],
    ]
    let durationMs = clips.last.map { $0.start + $0.duration } ?? 0

    // toVideoFfmpeg for stills on one video track: each still contained in the frame, laid over a black base.
    let D = clips.reduce(0.0) { Swift.max($0, $1.start + $1.duration) }
    if D <= 0 { throw PaintEditorError("The project has no clips, so there is nothing to render.") }
    let f = jsText(fps)
    var inputs: [String] = []
    var graph = ["color=c=0x000000:s=\(w)x\(h):r=\(f):d=\(sec(D)),format=yuva420p[base]"]
    var cur = "base"
    for (k, clip) in clips.sorted(by: { $0.start < $1.start }).enumerated() {
        inputs += ["-loop", "1", "-framerate", f, "-t", sec(clip.duration), "-i", "\(clip.asset).png"]
        let kc = Swift.min(Double(w) / Double(width), Double(h) / Double(height))
        let rw = Double(width) * kc, rh = Double(height) * kc
        let rx = Double(w) / 2 - rw / 2, ry = Double(h) / 2 - rh / 2
        let next = "v\(k)"
        let chain = ["setpts=PTS-STARTPTS", "fps=\(f)", "scale=\(even(rw)):\(even(rh))", "format=yuva420p", "setpts=PTS+\(sec(clip.start))/TB"]
        graph.append("[\(k):v]\(chain.joined(separator: ","))[l\(next)]")
        let cx = jsText(JS.round(rx + rw / 2)), cy = jsText(JS.round(ry + rh / 2))
        graph.append("[\(cur)][l\(next)]overlay=x='\(cx)-w/2':y='\(cy)-h/2':eof_action=pass:enable='between(t,\(sec(clip.start)),\(sec(clip.start + clip.duration)))'[\(next)]")
        cur = next
    }
    graph.append("[\(cur)]format=yuv420p[vout]")
    let args = ["-y"] + inputs + ["-filter_complex", graph.joined(separator: ";"), "-map", "[vout]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", f, "-t", sec(D), "timelapse.mp4"]
    return (video, (["ffmpeg"] + args).map(videoShellQuote).joined(separator: " "), durationMs)
}

/// A contact sheet: frames side by side, each `cell` wide at most (`contactSheet`).
func contactSheet(_ frames: [(width: Int, height: Int, data: [UInt8])], columns: Int = 3, cell cellIn: Int = 200) -> (width: Int, height: Int, data: [UInt8]) {
    let n = frames.count
    let rows = Int(JS.ceil(Double(n) / Double(columns)))
    let cell = n > 0 ? Swift.min(cellIn, frames[0].width) : cellIn
    let ar = n > 0 ? Double(frames[0].height) / Double(frames[0].width) : 1
    let ch = Swift.max(1, Int(JS.round(Double(cell) * ar)))
    let W = columns * cell
    var out = [UInt8](repeating: 255, count: W * rows * ch * 4)
    for (i, f) in frames.enumerated() {
        let small = downsampleRgba(f.data, f.width, f.height, Double(cell), Double(ch))
        let ox = (i % columns) * cell, oy = (i / columns) * ch
        for y in 0..<ch { out.replaceSubrange(((oy + y) * W + ox) * 4 ..< ((oy + y) * W + ox + cell) * 4, with: small[(y * cell * 4) ..< ((y + 1) * cell * 4)]) }
    }
    return (W, rows * ch, out)
}

extension PaintEditorController {
    /// A fresh editor `scale` times the size with this painting's layers emptied, paper and lighting (`createReplayTarget`).
    func createReplayTarget(scale: Double = 1) throws -> PaintEditorController {
        if !(scale >= 1 && scale <= 8) { throw PaintEditorError("scale \(jsText(scale)) is out of range; use 1..8.") }
        let width = doc.canvas.width, height = doc.canvas.height
        let w = JS.round(Double(width) * scale), h = JS.round(Double(height) * scale)
        if w > 16384 || h > 16384 { throw PaintEditorError("At scale \(jsText(scale)) the canvas would be \(jsText(w))×\(jsText(h)); the limit is 16384 px per side. Use a smaller scale.") }
        let target = try PaintEditorController(width: w, height: h, dpi: doc.canvas.dpi * scale, brushLibrary: brushLibrary)
        target.brushEntries = brushEntries
        var paper = doc.paper
        paper.scale = Swift.min(8, paper.scale * scale)
        target.doc = PaintDocumentState(canvas: target.doc.canvas, paper: paper, layers: emptiedLayers(doc.layers), activeLayerId: doc.activeLayerId, strokes: [])
        target.lighting = lighting
        // Effect paint: the target renders what it is missing with the same provider; at scale 1 it starts from these pixels.
        target.effectsProvider = effectsProvider
        if Int(w) == width && Int(h) == height { target.effectPaintPixels = effectPaintPixels }
        return target
    }

    /// Repaints this painting into `target`, calling `onStroke` after each stroke (`replayPainting`).
    func replayPainting(into target: PaintEditorController, scale s: Double = 1, onStroke: ((Int) throws -> Void)? = nil) async throws {
        let source = doc
        // Strokes are synchronous: render their effect paint first (throws naming an effect that cannot be).
        try await target.prepareEffectPaints(source.strokes.compactMap(\.effect))
        let m: Affine = [s, 0, 0, s, 0, 0]
        enum Item { case stroke(RecordedStroke), paint(PaintEvent) }
        var items: [(item: Item, at: Double, order: Int)] = []
        var order = 0
        for (i, st) in source.strokes.enumerated() { items.append((.stroke(st), Double(i) + 0.5, order)); order += 1 }
        for e in source.paintEvents ?? [] { items.append((.paint(e), Double(e.at), order)); order += 1 }
        items.sort { $0.at != $1.at ? $0.at < $1.at : $0.order < $1.order }
        var strokes = 0
        for entry in items {
            switch entry.item {
            case .paint(let e):
                if target.getLayer(e.layerId) == nil { continue }
                let d = e.data ?? [:]
                switch e.kind {
                case "fill":
                    _ = try target.fillLayer(layerId: e.layerId, color: d["color"]?.stringValue, opacity: d["opacity"]?.numberValue, grain: d["grain"]?.numberValue, pressure: d["pressure"]?.numberValue, blend: d["blend"]?.stringValue)
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
                default:
                    continue
                }
            case .stroke(let recorded):
                let st = s == 1 ? recorded : varyStroke(recorded, m)
                strokes += 1
                if target.getLayer(st.layerId) == nil { continue }
                var i = PaintStrokeInit(layerId: st.layerId, color: st.color, seed: st.seed, copies: st.copies ?? [], load: st.load)
                i.fixedBrush = st.brush
                i.paint = st.effect?.json ?? st.paint?.json
                i.snapToPerspective = false
                i.stencils = false
                i.maskStencils = (st.stencils ?? []).map { s == 1 ? $0 : scaleStencil($0, s) }
                _ = try target.paintStroke(i, points: st.points)
                try onStroke?(strokes)
            }
        }
    }

    /**
     * Repaints the painting from its recorded strokes and events as a time-lapse: PNG frames after
     * strokes, a video project of the frames as stills and the ffmpeg command that renders it.
     * Changes nothing here.
     */
    public func timeLapse(frames framesWanted: Int? = nil, strokesPerFrame: Int? = nil, maxSide maxSideIn: Double? = nil, fps fpsIn: Double? = nil, holdMs: Double? = nil) async throws -> PaintTimeLapse {
        let target = try createReplayTarget(scale: 1)
        let maxSide = Swift.max(32, Swift.min(4096, JS.round(maxSideIn ?? 720)))
        let total = doc.strokes.count
        let perFrame = Swift.max(1, strokesPerFrame ?? Int(JS.ceil(Double(total) / Double(Swift.max(1, framesWanted ?? 120)))))
        let fps = Swift.max(1, Swift.min(60, fpsIn ?? 12))
        var frames: [[UInt8]] = []
        var width = 0, height = 0
        func shoot() {
            let f = target.renderPreview(maxSide: maxSide)
            width = f.width
            height = f.height
            frames.append(encodePng(f.width, f.height, f.data))
        }
        shoot()
        try await replayPainting(into: target) { i in if i % perFrame == 0 || i == total { shoot() } }
        let (video, ffmpeg, durationMs) = try timeLapseVideo(frames.count, width, height, fps, holdMs ?? 1500)
        return PaintTimeLapse(fps: fps, width: width, height: height, frames: frames, video: video, ffmpeg: ffmpeg, durationMs: durationMs)
    }

    /**
     * The painting repainted from its recorded strokes at `scale` times the size (brush sizes, paper
     * grain and fills scaled): more detail instead of upscaled pixels. Layers painted without
     * recorded strokes come out empty. Changes nothing here.
     */
    public func renderHighRes(scale: Double, paper: Bool? = nil) async throws -> (width: Int, height: Int, data: [UInt8]) {
        let target = try createReplayTarget(scale: scale)
        try await replayPainting(into: target, scale: scale)
        return target.compositePixels(paper: paper)
    }
}

/// `export_time_lapse` and `export_high_res`.
func paintReplayExportContentHandlers(_ c: PaintEditorController) -> [String: (JSONObject) async throws -> ToolOutput] {
    var h: [String: (JSONObject) async throws -> ToolOutput] = [:]
    h["export_time_lapse"] = { a in
        let tl = try await c.timeLapse(frames: a["frames"]?.numberValue.map { Int($0) }, maxSide: a["maxSide"]?.numberValue, fps: a["fps"]?.numberValue, holdMs: a["holdMs"]?.numberValue)
        let n = tl.frames.count
        var pick: [Int] = []
        for v in [0, n / 3, (2 * n) / 3, n - 1] where !pick.contains(v) { pick.append(v) }
        let sheet = contactSheet(try pick.map { i in
            let img = try decodePng(tl.frames[i])
            return (img.width, img.height, img.data)
        }, columns: pick.count, cell: 160)
        var info: JSONObject = [
            "frames": .number(Double(n)), "fps": .number(tl.fps), "width": .number(Double(tl.width)), "height": .number(Double(tl.height)),
            "durationMs": .number(tl.durationMs), "ffmpeg": .string(tl.ffmpeg), "video": tl.video,
        ]
        if a["includeFrames"] == .bool(true) { info["framesPng"] = .array(tl.frames.map { .string(bytesToBase64($0)) }) }
        return .result(McpToolResult(content: [.image(data: bytesToBase64(encodePng(sheet.width, sheet.height, sheet.data)), mimeType: "image/png"), .text(JSONValue.object(info).stringified())]))
    }
    return h
}

func paintReplayExportHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["export_high_res"] = { a in
        let img = try await c.renderHighRes(scale: a["scale"]?.numberValue ?? 1, paper: a["paper"]?.boolValue)
        let bytes = encodePng(img.width, img.height, img.data)
        return ["mimeType": "image/png", "width": .number(Double(img.width)), "height": .number(Double(img.height)), "bytes": .number(Double(bytes.count)), "data": .string(bytesToBase64(bytes))]
    }
    return h
}
