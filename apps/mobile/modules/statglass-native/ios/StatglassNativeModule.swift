import ExpoModulesCore

/// The Expo module: forwards `call` to the Rust core, forwards the core's live messages
/// and events as module events, and drives the core's lifecycle from the app's state and
/// network path. It never reads the JSON it carries (phase 4 lane b fills it in).
public class StatglassNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StatglassNative")

    Events("onLive", "onCoreEvent")

    Function("version") { () -> String in
      StatglassNativeModule.notImplemented("version")
    }

    AsyncFunction("start") { (configJson: String) -> String in
      _ = configJson
      return StatglassNativeModule.notImplemented("start")
    }

    AsyncFunction("call") { (method: String, argsJson: String) -> String in
      _ = (method, argsJson)
      return StatglassNativeModule.notImplemented("call")
    }

    Function("setSnapshotCover") { (enabled: Bool) in
      _ = enabled
    }
  }

  /// An `internal` error envelope, shaped like the core's, for a stub.
  static func notImplemented(_ name: String) -> String {
    "{\"status\":\"error\",\"error\":{\"kind\":\"internal\",\"message\":\"statglass-native \(name): not implemented\"}}"
  }
}
