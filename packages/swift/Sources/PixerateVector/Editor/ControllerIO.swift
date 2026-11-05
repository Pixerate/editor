import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The controller's PDF and Lottie export, Lottie import, Image Trace and the bitmap-to-vector
// styles (`vector/controller.ts`): `toPdf`, `toLottie`, `importLottie`, `traceImage` and
// `stylizeImage`.

/// What Image Trace and the styles return: the action, the new group's id and its paths' ids.
public typealias VectorImageResult = (result: VectorActionResult, id: String?, ids: [String])

/// Where an image's paths go: top-left at `x, y`, `width` wide (default one unit per pixel).
public struct VectorImagePlacement: Sendable {
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var name: String?

    public init(x: Double? = nil, y: Double? = nil, width: Double? = nil, name: String? = nil) {
        self.x = x
        self.y = y
        self.width = width
        self.name = name
    }
}

/// `Number.isInteger(v) && v >= 2 && v <= 32`.
private func isPaletteSize(_ v: Double) -> Bool { v.isFinite && v.rounded(.towardZero) == v && v >= 2 && v <= 32 }

extension VectorEditorController {
    /// The document as a vector PDF (`toPdf`, see `vectorDocumentToPdf`).
    public func toPdf(_ options: VectorPdfOptions = VectorPdfOptions()) throws -> VectorPdfExport {
        try vectorDocumentToPdf(resolveVectorSymbols(storedDocument()), options)
    }

    /// The document (or the nodes `ids`) as a Lottie animation (`toLottie`).
    public func toLottie(_ options: VectorLottieExportOptions = VectorLottieExportOptions(), ids: [String]? = nil) throws -> VectorLottieExport {
        let doc = storedDocument()
        var opts = options
        if let ids {
            var part = doc
            part.nodes = ids.compactMap { getNode($0) }
            opts.nodes = resolveVectorSymbols(part).nodes
        }
        return try vectorDocumentToLottie(resolveVectorSymbols(doc), opts)
    }

    /// Adds one frame of a Lottie animation on top of the document as groups, or replaces the
    /// document with it (`replace`, taking its size). One undo step. Returns the new nodes' ids and
    /// what was approximated or left out (`importLottie`).
    public func importLottie(_ input: JSONValue, frame: Double? = nil, replace: Bool = false) throws -> (result: VectorActionResult, ids: [String], notes: [String]) {
        let parsed: VectorLottieImport
        do {
            parsed = try parseVectorLottie(input, VectorLottieImportOptions(frame: frame, idPrefix: "\(newId())-"))
        } catch let e as VectorNotPorted {
            throw e
        } catch {
            return (.failure("Not a Lottie animation this editor can read: \(error)"), [], [])
        }
        if parsed.document.nodes.isEmpty { return (.failure("The Lottie animation has nothing to draw at that frame (no visible shape layers)."), [], []) }
        let ids = parsed.document.nodes.map(\.id)
        change("Import Lottie") {
            if replace {
                doc.width = parsed.document.width
                doc.height = parsed.document.height
                doc.nodes = parsed.document.nodes
            } else {
                setDoc(doc.nodes + parsed.document.nodes)
            }
            selection = ids
            anchors = []
            editingId = nil
        }
        return (.success, ids, parsed.notes)
    }

    /// Adds made paths as one group placed by `place`, selected (one undo step).
    private func addImageGroup(_ made: [VectorNode], _ pixels: VectorTracePixels, _ place: VectorImagePlacement, _ label: String) throws -> VectorImageResult {
        let k = (place.width ?? Double(pixels.width)) / Double(pixels.width)
        let m = VectorMatrix(k, 0, 0, k, place.x ?? 0, place.y ?? 0)
        let children = try made.map { n -> VectorNode in
            var c = try transformVectorNode(n, m)
            c.id = newId()
            return c
        }
        let id = newId()
        change(label) {
            var props = JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(place.name ?? label))])
            props["children"] = .null
            setDoc(doc.nodes + [VectorNode(props: props, children: children)])
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (.success, id, children.map(\.id))
    }

    /// Image Trace (`traceImage`): traces RGBA `pixels` into paths (`traceVectorImage`) and adds
    /// them as one group. One undo step; selects the group.
    public func traceImage(_ pixels: VectorTracePixels, _ options: VectorTraceOptions = VectorTraceOptions(), _ place: VectorImagePlacement = VectorImagePlacement()) throws -> VectorImageResult {
        func failed(_ message: String) -> VectorImageResult { (.failure(message), nil, []) }
        if let t = options.threshold, !(t >= 0 && t <= 1) { return failed("threshold must be from 0 to 1.") }
        if let c = options.colors, !isPaletteSize(c) { return failed("colors must be a whole number from 2 to 32.") }
        if let t = options.tolerance, !(t > 0) { return failed("tolerance must be above 0 (pixels).") }
        if let w = place.width, !(w > 0) { return failed("width must be above 0.") }
        if let c = options.color, parseVectorColor(c) == nil { return failed("\"\(c)\" is not a colour.") }
        let traced: [VectorNode]
        do {
            traced = try traceVectorImage(pixels, options)
        } catch let e as VectorImageError {
            return failed(e.message)
        }
        if traced.isEmpty { return failed("Nothing to trace: no shape reached the threshold (try another threshold, the alpha channel, or colour mode).") }
        return try addImageGroup(traced, pixels, place, "Image Trace")
    }

    /// Bitmap-to-vector stylise (`stylizeImage`): `pixels` as mosaic tiles, halftone dots, low-poly
    /// triangles or engraving lines (`stylizeVectorImage`), added as one group placed like Image
    /// Trace. One undo step; selects the group.
    public func stylizeImage(_ pixels: VectorTracePixels, _ style: String, _ options: VectorStylizeOptions = VectorStylizeOptions(), _ place: VectorImagePlacement = VectorImagePlacement()) throws -> VectorImageResult {
        func failed(_ message: String) -> VectorImageResult { (.failure(message), nil, []) }
        guard let label = VECTOR_STYLIZE_LABELS[style], VECTOR_STYLIZE_STYLES.contains(style) else { return failed("Unknown style \"\(style)\": use \(VECTOR_STYLIZE_STYLES.joined(separator: ", ")).") }
        if let c = options.cell, !(c >= 1) { return failed("cell must be at least 1 pixel.") }
        if let c = options.colors, !isPaletteSize(c) { return failed("colors must be a whole number from 2 to 32.") }
        if let w = place.width, !(w > 0) { return failed("width must be above 0.") }
        if let c = options.color, parseVectorColor(c) == nil { return failed("\"\(c)\" is not a colour.") }
        let made: [VectorNode]
        do {
            made = try stylizeVectorImage(pixels, style, options)
        } catch let e as VectorImageError {
            return failed(e.message)
        }
        if made.isEmpty { return failed("Nothing to draw: the picture is empty or too light for this style (try a smaller cell, or mosaic).") }
        return try addImageGroup(made, pixels, place, label)
    }
}
