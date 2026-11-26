import { createMockTransport } from "@core/mock-transport";
import { screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { expectTypeOf } from "vitest";
import { renderWithProviders } from "../../../../../../../tests/test-utils";
import type { PairingDialog } from "../paired-devices/pairing-dialog";
import { PairedDevicesPanel } from "../paired-devices/panel";
import { UpdateFromMac } from ".";

it("opens Update iPhone from the Paired devices settings", async () => {
  const { user } = renderWithProviders(<PairedDevicesPanel />);
  const panel = within(screen.getByRole("region", { name: "Paired devices" }));
  expect(panel.getByText("Host list on iPhone")).toBeVisible();
  await user.click(panel.getByRole("button", { name: "Update iPhone" }));
  expect(
    await screen.findByRole("img", { name: "iPhone update QR code" })
  ).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Update iPhone" })).toBeVisible();
});

it("requires both controlled props for either dialog", () => {
  type PairingProps = ComponentProps<typeof PairingDialog>;
  type UpdateProps = ComponentProps<typeof UpdateFromMac>;
  type OnOpenChange = (open: boolean) => void;
  type OnPaired = () => void;
  expectTypeOf<{ open: true }>().not.toExtend<UpdateProps>();
  expectTypeOf<{ onOpenChange: OnOpenChange }>().not.toExtend<UpdateProps>();
  expectTypeOf<{
    onPaired: OnPaired;
    open: true;
  }>().not.toExtend<PairingProps>();
  expectTypeOf<{
    onPaired: OnPaired;
    onOpenChange: OnOpenChange;
  }>().not.toExtend<PairingProps>();
});

it("shows a fresh QR, included hosts, and the unavailable reason on open", async () => {
  const mock = createMockTransport({ autoTick: false });
  let host = "build-server";
  const { user } = renderWithProviders(<UpdateFromMac />, {
    transport: {
      ...mock,
      handoverBundleStart: async () => {
        const offer = await mock.handoverBundleStart();
        return offer.status === "ok"
          ? { status: "ok", data: { ...offer.data, hosts: [host] } }
          : offer;
      },
    },
  });
  await user.click(screen.getByRole("button", { name: "Update iPhone" }));
  expect(
    await screen.findByRole("img", { name: "iPhone update QR code" })
  ).toBeVisible();
  expect(screen.getByText("build-server")).toBeVisible();
  expect(screen.getByText("Office server")).toBeVisible();
  expect(screen.getByText("SSH uses a jump host.")).toBeVisible();
  await user.keyboard("{Escape}");
  host = "Backup Mac";
  await user.click(screen.getByRole("button", { name: "Update iPhone" }));
  expect(await screen.findByText("Backup Mac")).toBeVisible();
  expect(screen.queryByText("build-server")).not.toBeInTheDocument();
});

it("retries a preparation failure and shows missing QR and hosts", async () => {
  const mock = createMockTransport({ autoTick: false });
  let attempt = 0;
  const { user } = renderWithProviders(<UpdateFromMac />, {
    transport: {
      ...mock,
      handoverBundleStart: async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            status: "error",
            error: {
              kind: "handover",
              message: "Couldn’t read the SSH configuration.",
            },
          };
        }
        if (attempt > 2) return mock.handoverBundleStart();
        return {
          status: "ok",
          data: {
            text: "SGB1:",
            qr_svg: "<svg />",
            hosts: [],
            unavailable: [],
            issued_ms: 1,
          },
        };
      },
    },
  });

  await user.click(screen.getByRole("button", { name: "Update iPhone" }));
  const dialog = () =>
    within(screen.getByRole("dialog", { name: "Update iPhone" }));
  expect(await dialog().findByRole("alert")).toHaveTextContent(
    "Couldn’t read the SSH configuration."
  );
  await user.click(dialog().getByRole("button", { name: "Retry" }));
  expect(
    await dialog().findByText("No other hosts are included.")
  ).toBeVisible();
  expect(dialog().getByRole("alert")).toHaveTextContent(
    "Couldn’t display the update QR code."
  );
  expect(
    dialog().queryByRole("heading", { name: "Unavailable hosts" })
  ).not.toBeInTheDocument();
  await user.click(dialog().getByRole("button", { name: "Retry" }));
  expect(
    await dialog().findByRole("img", { name: "iPhone update QR code" })
  ).toBeVisible();
});
