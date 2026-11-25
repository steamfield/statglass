import ExpoModulesCore
import Foundation
import os

/// The Expo module: forwards `call` to the Rust core, forwards the core's live messages
/// and events as module events, and drives the core's lifecycle from the app's state and
/// network path. It never reads the JSON it carries.
public class StatglassNativeModule: Module {
  private let phoneKey = currentPhoneKey()
  private let snapshotCover = SnapshotCover()
  private let hasLiveListeners = OSAllocatedUnfairLock(initialState: false)
  private var core: MobileCore?
  private var lifecycle: AppLifecycle?

  public func definition() -> ModuleDefinition {
    Name("StatglassNative")

    Events("onLive", "onCoreEvent")

    OnCreate {
      let core = MobileCore(signer: PhoneKeySigner(phoneKey), events: EventsBridge(self))
      self.core = core
      let lifecycle = AppLifecycle(core: core)
      self.lifecycle = lifecycle
      lifecycle.start()
      snapshotCover.start()
    }

    OnDestroy {
      hasLiveListeners.withLock { $0 = false }
      lifecycle?.stop()
      snapshotCover.stop()
    }

    Function("version") { () -> String in
      version()
    }

    AsyncFunction("start") { (configJson: String, promise: Promise) in
      guard let core else {
        promise.reject(Exceptions.AppContextLost())
        return
      }
      do {
        _ = try phoneKey.publicKey()
        let dataDir = try Self.prepareDataDirectory()
        promise.resolve(core.start(dataDir: dataDir.path, configJson: configJson))
      } catch let failure as NativeFailure {
        promise.reject(failure.code, failure.description)
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("call") { (method: String, argsJson: String, promise: Promise) in
      guard let core else {
        promise.reject(Exceptions.AppContextLost())
        return
      }
      Task {
        promise.resolve(await core.call(method: method, argsJson: argsJson))
      }
    }

    Function("setSnapshotCover") { (enabled: Bool) in
      snapshotCover.enabled = enabled
    }
  }

  public override func didStartListening(event: String) {
    if event == "onLive" { hasLiveListeners.withLock { $0 = true } }
  }

  public override func didStopListening(event: String) {
    if event == "onLive" { hasLiveListeners.withLock { $0 = false } }
  }

  fileprivate func sendLive(stream: UInt32, message: String) -> Bool {
    guard hasLiveListeners.withLock({ $0 }) else { return false }
    emit(event: "onLive", payload: ["stream": stream, "message": message] as [String: Any])
    return true
  }

  private static func prepareDataDirectory() throws -> URL {
    let files = FileManager.default
    let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var directory = support.appendingPathComponent("statglass", isDirectory: true)
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try files.createDirectory(at: directory, withIntermediateDirectories: true, attributes: protection)
    try files.setAttributes(protection, ofItemAtPath: directory.path)
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try directory.setResourceValues(resources)
    return directory
  }
}

/// Both PhoneKey implementations share the same synchronized Keychain storage.
private final class PhoneKeySigner: NativeSigner, @unchecked Sendable {
  private let key: PhoneKey
  private let logger = Logger(subsystem: "app.statglass", category: "phone-key")

  init(_ key: PhoneKey) {
    self.key = key
  }

  func publicKey() -> Data {
    do {
      return try key.publicKey()
    } catch {
      // The FFI public-key callback cannot throw. Rust rejects an empty point.
      logger.error("Could not read the phone public key: \(String(describing: error), privacy: .public)")
      return Data()
    }
  }

  func sign(data: Data) throws -> Data {
    do {
      return try key.sign(data)
    } catch let failure as NativeFailure {
      switch failure {
      case .keychain, .secureEnclave:
        throw NativeSignerError.Unavailable(message: failure.description)
      case .camera, .localNetwork:
        throw NativeSignerError.Unexpected(message: failure.description)
      }
    }
  }
}

private final class EventsBridge: CoreEvents, @unchecked Sendable {
  private weak var module: StatglassNativeModule?

  init(_ module: StatglassNativeModule) {
    self.module = module
  }

  func live(stream: UInt32, messageJson: String) -> Bool {
    module?.sendLive(stream: stream, message: messageJson) ?? false
  }

  func event(eventJson: String) {
    module?.emit(event: "onCoreEvent", payload: ["event": eventJson])
  }
}
