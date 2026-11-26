import { appKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { PairingDialog } from "~/components/iphone/pairing-dialog";
import { UpdateFromMac } from "~/components/iphone/update-from-mac";
import { Button } from "~/components/ui/button";
import { useTransport } from "~/lib/transport-context";

export function AddToIphone() {
  const transport = useTransport();
  const client = useQueryClient();
  const devices = useQuery({
    queryKey: appKeys.pairedDevices,
    queryFn: () => unwrap(transport.pairedDevices()),
    networkMode: "always",
  });
  const [dialog, setDialog] = useState<"pair" | "update" | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) setDialog(null);
  }, []);
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    buttonRef.current?.focus();
  };
  const openDialog = async () => {
    if (devices.isFetching) return;
    // Device keys can change outside this dashboard, so check before choosing.
    const latest = await devices.refetch({ cancelRefetch: false });
    setDialog(latest.isSuccess && latest.data.length > 0 ? "update" : "pair");
  };

  return (
    <>
      <Button
        ref={buttonRef}
        variant="outline"
        aria-haspopup="dialog"
        disabled={devices.isPending}
        aria-disabled={devices.isRefetching || undefined}
        className="aria-disabled:cursor-default aria-disabled:opacity-50"
        onClick={openDialog}
      >
        Add to iPhone
      </Button>
      <PairingDialog
        open={dialog === "pair"}
        onOpenChange={onOpenChange}
        onCloseAutoFocus={restoreFocus}
        onPaired={() =>
          void client.invalidateQueries({ queryKey: appKeys.pairedDevices })
        }
      />
      <UpdateFromMac
        open={dialog === "update"}
        onOpenChange={onOpenChange}
        onCloseAutoFocus={restoreFocus}
      />
    </>
  );
}
