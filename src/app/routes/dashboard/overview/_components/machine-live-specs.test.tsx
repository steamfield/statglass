import { createMockTransport } from "@core/mock-transport";
import { render, screen, within } from "@testing-library/react";
import { App } from "~/app";

describe("Overview network spec", () => {
  it("shows the remote primary interface and its copyable addresses", async () => {
    const transport = createMockTransport({
      scenarios: ["multi-host"],
      autoTick: false,
    });
    render(
      <App
        transport={transport}
        initialHost="remote-studio"
        router={{ initialEntry: "/dashboard/overview" }}
      />
    );
    const header = within(
      await screen.findByRole("region", { name: "This Mac" })
    );
    expect(
      await header.findByRole("button", {
        name: "Copy local IP address 192.0.2.20",
      })
    ).toBeVisible();
    expect(
      header.getByRole("button", {
        name: "Copy public IP address 203.0.113.20",
      })
    ).toBeVisible();
    expect(header.getByText(/en0 ·/)).toBeVisible();
  });

  it("shows only the interface for the old host", async () => {
    const transport = createMockTransport({
      scenarios: ["hosts-outdated"],
      autoTick: false,
    });
    render(
      <App
        transport={transport}
        initialHost="remote-nas"
        router={{ initialEntry: "/dashboard/overview" }}
      />
    );
    const header = within(
      await screen.findByRole("region", { name: "This host" })
    );
    expect(await header.findByText("end0", { exact: true })).toBeVisible();
    expect(
      header.queryByRole("button", { name: /Copy.*IP address/ })
    ).toBeNull();
  });
});
