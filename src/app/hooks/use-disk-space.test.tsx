import { MOCK_SCAN_MS } from "@core/mock/disk-space";
import { unwrap } from "@core/transport";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import {
  useSpaceHighlights,
  useSpaceScan,
  useSpaceStatus,
} from "~/hooks/use-disk-space";
import { makeQueryClient } from "~/lib/query";
import { useTransport } from "~/lib/transport-context";
import { useHostId } from "~/stores/host-store";

function Status({ name }: { name: string }) {
  const status = useSpaceStatus(true);
  const phase = status.isError
    ? "error"
    : status.data?.phase === "scanning"
      ? "scanning"
      : status.data
        ? "idle"
        : "loading";
  return <p>{`${name}: ${phase}`}</p>;
}

function StartScan() {
  const { start } = useSpaceScan();
  return (
    <button type="button" onClick={() => void start("/", [])}>
      Start scan
    </button>
  );
}

it("stops polling and reports no running scan once the status read fails", async () => {
  const { transport, user } = renderWithProviders(
    <>
      <Status name="status" />
      <StartScan />
    </>,
    { transportOptions: { now: () => 1_700_000_000_000 } }
  );
  await screen.findByText("status: idle");
  await user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByText("status: scanning");

  const read = vi
    .spyOn(transport, "diskSpaceStatus")
    .mockRejectedValue(new Error("connection lost"));
  await screen.findByText("status: error", {}, { timeout: 3000 });
  const calls = read.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(read.mock.calls.length).toBe(calls);
}, 10_000);

function StartBehindTheCache() {
  const transport = useTransport();
  const host = useHostId();
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          await unwrap(transport.diskSpaceStart(host, "/", []));
          setShown(true);
        }}
      >
        Start elsewhere
      </button>
      {shown && <Status name="page" />}
    </>
  );
}

it("reads the status again for a new observer instead of trusting a cached idle", async () => {
  // The app's client, whose default keeps reads fresh for a minute.
  const { user } = renderWithProviders(
    <>
      <Status name="sidebar" />
      <StartBehindTheCache />
    </>,
    {
      queryClient: makeQueryClient(),
      transportOptions: { now: () => 1_700_000_000_000 },
    }
  );
  await screen.findByText("sidebar: idle");
  await user.click(screen.getByRole("button", { name: "Start elsewhere" }));
  expect(await screen.findByText("page: scanning")).toBeVisible();
});

function Highlights() {
  useSpaceHighlights();
  return null;
}

it("reads the kept summary once when a scan ends under several observers", async () => {
  let now = 1_700_000_000_000;
  const { transport, user } = renderWithProviders(
    <>
      <Status name="sidebar" />
      <Status name="page" />
      <Highlights />
      <StartScan />
    </>,
    { transportOptions: { now: () => now } }
  );
  await screen.findByText("sidebar: idle");
  const reads = vi.spyOn(transport, "diskSpaceHighlights");
  await user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByText("sidebar: scanning");
  await waitFor(() => expect(reads).toHaveBeenCalledTimes(0));

  now += MOCK_SCAN_MS;
  await screen.findByText("sidebar: idle", {}, { timeout: 3000 });
  await screen.findByText("page: idle");
  await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(reads).toHaveBeenCalledTimes(1);
}, 10_000);
