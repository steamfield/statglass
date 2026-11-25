import ExpoModulesCore
import Foundation
import os

/// The Expo module: forwards `call` to the Rust core, forwards the core's live messages
/// and events as module events, and drives the core's lifecycle from the app's state and
/// network path. It never reads the JSON it carries.
public class StatglassNativeModule: Module {
  private static let phoneKeyQueue = DispatchQueue(label: "app.statglass.phone-key", qos: .userInitiated)

  private struct State {
    var core: MobileCore?
    var destroyed = false
    var hasLiveListeners = false
    var loggedMissingLiveListener = false

    var activeCore: MobileCore? { destroyed ? nil : core }
  }

  private let snapshotCover = SnapshotCover()
  private let signer = PhoneKeySigner(currentPhoneKey())
  private let state = OSAllocatedUnfairLock(initialState: State())
  private let calls = DispatchGroup()
  private let logger = Logger(subsystem: "app.statglass", category: "native-module")
  private var lifecycle: AppLifecycle?

  public func definition() -> ModuleDefinition {
    Name("StatglassNative")

    Events("onLive", "onCoreEvent")

    OnCreate {
      let core = MobileCore(signer: signer, events: EventsBridge(self))
      state.withLock { $0.core = core }
      let lifecycle = AppLifecycle(core: core, calls: calls)
      self.lifecycle = lifecycle
      lifecycle.start()
      snapshotCover.start()
    }

    OnDestroy {
      state.withLock { $0.destroyed = true }
      AppLifecycle.coreQueue.async { [lifecycle, state, calls] in
        lifecycle?.stop()
        // Calls already forwarded to Rust can retain the old core until they finish.
        calls.wait()
        let core = state.withLock { state in
          let core = state.core
          state.core = nil
          return core
        }
        // Rust can wait for writers during drop. Release off-main and outside the lock.
        withExtendedLifetime(core) {}
      }
      lifecycle = nil
      snapshotCover.stop()
    }

    Function("version") { () -> String in
      version()
    }

    AsyncFunction("start") { (configJson: String, promise: Promise) in
      guard let core = state.withLock({ $0.activeCore }) else {
        promise.reject(Exceptions.AppContextLost())
        return
      }
      do {
        let dataDir = try Self.prepareDataDirectory()
        promise.resolve(core.start(dataDir: dataDir.path, configJson: configJson))
      } catch {
        promise.reject(error)
      }
    }.runOnQueue(AppLifecycle.coreQueue)

    AsyncFunction("preparePhoneKey") { (promise: Promise) in
      do {
        try signer.prepare()
        promise.resolve()
      } catch let failure as NativeFailure {
        promise.reject(failure.code, failure.description)
      } catch {
        promise.reject(error)
      }
    }.runOnQueue(Self.phoneKeyQueue)

    AsyncFunction("call") { (method: String, argsJson: String, promise: Promise) in
      Task { [state, calls] in
        var core = state.withLock { state in
          let core = state.activeCore
          if core != nil { calls.enter() }
          return core
        }
        guard let result = await core?.call(method: method, argsJson: argsJson) else {
          promise.reject(Exceptions.AppContextLost())
          return
        }
        core = nil
        calls.leave()
        promise.resolve(result)
      }
    }

    Function("setSnapshotCover") { (enabled: Bool) in
      snapshotCover.enabled = enabled
    }
  }

  public override func didStartListening(event: String) {
    if event == "onLive" {
      state.withLock {
        $0.hasLiveListeners = true
        $0.loggedMissingLiveListener = false
      }
    }
  }

  public override func didStopListening(event: String) {
    if event == "onLive" { state.withLock { $0.hasLiveListeners = false } }
  }

  fileprivate func sendLive(stream: UInt32, message: String) -> Bool {
    let canSend = state.withLock { state in
      guard !state.destroyed else { return false }
      if state.hasLiveListeners { return true }
      if !state.loggedMissingLiveListener {
        state.loggedMissingLiveListener = true
        logger.notice("Stopping live stream without a JavaScript listener")
      }
      return false
    }
    guard canSend else { return false }
    emit(event: "onLive", payload: ["stream": stream, "message": message] as [String: Any])
    return true
  }

  fileprivate func sendCoreEvent(_ event: String) {
    guard state.withLock({ !$0.destroyed }) else { return }
    emit(event: "onCoreEvent", payload: ["event": event])
  }

  private static func prepareDataDirectory() throws -> URL {
    let files = FileManager.default
    let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = support.appendingPathComponent("statglass", isDirectory: true)
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try files.createDirectory(at: directory, withIntermediateDirectories: true, attributes: protection)
    try files.setAttributes(protection, ofItemAtPath: directory.path)
    return directory
  }
}

/// Both PhoneKey implementations share the same synchronized Keychain storage.
private final class PhoneKeySigner: NativeSigner, @unchecked Sendable {
  private let key: PhoneKey

  init(_ key: PhoneKey) {
    self.key = key
  }

  func prepare() throws {
    _ = try key.publicKey(createIfMissing: true)
  }

  func publicKey() throws -> Data {
    do {
      return try key.publicKey(createIfMissing: false)
    } catch let failure as NativeFailure {
      throw signerError(failure)
    }
  }

  func sign(data: Data) throws -> Data {
    do {
      return try key.sign(data)
    } catch let failure as NativeFailure {
      throw signerError(failure)
    }
  }

  private func signerError(_ failure: NativeFailure) -> NativeSignerError {
    failure.isKeyUnavailable
      ? .Unavailable(message: failure.description)
      : .Unexpected(message: failure.description)
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
    module?.sendCoreEvent(eventJson)
  }
}
