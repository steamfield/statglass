import { expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { Button } from "@/ui/button";

it("renders its label as a button and fires onPress once per press", async () => {
  const onPress = jest.fn();
  const view = await render(<Button label="Pair" onPress={onPress} />);

  const button = view.getByRole("button", { name: "Pair" });
  await fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
  await fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(2);
});

it("does not fire onPress while disabled and reports the disabled state", async () => {
  const onPress = jest.fn();
  const view = await render(<Button label="Pair" onPress={onPress} disabled />);

  const button = view.getByRole("button", { name: "Pair" });
  await fireEvent.press(button);
  expect(onPress).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
});

it("reports busy and does not fire onPress while busy", async () => {
  const onPress = jest.fn();
  const view = await render(<Button label="Connect" onPress={onPress} busy />);

  const button = view.getByRole("button", { name: "Connect" });
  await fireEvent.press(button);
  expect(onPress).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
  expect(button).toBeBusy();
});

it("is enabled unless disabled is set", async () => {
  const view = await render(<Button label="Pair" onPress={() => {}} />);

  expect(view.getByRole("button", { name: "Pair" })).toBeEnabled();
});

it("takes its accessible name from accessibilityLabel while showing the label", async () => {
  const view = await render(
    <Button
      label="Retry"
      accessibilityLabel="Retry loading history"
      accessibilityHint="Reads the last hour again"
      onPress={() => {}}
    />
  );

  const button = view.getByRole("button", { name: "Retry loading history" });
  expect(button).toHaveProp("accessibilityHint", "Reads the last hour again");
  expect(view.getByText("Retry")).toBeOnTheScreen();
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
});

it.each([
  ["primary", "bg-primary"],
  ["secondary", "bg-card"],
] as const)(
  "gives the %s variant a filled 44 pt surface",
  async (variant, surface) => {
    const view = await render(
      <Button label="Continue" variant={variant} onPress={() => {}} />
    );

    const className = view.getByRole("button", { name: "Continue" }).props
      .className as string;
    expect(className.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-h-touch", "rounded-xl", surface])
    );
  }
);

it("gives the link variant a 44 pt target and no surface", async () => {
  const view = await render(
    <Button label="Clear pin" variant="link" onPress={() => {}} />
  );

  const classes = (
    view.getByRole("button", { name: "Clear pin" }).props.className as string
  ).split(/\s+/);
  expect(classes).toEqual(
    expect.arrayContaining(["min-h-touch", "min-w-touch"])
  );
  expect(classes.filter((name) => /^(bg-|border)/.test(name))).toEqual([]);
});

it("defaults to the primary variant and keeps the caller's layout classes", async () => {
  const view = await render(
    <Button label="Continue" className="mt-4 self-stretch" onPress={() => {}} />
  );

  expect(
    (
      view.getByRole("button", { name: "Continue" }).props.className as string
    ).split(/\s+/)
  ).toEqual(expect.arrayContaining(["bg-primary", "mt-4", "self-stretch"]));
});

it("passes testID to the pressable", async () => {
  const view = await render(
    <Button label="Continue" testID="continue" onPress={() => {}} />
  );

  expect(view.getByTestId("continue")).toBe(
    view.getByRole("button", { name: "Continue" })
  );
});

it.each([
  ["primary", "text-primary-foreground"],
  ["secondary", "text-foreground"],
  ["link", "text-link"],
] as const)("colours the %s label with %s alone", async (variant, colour) => {
  const view = await render(
    <Button label="Continue" variant={variant} onPress={() => {}} />
  );

  const classes = String(view.getByText("Continue").props.className).split(
    /\s+/
  );
  expect(
    classes.filter((name) => /^text-(?!left|center|right)/.test(name))
  ).toEqual([colour]);
});
