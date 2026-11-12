import PixerateCore
import PixeratePaint
import SwiftUI

/**
 * Writing effects from the paint editor's Effects tab (#752): "New effect" from a pixel expression
 * template, the painting's authored effects with "Edit" on each, and the open session (an agent's
 * too) with a button that shows its editor. Shown only while the controller's `authoredPolicy` is
 * `author`.
 */
struct PaintAuthoringSection: View {
    let model: PaintEditorModel
    @State private var authored: [AuthoredEffectInfo] = []

    var body: some View {
        let open: EffectAuthoringModel? = model.authoringEditor
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Authored effects").font(.caption.weight(.semibold))
                Spacer()
                Menu("New effect") {
                    ForEach(model.effectTemplates, id: \.id) { t in
                        Button(t.name) { Task { await model.openEffectAuthoring(t.id) } }.help(t.description)
                    }
                }
                .fixedSize()
                .disabled(open != nil)
                .accessibilityHint("Write a new effect in pixel expressions, starting from a template")
            }
            if let open {
                HStack {
                    Text("Editing: \(open.state.name)").lineLimit(1)
                    Spacer()
                    Button("Open editor") { model.authoringPresented = true }
                }
            }
            if authored.isEmpty {
                Text("No authored effects yet. Write one with New effect, then save it to the painting.").foregroundStyle(.secondary)
            }
            ForEach(authored, id: \.id) { e in
                HStack {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(e.name).lineLimit(1)
                        if let problem = e.problem { Text(problem).foregroundStyle(.orange).lineLimit(2) }
                    }
                    Spacer()
                    Button("Edit") { Task { await model.openEffectAuthoring(e.id) } }
                        .disabled(open != nil)
                        .accessibilityLabel("Edit \(e.name)")
                }
            }
        }
        .font(.caption)
        .padding(6)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
        .task(id: model.authoredEffectsKey) { authored = await model.authoredEffects() }
    }
}

/**
 * The authoring editor over the open session, with "Save to painting" (`save_authored_effect`:
 * a trial render, then a new `authored.<name>` id), "Close without saving" and "Done" (hides the
 * editor; the session stays open).
 */
struct PaintEffectAuthoringSheet: View {
    let model: PaintEditorModel
    let editor: EffectAuthoringModel
    @State private var name = ""
    @State private var saved: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(editor.state.name).font(.headline).lineLimit(1)
                if let from = model.authoringFrom { Text("from \(from)").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Done") { model.authoringPresented = false }
            }
            ScrollView {
                EffectAuthoringEditor(model: editor).padding(.vertical, 4)
            }
            Divider()
            HStack(spacing: 8) {
                TextField("Name (default: \(editor.state.name))", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 220)
                    .onSubmit(save)
                Button("Save to painting", action: save)
                    .buttonStyle(.borderedProminent)
                    .disabled(model.effectsBusy)
                    .accessibilityHint("Trial-renders the effect and keeps it in the painting as a new authored effect")
                if model.effectsBusy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Close without saving", role: .destructive) { model.closeEffectAuthoring() }
            }
            if let saved { Text("Saved as \(saved). Use it from Paper…, Layer…, Fill… or Paint….").font(.caption).foregroundStyle(.secondary) }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(14)
        .frame(minWidth: 560, idealWidth: 760, minHeight: 520, idealHeight: 680)
    }

    private func save() {
        let requested = name
        Task {
            await editor.commitSource()
            if let id = await model.saveAuthoredEffect(name: requested) {
                saved = id
                name = ""
            }
        }
    }
}

extension View {
    /// Shows the effect authoring editor as a sheet while `model.authoringPresented` and a session is open.
    func paintEffectAuthoringSheet(_ model: PaintEditorModel) -> some View {
        sheet(isPresented: Binding(get: { model.authoringPresented && model.authoringEditor != nil }, set: { model.authoringPresented = $0 })) {
            if let editor = model.authoringEditor {
                PaintEffectAuthoringSheet(model: model, editor: editor)
            }
        }
    }
}
