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
        .library(name: "PixeratePaint", targets: ["PixeratePaint"]),
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
        // The paint editor. `Generated/` is written by scripts/gen-swift.mjs from the paint contracts.
        .target(name: "PixeratePaint", dependencies: ["PixerateCore", "PixerateContracts"], path: "packages/swift/Sources/PixeratePaint", swiftSettings: settings),
        .testTarget(
            name: "PixerateCoreTests",
            dependencies: ["PixerateCore"],
            path: "packages/swift/Tests/PixerateCoreTests",
            resources: [.copy("Fixtures")],
            swiftSettings: settings
        ),
        .testTarget(
            name: "PixeratePaintTests",
            dependencies: ["PixeratePaint", "PixerateContracts", "PixerateCore"],
            path: "packages/swift/Tests/PixeratePaintTests",
            swiftSettings: settings
        ),
    ]
)
