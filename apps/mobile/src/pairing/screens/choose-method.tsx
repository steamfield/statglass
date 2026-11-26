import { SetupGuidance } from "@/pairing/help/setup-guidance";
import { Button } from "@/ui/button";
import { PairingStep } from "./pairing-step";

export function ChooseMethod({ scan, paste }: { scan(): void; paste(): void }) {
  return (
    <PairingStep
      title="Get a pairing code"
      explanation="Create the code on a Mac running StatGlass to add it and the hosts it monitors, or on a Linux host running the agent."
      actions={
        <>
          <Button label="Scan QR" onPress={scan} />
          <Button label="Paste code" variant="secondary" onPress={paste} />
        </>
      }
    >
      <SetupGuidance />
    </PairingStep>
  );
}
