/**
 * A test send to one destination, saved or not, for a "Send to" row and the
 * destination dialog: whether it is out, what it was sent to, and how it
 * ended.
 */
import { commandErrorText } from "@core/command-error";
import type { DeliveryRecord, Destination } from "@core/generated/types";
import { useRef, useState } from "react";
import { useAlertDestinationCommands } from "./use-alert-destinations";

/** What `useTestDelivery` returns. */
export interface TestDelivery {
  /** True while a test send is out. */
  sending: boolean;
  /** The destination the current or last test was sent to; null before one. */
  sent: Destination | null;
  /** The last test's outcome, timed when it answered; null before one. */
  record: DeliveryRecord | null;
  /** Why the last test could not be sent at all (a refusal); else null. */
  failure: string | null;
  /** Sends a test message to `destination`, saved or not. */
  send: (destination: Destination) => Promise<void>;
  /** Forgets the last test, and drops the answer of one still out. */
  clear: () => void;
}

type TestState = Pick<TestDelivery, "sending" | "sent" | "record" | "failure">;

/** One send, tagged so an answer to a forgotten send is dropped. */
interface Tagged extends TestState {
  tag: number;
}

const FAILED = "Couldn't send the test.";

const IDLE: Tagged = {
  tag: 0,
  sending: false,
  sent: null,
  record: null,
  failure: null,
};

/**
 * One test send at a time through the test command: its outcome kept as a
 * delivery record at the moment it answered, or the command's message when
 * it refused (an invalid form) or the call failed. `clear`, or a change of
 * `resetKey` (the row's last delivery), forgets it, and an answer to a send
 * made before then is ignored.
 */
export function useTestDelivery(resetKey = ""): TestDelivery {
  const { test } = useAlertDestinationCommands();
  const [state, setState] = useState<Tagged>(IDLE);
  const [seenKey, setSeenKey] = useState(resetKey);
  const nextTag = useRef(1);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setState(IDLE);
  }
  const send = async (destination: Destination) => {
    const tag = nextTag.current++;
    const settle = (next: Omit<TestState, "sent" | "sending">) =>
      setState((now) =>
        now.tag === tag
          ? { ...next, tag, sent: destination, sending: false }
          : now
      );
    setState({ ...IDLE, tag, sending: true, sent: destination });
    try {
      const result = await test(destination);
      if (result.status === "ok") {
        settle({
          record: { at_ms: Date.now(), outcome: result.data },
          failure: null,
        });
        return;
      }
      console.error("[alerts] alert_destination_test rejected", result.error);
      settle({ record: null, failure: commandErrorText(result.error, FAILED) });
    } catch (error) {
      console.error("[alerts] alert_destination_test failed", error);
      settle({ record: null, failure: commandErrorText(error, FAILED) });
    }
  };
  const { sending, sent, record, failure } = state;
  return { sending, sent, record, failure, send, clear: () => setState(IDLE) };
}
