import Foundation
import Network
import os
import UIKit

/// Issues app and network transitions off the main thread in notification order.
final class AppLifecycle: @unchecked Sendable {
  // Startup and teardown use this queue too, so a reload releases the old core
  // before the next module starts opening mirrors.
  static let coreQueue = DispatchQueue(label: "app.statglass.core", qos: .userInitiated)

  private let calls: DispatchGroup
  private let monitor = NWPathMonitor()
  private var observers: [NSObjectProtocol] = []
  // Accessed on coreQueue after initialization.
  private var core: MobileCore?

  init(core: MobileCore, calls: DispatchGroup) {
    self.core = core
    self.calls = calls
  }

  func start() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] notification in
        guard notification.object is UIWindowScene else { return }
        MainActor.assumeIsolated { self?.quiesce() }
      },
      center.addObserver(forName: UIScene.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] notification in
        guard notification.object is UIWindowScene else { return }
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
      _ = core.quiesce()
      // Teardown drains this call off-main before starting a replacement core.
      calls.enter()
      Task.detached { [weak core, calls] in
        var waitingCore = core
        _ = await waitingCore?.quiesced()
        waitingCore = nil
        calls.leave()
        await end()
      }
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
        } else {
          for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
          where scene.activationState == .background {
            showCovers(in: scene)
          }
        }
      }
    }
  }

  func start() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] notification in
        MainActor.assumeIsolated {
          guard let scene = notification.object as? UIWindowScene else { return }
          self?.showCovers(in: scene)
        }
      },
      center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] _ in
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
  private func showCovers(in scene: UIWindowScene) {
    guard enabled, covers.isEmpty else { return }
    for window in scene.windows where !window.isHidden {
      let cover = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
      cover.frame = window.bounds
      cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      cover.isUserInteractionEnabled = false
      window.addSubview(cover)
      covers.append(cover)
    }
  }

  @MainActor
  private func removeCovers() {
    covers.forEach { $0.removeFromSuperview() }
    covers.removeAll()
  }
}
