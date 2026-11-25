import type { MockTransport } from "./contracts";
import type { MockEmitters } from "./emitters";
import type { MockPower } from "./power";
import type { MockStream } from "./stream";

export function mockVisibility(
  power: MockPower,
  stream: MockStream,
  emitters: MockEmitters
): Pick<
  MockTransport,
  "windowVisible" | "onWindowVisibility" | "setWindowVisible" | "setDisplayIdle"
> {
  return {
    windowVisible: async () => power.windowVisible,
    onWindowVisibility: (cb) =>
      emitters.visibility.on((event) => cb(event.visible)),
    setWindowVisible(visible) {
      const before = power.windowVisible;
      stream.setWindowVisible(visible);
      if (before !== power.windowVisible) emitters.visibility.emit({ visible });
    },
    setDisplayIdle(idle) {
      stream.setDisplayIdle(idle);
    },
  };
}
