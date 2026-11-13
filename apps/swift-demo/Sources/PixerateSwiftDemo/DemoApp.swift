import PixerateChart
import PixerateChartUI
import PixerateCore
import PixeratePaint
import PixeratePaintUI
import PixerateVector
import PixerateVectorUI
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/**
 * The Swift demo: Paint, Chart and Vector tabs (`PaintEditorView`, `ChartEditorView`,
 * `VectorEditorView`), each with an agent panel listing the editor's tools and a switch that
 * connects them to `pixerate-mcp-bridge` (`ToolBridgeClient`), so an MCP client can paint, chart
 * or draw in this window.
 */
@main
struct PixerateSwiftDemoApp: App {
    #if canImport(AppKit)
    @NSApplicationDelegateAdaptor(DemoAppDelegate.self) private var delegate
    #endif

    var body: some Scene {
        WindowGroup("Pixerate Swift") {
            DemoRoot()
        }
        .defaultSize(width: 1440, height: 900)
    }
}

#if canImport(AppKit)
/// `swift run` starts a bare executable, not an app bundle: make it a regular app so its window comes to the front and takes keys.
final class DemoAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // PIXERATE_DEMO_SNAPSHOT=<file.png>: after a few seconds, write the window as drawn by AppKit
        // (no Screen Recording permission needed), for checking the app renders.
        if let path = ProcessInfo.processInfo.environment["PIXERATE_DEMO_SNAPSHOT"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                guard let view = NSApp.windows.first(where: \.isVisible)?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
#endif

/// Saved documents for the demo's editors: a folder in Application Support (memory when there is none).
private func demoDocumentStore() -> EditorDocumentStore {
    let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
        .appendingPathComponent("PixerateSwiftDemo", isDirectory: true)
        .appendingPathComponent("documents", isDirectory: true)
    let storage: EditorStorage = folder.map { DirectoryEditorStorage(directory: $0) } ?? MemoryEditorStorage()
    return createEditorDocumentStore(EditorDocumentStoreOptions(storage: storage, namespace: "pixerate-demo.documents"))
}

struct DemoRoot: View {
    @State private var model: PaintEditorModel? = {
        do {
            // `author`: the Effects tab offers New effect and the effect authoring editor (#752).
            // The saved-document tools (save / list / open paintings, clean up their images) over a
            // folder in Application Support, as the TS demo's paint tab passes its IndexedDB store.
            let m = try PaintEditorModel(controller: PaintEditorController(width: 1024, height: 768, authoredEffects: .author), documentStore: demoDocumentStore())
            // A few marks so the canvas isn't empty on first launch.
            let c = m.controller
            _ = try c.setColor("#2563eb")
            _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: (0...48).map { i in PenPoint(x: 140 + Double(i) * 15, y: 380 + 150 * sin(Double(i) / 7), pressure: 0.35 + 0.6 * sin(Double(i) / 48 * Double.pi)) })
            _ = try c.setColor("#1f2937")
            return m
        } catch {
            return nil
        }
    }()

    @State private var chartModel: ChartEditorModel? = try? ChartEditorModel()

    /// The tab shown first: `PIXERATE_DEMO_TAB` (`paint`, `chart` or `vector`), for snapshots.
    @State private var tab: String = ProcessInfo.processInfo.environment["PIXERATE_DEMO_TAB"] ?? "paint"

    @State private var vectorModel: VectorEditorModel? = {
        do {
            let m = try VectorEditorModel()
            // A few shapes and a line of text so the drawing isn't empty on first launch.
            let c = m.controller
            _ = try c.addShape(VectorShapeInput(kind: "rect", x: 120, y: 140, width: 220, height: 160, cornerRadius: 18, style: ["fill": "#2563eb", "stroke": .null]))
            _ = try c.addShape(VectorShapeInput(kind: "ellipse", x: 280, y: 220, width: 200, height: 200, style: ["fill": "#f59e0b", "stroke": "#78350f", "strokeWidth": 3]))
            _ = try c.addShape(VectorShapeInput(kind: "star", x: 520, y: 150, width: 160, height: 160, style: ["fill": "#10b981", "stroke": .null]))
            _ = try c.addText(VectorTextInput(text: "Pixerate vector", x: 120, y: 500, font: ["fontFamily": "sans-serif", "fontSize": 40, "fontWeight": 700]))
            c.clearSelection()
            c.history.clear()
            return m
        } catch {
            return nil
        }
    }()

    var body: some View {
        if let model {
            TabView(selection: $tab) {
                HStack(spacing: 0) {
                    PaintEditorView(model: model)
                    Divider()
                    AgentPanel(registry: model.registry, name: "Paint — Swift demo", kind: "paint")
                        .frame(width: 280)
                }
                .tabItem { Label("Paint", systemImage: "paintbrush") }
                .tag("paint")

                if let chartModel {
                    HStack(spacing: 0) {
                        ChartEditorView(model: chartModel)
                        Divider()
                        AgentPanel(registry: chartModel.registry, name: "Chart — Swift demo", kind: "chart")
                            .frame(width: 280)
                    }
                    .tabItem { Label("Chart", systemImage: "chart.bar.xaxis") }
                    .tag("chart")
                }

                if let vectorModel {
                    HStack(spacing: 0) {
                        VectorEditorView(model: vectorModel)
                        Divider()
                        AgentPanel(registry: vectorModel.registry, name: "Vector — Swift demo", kind: "vector")
                            .frame(width: 280)
                    }
                    .tabItem { Label("Vector", systemImage: "pencil.and.outline") }
                    .tag("vector")
                }
            }
        } else {
            Text("The paint editor could not start.").padding()
        }
    }
}
