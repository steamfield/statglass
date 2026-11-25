import { SetupGuidance } from "@/pairing/help/setup-guidance";
import { PairAction } from "./action";
import { PairingStep } from "./pairing-step";

export function ChooseMethod({ scan, paste }: { scan(): void; paste(): void }) {
  return (
    <PairingStep
      title="Get a pairing code"
      explanation="Create the code on the host you want to add."
      actions={
        <>
          <PairAction label="Scan QR" onPress={scan} />
          <PairAction label="Paste code" secondary onPress={paste} />
        </>
      }
    >
      <SetupGuidance />
    </PairingStep>
  );
}
