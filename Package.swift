// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "OpenScreen",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "OpenScreen"),
        .executableTarget(
            name: "ObservationHelper",
            exclude: ["README.md"]
        ),
        .testTarget(
            name: "OpenScreenTests",
            dependencies: [
                "OpenScreen",
                "ObservationHelper",
            ]
        ),
    ]
)
