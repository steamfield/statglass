import { Stack } from "expo-router";
import { PairScreen } from "@/pairing";

export default function Pair() {
  return (
    <>
      <Stack.Screen
        options={{
          title: "Add a host",
          headerBackButtonDisplayMode: "minimal",
        }}
      />
      <PairScreen />
    </>
  );
}
