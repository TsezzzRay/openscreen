// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "OpenScreen",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "OpenScreen"),
        .executableTarget(name: "OpenScreenObservationHelper"),
        .testTarget(
            name: "OpenScreenTests",
            dependencies: ["OpenScreen", "OpenScreenObservationHelper"]
        ),
    ]
)
