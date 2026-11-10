import { createMockTransport } from "@core/mock-transport";

it("reports native window visibility independently of display-idle stream delivery", async () => {
  const transport = createMockTransport({ historyRows: 1 });
  const changed = vi.fn();
  const unsubscribe = transport.onWindowVisibility(changed);
  try {
    expect(await transport.windowVisible()).toBe(true);
    transport.setDisplayIdle(true);
    expect(await transport.windowVisible()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    transport.setWindowVisible(false);
    expect(await transport.windowVisible()).toBe(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith(false);
    transport.setDisplayIdle(false);
    expect(await transport.windowVisible()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    transport.setWindowVisible(true);
    expect(changed).toHaveBeenLastCalledWith(true);
    unsubscribe();
    transport.setWindowVisible(false);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    transport.dispose();
  }
});
