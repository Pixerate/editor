import Foundation
import PixerateCore

/// Wraps a `ChartSpec` in a `pixerate.editor-document` envelope of kind `chart`.
public func chartEditorDocumentFile(_ spec: ChartSpec, name: String? = nil) -> EditorDocumentFile {
    EditorDocumentFile(kind: "chart", formatVersion: 1, name: name, document: spec.toJSON())
}

/// Unwraps and normalizes a `ChartSpec` from a raw spec or a `pixerate.editor-document` envelope of kind `chart`.
public func loadChartEditorDocument(
    _ input: JSONValue,
    strict: Bool = false
) throws -> (spec: ChartSpec, report: LoadReport) {
    var report = LoadReport(version: 1)
    let rawSpec: JSONValue
    if let file = EditorDocumentFile(input) {
        if file.kind != "chart" {
            throw EditorDocumentLoadError("This is a \(file.kind) document; it cannot be opened in the chart editor.")
        }
        let (migrated, migReport) = migrateDocument(
            .value(["formatVersion": .number(Double(file.formatVersion)), "document": file.document]),
            MigrateOptions(currentVersion: 1, steps: [:], versionKey: "formatVersion")
        )
        report = migReport
        if let readOnly = report.readOnly {
            throw EditorDocumentLoadError("Cannot open the chart document: \(readOnly.message).", report: report)
        }
        rawSpec = migrated["document"] ?? .null
    } else {
        rawSpec = input
    }
    if rawSpec == .null {
        throw EditorDocumentLoadError("No chart document was given.")
    }
    let normalized = normalizeChartSpec(rawSpec)
    if strict && !normalized.issues.isEmpty {
        let msgs = normalized.issues.map { $0.path.isEmpty ? $0.message : "\($0.path): \($0.message)" }.joined(separator: " ")
        throw EditorDocumentLoadError(msgs)
    }
    report.problems += normalized.issues.map { SectionProblem(section: $0.path.isEmpty ? "chart" : $0.path, message: $0.message) }
    return (spec: normalized.spec, report: report)
}
