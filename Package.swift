// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "OpenScreen",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "CaptureCore"),
        .executableTarget(
            name: "OpenScreen",
            dependencies: ["CaptureCore"]
        ),
        .executableTarget(
            name: "ObservationHelper",
            dependencies: ["CaptureCore"],
            exclude: ["README.md"]
        ),
        .testTarget(
            name: "OpenScreenTests",
            dependencies: [
                "CaptureCore",
                "OpenScreen",
                "ObservationHelper",
            ]
        ),
    ]
)
