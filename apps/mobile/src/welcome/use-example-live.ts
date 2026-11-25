import { initialHostLive, reduceLive } from "@core/live-state";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { useEffect, useState } from "react";
import { useAppActive } from "@/data/live";
import { useMotion } from "@/ui/motion";

/** Holds a preview sample and streams only while it is visible. */
export function useExampleLive(focused: boolean) {
  const { reduced } = useMotion();
  const foreground = useAppActive();
  const [mock] = useState(() =>
    createMockTransport({ autoTick: true, historyRows: 60 })
  );
  const [live, setLive] = useState(() => initialHostLive(MOCK_HOST_ID));

  useEffect(() => {
    if (!focused || !foreground) return;
    let active = true;
    let next = initialHostLive(MOCK_HOST_ID);
    void mock
      .subscribeLive(MOCK_HOST_ID, (message) => {
        if (!active) return;
        next = reduceLive(next, message);
        if (message.kind === "backfill" || message.kind === "frame") {
          setLive(next);
        }
      })
      .then(
        ({ info }) => {
          if (!active) return;
          if (info.status === "error") {
            console.warn(
              "[welcome] Could not load the example host",
              info.error
            );
          }
          // The inline backfill already supplied a still frame.
          if (reduced || info.status === "error") mock.dispose();
        },
        (error: unknown) => {
          if (!active) return;
          console.warn("[welcome] Could not load the example host", error);
          mock.dispose();
        }
      );
    return () => {
      active = false;
      mock.dispose();
    };
  }, [focused, foreground, mock, reduced]);

  return live;
}
