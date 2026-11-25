import type {
  BuildInfo,
  MobileCall,
  MobileLiveRequest,
  SubscriptionInfo,
} from "@core/generated/types";
import { afterEach, jest } from "@jest/globals";
import {
  __setNativeForTests,
  type StatglassNativeEvents,
  type StatglassNativeModule,
} from "@native/statglass-native";
import { NativeModule } from "expo";

export function ok(data: unknown): string {
  return JSON.stringify({ status: "ok", data });
}

export const BUILD_INFO: BuildInfo = {
  version: "9.8.7",
  protocol_min: 3,
  protocol_max: 5,
};

export class FakeNative
  extends NativeModule<StatglassNativeEvents>
  implements StatglassNativeModule
{
  readonly version = jest.fn(() => ok(BUILD_INFO));
  readonly start = jest.fn(async (_config: string) => ok(null));
  readonly preparePhoneKey = jest.fn(async () => undefined);
  readonly call = jest.fn(
    async (method: MobileCall["method"], args: string) => {
      if (method === "subscribe_live") {
        const { host, stream } = JSON.parse(args) as MobileLiveRequest;
        return ok({
          host,
          stream,
          recent_ms: 120_000,
          backfill_start_ms: null,
          backfill_rows: 0,
          earlier_start_ms: null,
          earlier_rows: 0,
        } satisfies SubscriptionInfo);
      }
      return ok(null);
    }
  );
  readonly setSnapshotCover = jest.fn((_enabled: boolean) => undefined);
}

export function installNative(native: StatglassNativeModule | null) {
  __setNativeForTests(native);
}

afterEach(() => {
  __setNativeForTests(undefined);
});
