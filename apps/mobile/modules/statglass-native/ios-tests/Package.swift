// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "StatglassNativeContract",
  targets: [
    .target(name: "NativeFailure", path: "Sources"),
    .testTarget(name: "NativeFailureTests", dependencies: ["NativeFailure"], path: "Tests"),
  ]
)
