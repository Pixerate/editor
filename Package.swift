// swift-tools-version: 6.0
// The Swift editors (#533). The manifest is at the repository root so the package can be used as a
// git dependency; its sources live under packages/swift/.
import PackageDescription

// Async code runs on its caller's executor (as JavaScript's does), so editors, histories and tool
// registries, which are not Sendable, can be used from async tool handlers without hopping actors.
let settings: [SwiftSetting] = [.enableUpcomingFeature("NonisolatedNonsendingByDefault")]

let package = Package(
    name: "Pixerate",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "PixerateCore", targets: ["PixerateCore"]),
        .library(name: "PixerateContracts", targets: ["PixerateContracts"]),
        .library(name: "PixerateRaster", targets: ["PixerateRaster"]),
        .library(name: "PixeratePaint", targets: ["PixeratePaint"]),
        .library(name: "PixerateConformance", targets: ["PixerateConformance"]),
        .library(name: "PixeratePaintUI", targets: ["PixeratePaintUI"]),
    ],
    targets: [
        // Foundation only: no SwiftUI, AppKit or UIKit (the UI targets are the only ones that import them).
        .target(name: "PixerateCore", path: "packages/swift/Sources/PixerateCore", swiftSettings: settings),
        // The @pixerate/conformance files (contracts and recorded scenarios), bundled as they are.
        .target(
            name: "PixerateContracts",
            path: "packages/conformance",
            exclude: ["README.md", "package.json"],
            sources: ["swift"],
            resources: [.copy("domains"), .copy("schema")],
            swiftSettings: settings
        ),
        // The raster module (`raster/` in the TS core): tiled surfaces, blend modes, the layer
        // compositor, layer effects, transforms and the PNG / zlib codec. Foundation only.
        .target(name: "PixerateRaster", dependencies: ["PixerateCore"], path: "packages/swift/Sources/PixerateRaster", swiftSettings: settings),
        // The paint editor (`paint-editor`, `paint` and `brushes` in the TS core) on the raster module.
        // `Generated/` is written by scripts/gen-swift.mjs from the paint contracts.
        .target(name: "PixeratePaint", dependencies: ["PixerateCore", "PixerateContracts", "PixerateRaster", "PixerateConformance"], path: "packages/swift/Sources/PixeratePaint", swiftSettings: settings),
        // The paint editor's SwiftUI views (`PaintEditorView`, the canvas and panels) and their view
        // model on `PaintEditorController`. The only paint target that imports SwiftUI (AppKit / UIKit
        // for pen and trackpad input, behind `#if canImport`).
        .target(name: "PixeratePaintUI", dependencies: ["PixeratePaint", "PixerateCore", "PixerateRaster"], path: "packages/swift/Sources/PixeratePaintUI", swiftSettings: settings),
        // Replays the recorded scenarios against a Swift editor and compares the results.
        .target(name: "PixerateConformance", dependencies: ["PixerateCore", "PixerateContracts"], path: "packages/swift/Sources/PixerateConformance", swiftSettings: settings),
        .testTarget(
            name: "PixerateCoreTests",
            dependencies: ["PixerateCore"],
            path: "packages/swift/Tests/PixerateCoreTests",
            resources: [.copy("Fixtures")],
            swiftSettings: settings
        ),
        .testTarget(
            name: "PixerateRasterTests",
            dependencies: ["PixerateRaster", "PixerateCore"],
            path: "packages/swift/Tests/PixerateRasterTests",
            resources: [.copy("Fixtures")],
            swiftSettings: settings
        ),
        .testTarget(
            name: "PixeratePaintTests",
            dependencies: ["PixeratePaint", "PixerateContracts", "PixerateCore", "PixerateConformance", "PixerateRaster"],
            path: "packages/swift/Tests/PixeratePaintTests",
            swiftSettings: settings
        ),
        .testTarget(
            name: "PixeratePaintUITests",
            dependencies: ["PixeratePaintUI", "PixeratePaint", "PixerateCore", "PixerateRaster"],
            path: "packages/swift/Tests/PixeratePaintUITests",
            swiftSettings: settings
        ),
    ]
)
