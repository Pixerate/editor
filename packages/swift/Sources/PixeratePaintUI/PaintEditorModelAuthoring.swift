import Foundation
import PixerateCore
import PixeratePaint

/**
 * Writing effects in the paint editor view (#752): "New effect" from a pixel expression template,
 * "Edit" on one of the painting's authored effects, the authoring editor on the open session, and
 * "Save to painting". Each action is the controller call the matching agent tool makes
 * (`open_effect_authoring`, `save_authored_effect`, `close_effect_authoring`), so the view and an
 * agent share the one session. Offered only while the controller's `authoredPolicy` is `author`.
 */
extension PaintEditorModel {
    /// Whether this editor lets people write effects (`authoredPolicy` is `author`).
    public var canAuthorEffects: Bool { track(); return controller.authoredPolicy == .author }

    /// The templates "New effect" starts from (`pixel.blank`, `pixel.rings`, `pixel.clouds`).
    public var effectTemplates: [PixelTemplate] { PIXEL_TEMPLATES }

    /// Changes when the painting's authored effects or the open session change (what the authored effects list reloads on).
    public var authoredEffectsKey: String {
        track()
        return controller.authoredEffects.keys.joined(separator: ",") + "|" + (controller.authoringFrom ?? "")
    }

    /// What the open authoring session was opened from, or nil when none is open.
    public var authoringFrom: String? { track(); return controller.authoringFrom }

    /// The authoring editor's model on the open session (an agent's or this view's), or nil when none is open. The same model while the session stays open.
    public var authoringEditor: EffectAuthoringModel? {
        track()
        guard let session = controller.authoringSession else {
            authoringCache?.detach()
            authoringCache = nil
            return nil
        }
        if let cached = authoringCache, cached.session === session { return cached }
        authoringCache?.detach()
        let next = EffectAuthoringModel(session: session)
        authoringCache = next
        return next
    }

    /// Opens an effect for authoring and shows the editor: a template (`pixel.blank`, …) or an authored effect id. Refused (in `error`) while another is open or when the policy isn't `author`.
    public func openEffectAuthoring(_ effect: String) async {
        let opened = await runEffect { _ = try await controller.openEffectAuthoring(effect) }
        if opened { authoringPresented = true }
    }

    /// Saves the open effect into the painting (after its trial render) under a new `authored.<name>` id, and returns the id; nil with the reason in `error`. One undo step; the session stays open.
    @discardableResult
    public func saveAuthoredEffect(name: String? = nil) async -> String? {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        var id: String?
        await runEffect { id = try await controller.saveAuthoredEffect(name: trimmed?.isEmpty == false ? trimmed : nil).effect.id }
        return id
    }

    /// Closes the open session without saving and hides the editor (nothing in the painting changes).
    public func closeEffectAuthoring() {
        authoringPresented = false
        controller.closeEffectAuthoring()
    }
}
