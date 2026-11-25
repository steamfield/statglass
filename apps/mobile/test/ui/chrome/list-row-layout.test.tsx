import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { screen } from "@testing-library/react-native";
import * as ReactNative from "react-native";
import { ListRow } from "@/ui/list-row";

/** React Native's jest mock reports font scale 2; pin the size each case reads at. */
const textAt = (fontScale: number) =>
  jest
    .spyOn(ReactNative.Dimensions, "get")
    .mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });

const trailing = { textAlign: "right" } as const;

test("keeps the value in the trailing column up to xxxLarge text", async () => {
  textAt(1.35);
  await renderWithProviders(<ListRow title="Safari" value="22.2 MB/s" />);
  expect(screen.getByText("22.2 MB/s")).toHaveStyle(trailing);
  expect(screen.getByLabelText("Safari")).toHaveAccessibilityValue({
    text: "22.2 MB/s",
  });
});

test("moves the value under the title at accessibility text sizes", async () => {
  textAt(1.65);
  await renderWithProviders(
    <ListRow title="com.docker.backend" value="9.6 MB/s" onPress={() => {}} />
  );
  expect(screen.getByText("9.6 MB/s")).not.toHaveStyle(trailing);
  expect(
    screen.getByRole("button", { name: "com.docker.backend" })
  ).toHaveAccessibilityValue({
    text: "9.6 MB/s",
  });
});

test("stacks a value the caller marks as too long at any size", async () => {
  textAt(1);
  await renderWithProviders(
    <ListRow title="IPv6" value="2001:db8:85a3::8a2e:370:7334" stackValue />
  );
  expect(screen.getByText("2001:db8:85a3::8a2e:370:7334")).not.toHaveStyle(
    trailing
  );
});
