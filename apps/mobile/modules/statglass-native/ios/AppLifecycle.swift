import Foundation
import Network
import os
import UIKit

/// Maps the app's state and network path onto the core:
/// `didEnterBackground` begins a background task, awaits `MobileCore.quiesce()` and ends
/// the task when it resolves or expires; `willEnterForeground` calls `resume()`;
/// `NWPathMonitor` updates call `pathChanged(NetworkPath)`. Nothing here blocks the main
/// thread.
final class AppLifecycle {
  private let core: MobileCore
  private let monitor = NWPathMonitor()
  private var observers: [NSObjectProtocol] = []
  @MainActor private var lastTransition: Task<Void, Never>?

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
        MainActor.assumeIsolated {
          self?.enqueueTransition { core in _ = core.resume() }
        }
      },
    ]
    monitor.pathUpdateHandler = { [core] path in
      _ = core.pathChanged(path: NetworkPath(
        satisfied: path.status == .satisfied,
        expensive: path.isExpensive,
        constrained: path.isConstrained
      ))
    }
    monitor.start(queue: DispatchQueue(label: "app.statglass.network-path"))
  }

  func stop() {
    monitor.cancel()
    monitor.pathUpdateHandler = nil
    observers.forEach(NotificationCenter.default.removeObserver)
    observers.removeAll()
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
    enqueueTransition { core in
      _ = await core.quiesce()
      await end()
    }
  }

  @MainActor
  private func enqueueTransition(_ run: @escaping @Sendable (MobileCore) async -> Void) {
    // Keep UIKit's order even when quiesce is still waiting for mirror writes.
    let previous = lastTransition
    lastTransition = Task.detached { [core] in
      await previous?.value
      await run(core)
    }
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
