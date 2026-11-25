import Foundation
import UIKit

/// Maps the app's state and network path onto the core (phase 4 lane b):
/// `didEnterBackground` begins a background task, awaits `MobileCore.quiesce()` and ends
/// the task when it resolves or expires; `willEnterForeground` calls `resume()`;
/// `NWPathMonitor` updates call `pathChanged(NetworkPath)`. Nothing here blocks the main
/// thread.
final class AppLifecycle {
  func start() {}

  func stop() {}
}

/// A blur over the key window while the app is inactive, so the app switcher snapshot
/// shows no data. Shown only while enabled (the app lock is on), per RFC 3.8
/// (phase 4 lane b).
final class SnapshotCover {
  var enabled = false

  func start() {}

  func stop() {}
}
