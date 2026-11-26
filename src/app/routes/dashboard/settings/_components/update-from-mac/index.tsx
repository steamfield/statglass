import { commandErrorText } from "@core/command-error";
import { unwrap } from "@core/transport";
import { useMutation } from "@tanstack/react-query";
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

import { HostLists } from "../handover-host-lists";
import { PairingQr } from "../paired-devices/pairing-offer-view";

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

export function UpdateFromMac() {
  const transport = useTransport();
  const offer = useMutation({
    mutationFn: () => unwrap(transport.handoverBundleStart()),
  });
  return (
    <SettingsRow
      label="Host list on iPhone"
      sub="Share the list of hosts this Mac monitors."
    >
      <Dialog
        onOpenChange={(open) => {
          if (open) offer.mutate();
          else offer.reset();
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Update iPhone
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
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
    </SettingsRow>
  );
}
