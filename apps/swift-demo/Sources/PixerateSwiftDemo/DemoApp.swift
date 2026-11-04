import PixerateCore
import PixeratePaint
import PixeratePaintUI
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/**
 * The Swift demo: a Paint tab with `PaintEditorView` and an agent panel listing the editor's
 * tools, with a switch that connects them to `pixerate-mcp-bridge` (`ToolBridgeClient`), so an MCP
 * client can paint in this window.
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

struct DemoRoot: View {
    @State private var model: PaintEditorModel? = {
        do {
            let m = try PaintEditorModel()
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

    var body: some View {
        if let model {
            TabView {
                HStack(spacing: 0) {
                    PaintEditorView(model: model)
                    Divider()
                    AgentPanel(registry: model.registry)
                        .frame(width: 280)
                }
                .tabItem { Label("Paint", systemImage: "paintbrush") }
            }
        } else {
            Text("The paint editor could not start.").padding()
        }
    }
}
