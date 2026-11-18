import AppKit
import PixerateChartUI
import SwiftUI
import XCTest

@MainActor
final class PreviewSnapshotTests: XCTestCase {
    func testRenderSwiftUIPreviews() throws {
        let exportDir = ProcessInfo.processInfo.environment["EDITOR_PREVIEW_EXPORT_DIR"]
            .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }

        if let exportDir {
            try FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)
        }

        let model = try ChartEditorModel(width: 640, height: 400)

        let cases: [(name: String, appearance: NSAppearance.Name)] = [
            ("ChartView-QuarterlyRevenue-Light", .aqua),
            ("ChartView-QuarterlyRevenue-Dark", .darkAqua),
        ]

        for entry in cases {
            let png = try renderToPNG(
                view: ChartView(model: model, interactive: false)
                    .frame(width: 640, height: 400)
                    .padding(16),
                appearanceName: entry.appearance,
                size: CGSize(width: 672, height: 432)
            )
            XCTAssertGreaterThan(png.count, 0, "Empty PNG for \(entry.name)")

            if let exportDir {
                try png.write(to: exportDir.appendingPathComponent("\(entry.name).png"), options: .atomic)
            }
        }
    }

    private func renderToPNG<V: View>(
        view: V,
        appearanceName: NSAppearance.Name,
        size: CGSize
    ) throws -> Data {
        let appearance = NSAppearance(named: appearanceName)
        let hostingView = NSHostingView(rootView: view.background(.windowBackground))
        hostingView.appearance = appearance

        let bounds = NSRect(origin: .zero, size: size)
        hostingView.frame = bounds

        let window = NSWindow(
            contentRect: bounds,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.contentView = hostingView
        hostingView.layoutSubtreeIfNeeded()

        guard let rep = hostingView.bitmapImageRepForCachingDisplay(in: bounds) else {
            throw NSError(domain: "PreviewSnapshotTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate bitmap rep"])
        }
        hostingView.cacheDisplay(in: bounds, to: rep)

        guard let data = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "PreviewSnapshotTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG"])
        }
        window.orderOut(nil)
        return data
    }
}
