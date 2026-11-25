import type {
  BuildInfo,
  MobileCall,
  MobileLiveRequest,
  SubscriptionInfo,
} from "@core/generated/types";
import { jest } from "@jest/globals";
import type {
  StatglassNativeEvents,
  StatglassNativeModule,
} from "@native/statglass-native";
import * as moduleLoader from "@native/statglass-native/src/StatglassNativeModule";
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
  readonly call = jest.fn(
    async (method: MobileCall["method"], args: string) => {
      if (method === "subscribe_live") {
        const { host, stream } = JSON.parse(args) as MobileLiveRequest;
        return ok({
          host,
          stream,
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
  jest.spyOn(moduleLoader, "getStatglassNative").mockReturnValue(native);
}
