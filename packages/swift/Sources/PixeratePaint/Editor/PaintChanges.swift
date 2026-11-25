import Foundation
import PixerateCore

// The paint change feed, a port of `createPaintChangeFeed` (`paint-editor/collaboration.ts`):
// what the user (or an agent) just painted, after each controller change: strokes added or
// removed (undo included), fills and clears, layers added, removed or changed, and the start and
// end of each stroke, tagged with who made it. It diffs snapshots, so it sees every change
// however it was made. Agents that paint alongside the user read it.

/// A layer as the feed reports it.
public struct PaintChangeLayer: Equatable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// A layer whose name, visibility, opacity or blend changed, with the fields (in that order).
public struct PaintChangedLayer: Equatable, Sendable {
    public var id: String
    public var name: String
    public var fields: [String]
    public init(id: String, name: String, fields: [String]) {
        self.id = id
        self.name = name
        self.fields = fields
    }
}

/// What changed in the painting since the feed's last report (`PaintChange`).
public struct PaintChange {
    /// Counts up from 1 for each change reported.
    public var seq: Int
    /// `user`, or `agent:<id>` when an agent's step made it (see `PaintEditorController.withOrigin`).
    public var origin: String
    /// The history step behind it, when there was one.
    public var commit: PaintCommitEvent?
    public var addedStrokes: [RecordedStroke]
    public var removedStrokes: [RecordedStroke]
    /// Fills, clears and other recorded operations that aren't strokes.
    public var events: [PaintEvent]
    public var addedLayers: [PaintChangeLayer]
    public var removedLayers: [PaintChangeLayer]
    /// Layers whose name, visibility, opacity or blend changed, with the fields.
    public var changedLayers: [PaintChangedLayer]
    /// A stroke is being painted: more of the same gesture will follow.
    public var inGesture: Bool
    /// A stroke started since the last report (reported even when nothing else changed).
    public var gestureStarted: Bool
    /// The stroke in progress ended (reported even when it painted nothing).
    public var gestureEnded: Bool
    /// Milliseconds since the epoch (the feed's `now`).
    public var at: Double
}

private struct PaintLayerFields: Equatable {
    var name: String
    var visible: Bool
    var opacity: Double
    var blend: String

    /// The fields that differ from `other`, in `LAYER_FIELDS` order.
    func changed(from other: PaintLayerFields) -> [String] {
        var out: [String] = []
        if name != other.name { out.append("name") }
        if visible != other.visible { out.append("visible") }
        if opacity != other.opacity { out.append("opacity") }
        if blend != other.blend { out.append("blend") }
        return out
    }
}

private struct PaintSnapshot {
    var doc: PaintDocumentState
    /// Strokes in document order, and their ids.
    var strokes: [RecordedStroke]
    var strokeIds: Set<String>
    var events: Int
    /// Layers top first (`listLayers`), and their fields by id.
    var layerOrder: [String]
    var layers: [String: PaintLayerFields]
    var stroking: Bool
}

/**
 * A change feed for a paint editor (`createPaintChangeFeed`). It checks after every controller
 * change (`subscribe`) and takes each change's origin from the history step behind it (`onCommit`).
 */
public final class PaintChangeFeed {
    private let controller: PaintEditorController
    private let now: () -> Double
    private var listeners: [(id: UUID, fn: (PaintChange) -> Void)] = []
    private var seq = 0
    private var pending: PaintCommitEvent?
    private var last: PaintSnapshot
    private var offCommit: Cancellable?
    private var offState: Cancellable?

    /// `now` gives each change's `at` in milliseconds (default the clock).
    public init(_ controller: PaintEditorController, now: (() -> Double)? = nil) {
        self.controller = controller
        self.now = now ?? { Date().timeIntervalSince1970 * 1000 }
        last = Self.take(controller)
        offCommit = controller.onCommit { [weak self] in self?.pending = $0 }
        offState = controller.subscribe { [weak self] in self?.check() }
    }

    private static func take(_ c: PaintEditorController) -> PaintSnapshot {
        let doc = c.doc
        var layerOrder: [String] = []
        var layers: [String: PaintLayerFields] = [:]
        for l in c.listLayers() {
            layerOrder.append(l.id)
            layers[l.id] = PaintLayerFields(name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend)
        }
        return PaintSnapshot(doc: doc, strokes: doc.strokes, strokeIds: Set(doc.strokes.map(\.id)), events: doc.paintEvents?.count ?? 0, layerOrder: layerOrder, layers: layers, stroking: c.stroking)
    }

    /// Compares the painting with the last snapshot and reports the change, if any. Runs on every controller change.
    @discardableResult
    public func check() -> PaintChange? {
        if controller.doc === last.doc && controller.stroking == last.stroking { return nil }
        let next = Self.take(controller)
        let addedStrokes = next.strokes.filter { !last.strokeIds.contains($0.id) }
        let removedStrokes = last.strokes.filter { !next.strokeIds.contains($0.id) }
        let allEvents = next.doc.paintEvents ?? []
        let events = next.events > last.events ? Array(allEvents[last.events...]) : []
        var addedLayers: [PaintChangeLayer] = []
        var changedLayers: [PaintChangedLayer] = []
        for id in next.layerOrder {
            let l = next.layers[id]!
            if let before = last.layers[id] {
                let fields = l.changed(from: before)
                if !fields.isEmpty { changedLayers.append(PaintChangedLayer(id: id, name: l.name, fields: fields)) }
            } else {
                addedLayers.append(PaintChangeLayer(id: id, name: l.name))
            }
        }
        let removedLayers = last.layerOrder.filter { next.layers[$0] == nil }.map { PaintChangeLayer(id: $0, name: last.layers[$0]!.name) }
        let gestureStarted = next.stroking && !last.stroking
        let gestureEnded = !next.stroking && last.stroking
        last = next
        let edited = addedStrokes.count + removedStrokes.count + events.count + addedLayers.count + removedLayers.count + changedLayers.count > 0
        if !edited && !gestureStarted && !gestureEnded { return nil }
        let commit = edited ? pending : nil
        if edited { pending = nil }
        seq += 1
        let change = PaintChange(
            seq: seq, origin: commit?.origin ?? "user", commit: commit,
            addedStrokes: addedStrokes, removedStrokes: removedStrokes, events: events,
            addedLayers: addedLayers, removedLayers: removedLayers, changedLayers: changedLayers,
            inGesture: next.stroking, gestureStarted: gestureStarted, gestureEnded: gestureEnded, at: now()
        )
        for l in listeners { l.fn(change) }
        return change
    }

    /// Calls `listener` with each change reported. Returns the handle that stops it.
    public func subscribe(_ listener: @escaping (PaintChange) -> Void) -> Cancellable {
        let id = UUID()
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    /// Takes a new snapshot without reporting the difference (e.g. after opening a document).
    public func reset() {
        last = Self.take(controller)
        pending = nil
    }

    /// Stops listening to the controller and drops every listener.
    public func dispose() {
        offCommit?.cancel()
        offState?.cancel()
        offCommit = nil
        offState = nil
        listeners = []
    }
}
