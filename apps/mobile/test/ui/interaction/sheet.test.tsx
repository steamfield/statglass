import { expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent } from "@testing-library/react-native";
import { useState } from "react";
import { Text } from "react-native";
import { Sheet } from "@/ui/sheet";

async function renderSheet() {
  const close = jest.fn();
  function Example() {
    const [visible, setVisible] = useState(true);
    return (
      <Sheet
        visible={visible}
        title="History range"
        onClose={() => {
          close();
          setVisible(false);
        }}
      >
        <Text>Choose a range</Text>
      </Sheet>
    );
  }
  return { ...(await renderWithProviders(<Example />)), close };
}

it("presents the title and content and closes when Done is pressed", async () => {
  const { getByRole, getByText, queryByRole, close } = await renderSheet();
  expect(getByRole("header", { name: "History range" })).toBeVisible();
  expect(getByText("Choose a range")).toBeVisible();

  await fireEvent.press(getByRole("button", { name: "Done" }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(queryByRole("header", { name: "History range" })).toBeNull();
});

it("calls onClose when iOS dismisses the page sheet", async () => {
  const { container, queryByRole, close } = await renderSheet();
  const [modal] = container.queryAll((node) => node.type === "Modal");
  if (!modal) throw new Error("Expected the native page sheet to be open");
  expect(modal.props).toMatchObject({
    presentationStyle: "pageSheet",
    allowSwipeDismissal: true,
  });
  await fireEvent(modal, "requestClose");
  expect(close).toHaveBeenCalledTimes(1);
  expect(queryByRole("header", { name: "History range" })).toBeNull();
});

it("closes on the VoiceOver escape gesture", async () => {
  const { container, queryByRole, close } = await renderSheet();
  const [surface] = container.queryAll(
    (node) => node.props.accessibilityViewIsModal === true
  );
  if (!surface) throw new Error("Expected the accessible sheet surface");
  await fireEvent(surface, "accessibilityEscape");
  expect(close).toHaveBeenCalledTimes(1);
  expect(queryByRole("header", { name: "History range" })).toBeNull();
});
