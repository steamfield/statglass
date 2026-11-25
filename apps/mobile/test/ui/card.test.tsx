import { expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { Card, PressableCard } from "@/ui/card";

const SURFACE = [
  "overflow-hidden",
  "rounded-xl",
  "border",
  "border-border",
  "bg-card",
];

function classes(element: { props: { className?: unknown } }): string[] {
  return String(element.props.className ?? "").split(/\s+/);
}

it("renders its children on the card surface with medium padding", async () => {
  const view = await render(
    <Card testID="card">
      <Text>52 °C</Text>
    </Card>
  );

  expect(view.getByText("52 °C")).toBeOnTheScreen();
  expect(classes(view.getByTestId("card"))).toEqual(
    expect.arrayContaining([...SURFACE, "p-3"])
  );
});

it.each([
  ["none", []],
  ["md", ["p-3"]],
  ["lg", ["p-4"]],
] as const)("applies %s padding", async (padding, expected) => {
  const view = await render(<Card testID="card" padding={padding} />);

  expect(
    classes(view.getByTestId("card")).filter((name) => /^p-/.test(name))
  ).toEqual(expected);
});

it("keeps the caller's layout classes and view props", async () => {
  const view = await render(
    <Card testID="card" className="mt-2 gap-2" accessibilityLabel="Sensors" />
  );

  const card = view.getByLabelText("Sensors");
  expect(card).toBe(view.getByTestId("card"));
  expect(classes(card)).toEqual(
    expect.arrayContaining([...SURFACE, "mt-2", "gap-2"])
  );
});

it("makes a pressable card one button that fires onPress", async () => {
  const onPress = jest.fn();
  const view = await render(
    <PressableCard accessibilityLabel="CPU, 12 percent" onPress={onPress}>
      <Text>CPU</Text>
    </PressableCard>
  );

  const card = view.getByRole("button", { name: "CPU, 12 percent" });
  expect(view.getByText("CPU")).toBeOnTheScreen();
  expect(classes(card)).toEqual(
    expect.arrayContaining([...SURFACE, "min-h-touch", "p-3"])
  );
  await fireEvent.press(card);
  expect(onPress).toHaveBeenCalledTimes(1);
});

it("does not fire a disabled pressable card", async () => {
  const onPress = jest.fn();
  const view = await render(
    <PressableCard accessibilityLabel="GPU" disabled onPress={onPress} />
  );

  await fireEvent.press(view.getByRole("button", { name: "GPU" }));
  expect(onPress).not.toHaveBeenCalled();
});
