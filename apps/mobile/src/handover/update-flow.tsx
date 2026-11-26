import { commandErrorText } from "@core/command-error";
import type { BundleReconcile, HostRecord } from "@core/generated/types";
import { unwrap } from "@core/transport/query";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator } from "react-native";
import type { CameraStep } from "@/pairing/flow";
import { Paste } from "@/pairing/screens/paste";
import { Scanner } from "@/pairing/screens/scanner";
import { Button } from "@/ui/button";
import { Text } from "@/ui/text";
import type { HandoverTransport } from "./apply";
import { UpdateSelection } from "./update-selection";

const UPDATE_CODE = {
  prefix: "SGB1:",
  title: "Scan an update code",
  instructions:
    "Allow camera access to scan the Update iPhone code on your Mac.",
  unavailable: "Paste the Update iPhone code from your Mac to continue.",
  denied:
    "Allow camera access for StatGlass in Settings to scan an update code.",
  label: "Update iPhone QR scanner",
};
const UPDATE_PASTE = {
  label: "Update iPhone code",
  instructions: "Paste the full Update iPhone code from StatGlass on your Mac.",
  empty: "Paste an Update iPhone code to continue.",
  submit: "Review updates",
};

type Method = "scan" | "paste";
type Preview = { diff: BundleReconcile; roster: HostRecord[] };

export function UpdateFlow({
  core,
  done,
}: {
  core: HandoverTransport;
  done(applied: boolean): void;
}) {
  const [method, setMethod] = useState<Method | null>(null);
  const [camera, setCamera] = useState<CameraStep>("priming");
  const [scanAttempt, setScanAttempt] = useState(0);
  const decode = useMutation({
    async mutationFn(text: string): Promise<Preview> {
      const diff = await unwrap(core.handover.decodeBundle(text));
      return { diff, roster: await core.listHosts() };
    },
  });

  function choose(next: Method | null) {
    decode.reset();
    setCamera("priming");
    setMethod(next);
  }

  if (decode.isSuccess) {
    return (
      <UpdateSelection
        core={core}
        {...decode.data}
        cancel={() => choose(null)}
        done={done}
      />
    );
  }
  const status = decode.isPending ? (
    <ActivityIndicator accessibilityLabel="Reading update code" />
  ) : (
    decode.isError && (
      <Text variant="body" accessibilityRole="alert" tone="destructive">
        {commandErrorText(
          decode.error,
          "Couldn’t read the update code. Try again."
        )}
      </Text>
    )
  );
  switch (method) {
    case "scan":
      return (
        <>
          {status}
          {decode.isError && (
            <Button
              label="Scan again"
              onPress={() => {
                choose("scan");
                setScanAttempt((attempt) => attempt + 1);
              }}
            />
          )}
          <Scanner
            key={scanAttempt}
            code={UPDATE_CODE}
            camera={camera}
            setCamera={setCamera}
            inspect={decode.mutate}
            paste={() => choose("paste")}
            cancel={() => choose(null)}
          />
        </>
      );
    case "paste":
      return (
        <>
          {status}
          <Paste
            checking={decode.isPending}
            copy={UPDATE_PASTE}
            inspect={decode.mutate}
            cancel={() => choose(null)}
          />
        </>
      );
    default:
      return (
        <>
          <Text variant="body">
            Open Update iPhone in StatGlass Settings on your Mac.
          </Text>
          <Button label="Scan QR" onPress={() => choose("scan")} />
          <Button
            label="Paste code"
            variant="secondary"
            onPress={() => choose("paste")}
          />
          <Button
            label="Cancel"
            variant="secondary"
            onPress={() => done(false)}
          />
        </>
      );
  }
}
