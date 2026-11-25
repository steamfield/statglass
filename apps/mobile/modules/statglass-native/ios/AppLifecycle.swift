import Foundation
import Network
import os
import statglass_mobileFFI
import UIKit

/// Issues app and network transitions off the main thread in notification order.
final class AppLifecycle: @unchecked Sendable {
  // Startup and teardown use this queue too, so a reload releases the old core
  // before the next module starts opening mirrors.
  static let coreQueue = DispatchQueue(label: "app.statglass.core", qos: .userInitiated)

  private let monitor = NWPathMonitor()
  private var observers: [NSObjectProtocol] = []
  // Accessed on coreQueue after initialization.
  private var core: MobileCore?
  private var quiesces: [UInt64: BackgroundQuiesce] = [:]

  init(core: MobileCore) {
    self.core = core
  }

  func start() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.quiesce() }
      },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
        Self.coreQueue.async { [weak self] in
          _ = self?.core?.resume()
        }
      },
    ]
    monitor.pathUpdateHandler = { [weak self] path in
      _ = self?.core?.pathChanged(path: NetworkPath(
        satisfied: path.status == .satisfied,
        expensive: path.isExpensive,
        constrained: path.isConstrained
      ))
    }
    monitor.start(queue: Self.coreQueue)
  }

  func stop() {
    dispatchPrecondition(condition: .onQueue(Self.coreQueue))
    monitor.cancel()
    monitor.pathUpdateHandler = nil
    observers.forEach(NotificationCenter.default.removeObserver)
    observers.removeAll()
    for quiesce in Array(quiesces.values) {
      quiesce.finish()
    }
    core = nil
  }

  @MainActor
  private func quiesce() {
    let app = UIApplication.shared
    var task = UIBackgroundTaskIdentifier.invalid
    let end: @MainActor @Sendable () -> Void = {
      guard task != .invalid else { return }
      app.endBackgroundTask(task)
      task = .invalid
    }

    task = app.beginBackgroundTask(withName: "StatGlass quiesce", expirationHandler: end)
    Self.coreQueue.async { [weak self] in
      guard let self, let core else {
        DispatchQueue.main.async(execute: end)
        return
      }
      let handle = uniffi_statglass_mobile_fn_method_mobilecore_quiesce(core.uniffiCloneHandle())
      let quiesce = BackgroundQuiesce(handle: handle) { [weak self] in
        self?.quiesces.removeValue(forKey: handle)
        DispatchQueue.main.async(execute: end)
      }
      quiesces[handle] = quiesce
      quiesce.poll()
    }
  }
}

/// The first UniFFI poll issues Rust's quiesce requests synchronously on coreQueue.
/// Wakes enqueue further polls, so resume can run while mirror writes are draining.
private final class BackgroundQuiesce: @unchecked Sendable {
  private let handle: UInt64
  private let ended: () -> Void
  private var finished = false // Accessed on coreQueue.

  init(handle: UInt64, ended: @escaping () -> Void) {
    self.handle = handle
    self.ended = ended
  }

  func poll() {
    // UniFFI calls this continuation once per poll, including when the future is freed.
    let context = Unmanaged.passRetained(self).toOpaque()
    ffi_statglass_mobile_rust_future_poll_rust_buffer(handle, { data, result in
      guard let context = UnsafeRawPointer(bitPattern: UInt(data)) else { return }
      let quiesce = Unmanaged<BackgroundQuiesce>.fromOpaque(context).takeRetainedValue()
      AppLifecycle.coreQueue.async {
        guard !quiesce.finished else { return }
        if result == 0 { // UniFFI RustFuturePoll::Ready
          quiesce.finish()
        } else {
          quiesce.poll()
        }
      }
    }, UInt64(UInt(bitPattern: context)))
  }

  func finish() {
    finished = true
    // Completion takes any buffered result and drops the inner future even if it
    // was pending during teardown. Free also releases any registered continuation.
    var status = RustCallStatus()
    let result = ffi_statglass_mobile_rust_future_complete_rust_buffer(handle, &status)
    ffi_statglass_mobile_rust_future_free_rust_buffer(handle)
    var freeStatus = RustCallStatus()
    ffi_statglass_mobile_rustbuffer_free(result, &freeStatus)
    ffi_statglass_mobile_rustbuffer_free(status.errorBuf, &freeStatus)
    ended()
  }
}

/// Covers foreground windows before UIKit captures the app switcher snapshot.
final class SnapshotCover {
  private let enabledFlag = OSAllocatedUnfairLock(initialState: false)
  private var observers: [NSObjectProtocol] = []
  @MainActor private var covers: [UIVisualEffectView] = []

  var enabled: Bool {
    get { enabledFlag.withLock { $0 } }
    set {
      let previous = enabledFlag.withLock {
        let previous = $0
        $0 = newValue
        return previous
      }
      guard previous != newValue else { return }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if !enabled {
          removeCovers()
        } else if UIApplication.shared.applicationState == .inactive {
          showCovers()
        }
      }
    }
  }

  func start() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.showCovers() }
      },
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.removeCovers() }
      },
    ]
  }

  func stop() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers.removeAll()
    enabledFlag.withLock { $0 = false }
    DispatchQueue.main.async { self.removeCovers() }
  }

  @MainActor
  private func showCovers() {
    guard enabled, covers.isEmpty else { return }
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
    where scene.activationState == .foregroundActive || scene.activationState == .foregroundInactive {
      for window in scene.windows where !window.isHidden {
        let cover = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        cover.frame = window.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.isUserInteractionEnabled = false
        window.addSubview(cover)
        covers.append(cover)
      }
    }
  }

  @MainActor
  private func removeCovers() {
    covers.forEach { $0.removeFromSuperview() }
    covers.removeAll()
  }
}
