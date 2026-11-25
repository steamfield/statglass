import "react-native-gesture-handler/jestSetup";
import { expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { Text } from "react-native";
import ReorderableList from "react-native-reorderable-list";

jest.mock(
  "react-native-reanimated",
  () => require("@test/ui/reanimated-list-stub").reanimatedListStub
);

it("renders two items with the installed reorderable list", async () => {
  const view = await renderWithProviders(
    <ReorderableList
      data={["CPU", "Memory"]}
      keyExtractor={(item) => item}
      onReorder={() => {}}
      renderItem={({ item }) => <Text>{item}</Text>}
    />
  );

  expect(view.getByText("CPU")).toBeVisible();
  expect(view.getByText("Memory")).toBeVisible();
});
