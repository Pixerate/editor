import Foundation
import PixerateCore

/// The paint editor's undo and redo as an `EditorDocumentHistory` (`history` in `paint-editor/editorDocument.ts`).
private final class PaintDocumentHistory: EditorDocumentHistory {
    private weak var controller: PaintEditorController?
    init(_ controller: PaintEditorController) { self.controller = controller }
    func undo() -> Bool { controller?.undo() != nil }
    func redo() -> Bool { controller?.redo() != nil }
    func documentHistoryState() -> EditorDocumentHistoryState {
        guard let c = controller else { return EditorDocumentHistoryState(canUndo: false, canRedo: false) }
        return EditorDocumentHistoryState(canUndo: !c.undoStack.isEmpty, canRedo: !c.redoStack.isEmpty, undoName: c.undoLabel.flatMap { $0.isEmpty ? nil : $0 }, redoName: c.redoLabel.flatMap { $0.isEmpty ? nil : $0 })
    }
}

/**
 The save / load / undo contract for a `PaintEditorController` (`createPaintEditorDocument`): kind
 `paint`, the document is the saved painting from `toJSON()` with every image as an asset
 reference kept in `assets` (default: a registry of its own). Wet paint is saved dry. Opening a
 document clears the history (`recordsLoads` false), and the document is read-only while a stroke
 is in progress. Pass the same `assets` to reopen a document another `EditorDocument` (or
 `editorDocument(assets:)`) wrote.
 */
public func createPaintEditorDocument(_ controller: PaintEditorController, assets: EditorAssetRegistry = EditorAssetRegistry(), strokes: Bool = true) throws -> EditorDocument {
    try EditorDocument(EditorDocumentSpec(
        kind: "paint",
        recordsLoads: false,
        get: { [weak controller] in
            guard let controller else { return .null }
            return .object(controller.toJSON(strokes: strokes))
        },
        load: { [weak controller] document, _ in
            guard let controller else { return [] }
            let problems = try controller.loadJSON(document)
            return problems.map { SectionProblem(section: "painting", message: $0) }
        },
        history: PaintDocumentHistory(controller),
        readOnly: { [weak controller] in controller?.busyReason() },
        subscribe: { [weak controller] listener in
            guard let controller else { return Cancellable {} }
            var revision = controller.documentRevision
            return controller.subscribe { [weak controller] in
                guard let controller, controller.documentRevision != revision else { return }
                revision = controller.documentRevision
                listener()
            }
        },
        assets: assets
    ))
}

/**
 `get_paint_document` / `load_paint_document` over a paint editor document
 (`createDocumentToolProvider(createPaintEditorDocument(controller), { namespace: '', history: false })`):
 bare names, and no `undo_paint` / `redo_paint` of its own (the editor provider has them).
 */
public func createPaintDocumentToolProvider(_ document: EditorDocument) -> AgentToolProvider {
    createDocumentToolProvider(document, DocumentToolProviderOptions(namespace: "", skill: "pixerate-paint-editor", history: false))
}

/// `get_paint_document` / `load_paint_document` over a new paint editor document of `controller`.
public func createPaintDocumentToolProvider(_ controller: PaintEditorController, assets: EditorAssetRegistry = EditorAssetRegistry()) throws -> AgentToolProvider {
    createPaintDocumentToolProvider(try createPaintEditorDocument(controller, assets: assets))
}
