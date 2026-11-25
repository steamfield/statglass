import { commandErrorText } from "@core/command-error";
import type { HandoverOffer } from "@core/generated/types";
import { handoverReasonText } from "@core/remote-errors";
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

function HostLists({
  hosts,
  unavailable,
}: Pick<HandoverOffer, "hosts" | "unavailable">) {
  const counts = new Map<string, number>();
  for (const host of hosts) counts.set(host, (counts.get(host) ?? 0) + 1);
  return (
    <>
      {hosts.length > 0 ? (
        <section className="space-y-1">
          <h3 className="font-semibold text-body">Included hosts</h3>
          <ul className="divide-y divide-border-subtle">
            {[...counts].map(([host, count]) => (
              <li key={host} className="wrap-anywhere py-1.5 text-body">
                {count === 1 ? host : `${host} (${count} hosts)`}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <InlineMessage tone="status">
          No other hosts are included.
        </InlineMessage>
      )}
      {unavailable.length > 0 && (
        <section className="space-y-1">
          <h3 className="font-semibold text-body">Unavailable hosts</h3>
          <ul className="divide-y divide-border-subtle">
            {unavailable.map((host) => (
              <li
                key={host.id}
                className="wrap-anywhere space-y-0.5 py-1.5 text-body"
              >
                <p>{host.name}</p>
                <InlineMessage tone="note">
                  {handoverReasonText(host.reason)}
                </InlineMessage>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
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
