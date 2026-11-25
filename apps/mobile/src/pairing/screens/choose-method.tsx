import { Text } from "@/ui/text";
import { PairAction } from "./action";

export function ChooseMethod({ scan, paste }: { scan(): void; paste(): void }) {
  return (
    <>
      <Text role="body">
        On a Mac, open StatGlass Settings and choose Pair iPhone under iPhone
        access. Or run sudo statglass-agent pair in a terminal on the host.
      </Text>
      <PairAction label="Scan QR" onPress={scan} />
      <PairAction label="Paste code" secondary onPress={paste} />
    </>
  );
}
