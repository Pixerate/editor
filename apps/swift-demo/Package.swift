// swift-tools-version: 6.0
// The Swift demo app (#541): a macOS SwiftUI app on the root package's editors, by relative path.
// Run it with `swift run --package-path apps/swift-demo`.
import PackageDescription

let package = Package(
    name: "PixerateSwiftDemo",
    platforms: [.macOS(.v14), .iOS(.v17)],
    dependencies: [
        // Named, so the products resolve whatever the checkout's directory is called.
        .package(name: "Pixerate", path: "../.."),
    ],
    targets: [
        .executableTarget(
            name: "PixerateSwiftDemo",
            dependencies: [
                .product(name: "PixeratePaintUI", package: "Pixerate"),
                .product(name: "PixeratePaint", package: "Pixerate"),
                .product(name: "PixerateCore", package: "Pixerate"),
            ],
            path: "Sources/PixerateSwiftDemo",
            swiftSettings: [.enableUpcomingFeature("NonisolatedNonsendingByDefault")]
        ),
    ]
)
