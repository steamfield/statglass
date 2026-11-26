import { commandErrorText } from "@core/command-error";
import { unwrap } from "@core/transport";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { useTransport } from "~/lib/transport-context";

import { HostLists } from "./handover-host-lists";
import { PairingQr } from "./pairing-offer-view";

function OfferError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <InlineMessage tone="error">{message}</InlineMessage>
      <Button variant="outline" size="sm" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

export function UpdateFromMac({
  open: controlledOpen,
  onOpenChange,
  onCloseAutoFocus,
}: {
  onCloseAutoFocus?: (event: Event) => void;
} & (
  | { open?: never; onOpenChange?: never }
  | { open: boolean; onOpenChange: (open: boolean) => void }
)) {
  const transport = useTransport();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const offer = useMutation({
    mutationFn: () => unwrap(transport.handoverBundleStart()),
    networkMode: "always",
  });
  const { mutate, reset } = offer;
  useEffect(() => {
    if (!open) return;
    mutate();
    return reset;
  }, [open, mutate, reset]);

  const dialog = (
    <Dialog open={open} onOpenChange={onOpenChange ?? setLocalOpen}>
      {controlledOpen === undefined && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Update iPhone
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Update iPhone</DialogTitle>
          <DialogDescription>
            On your iPhone, open Update from Mac in StatGlass and scan this
            code.
          </DialogDescription>
        </DialogHeader>
        {offer.data ? (
          <>
            <PairingQr
              source={offer.data.qr_svg}
              label="iPhone update QR code"
              fallback={
                <OfferError
                  message="Couldn’t display the update QR code."
                  retry={() => offer.mutate()}
                />
              }
            />
            <HostLists
              hosts={offer.data.hosts}
              unavailable={offer.data.unavailable}
            />
          </>
        ) : offer.isError ? (
          <OfferError
            message={commandErrorText(
              offer.error,
              "Couldn’t prepare the update."
            )}
            retry={() => offer.mutate()}
          />
        ) : (
          <InlineMessage tone="status">Preparing update code…</InlineMessage>
        )}
      </DialogContent>
    </Dialog>
  );
  return controlledOpen !== undefined ? (
    dialog
  ) : (
    // Settings' Access tab row; the id is its Settings catalog row.
    <SettingsRow
      id="iphone-host-list"
      label="Host list on iPhone"
      sub="Share the list of hosts this Mac monitors."
    >
      {dialog}
    </SettingsRow>
  );
}
