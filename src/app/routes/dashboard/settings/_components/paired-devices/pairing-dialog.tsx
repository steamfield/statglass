import type { PairingOffer } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { PairingErrorMessage, PairingOfferView } from "./pairing-offer-view";

export function PairingDialog({ onPaired }: { onPaired: () => void }) {
  const transport = useTransport();
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const attempt = useRef<{ nonce: string | null } | null>(null);

  const cancel = useCallback(
    (nonce: string) =>
      void unwrap(transport.pairingCancel(nonce)).catch((cause: unknown) => {
        console.error("[pairing] Couldn’t cancel offer", cause);
      }),
    [transport]
  );
  const close = useCallback(() => {
    const nonce = attempt.current?.nonce;
    attempt.current = null;
    if (nonce) cancel(nonce);
  }, [cancel]);

  useEffect(() => close, [close]);
  useEffect(
    () =>
      transport.onWindowVisibility((visible) => {
        if (!visible && attempt.current) {
          close();
          setOpen(false);
        }
      }),
    [transport, close]
  );

  const start = async () => {
    const opening: NonNullable<typeof attempt.current> = { nonce: null };
    attempt.current = opening;
    setOffer(null);
    setFailure(null);
    try {
      const offer = await unwrap(transport.pairingStart());
      if (attempt.current === opening) {
        opening.nonce = offer.nonce;
        setOffer(offer);
      } else {
        // Closing during preflight still withdraws the offer as soon as it arrives.
        cancel(offer.nonce);
      }
    } catch (cause) {
      if (attempt.current === opening) {
        setFailure({ cause });
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void start();
        else close();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Pair iPhone
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pair iPhone</DialogTitle>
        </DialogHeader>
        {open &&
          (offer ? (
            <PairingOfferView
              key={offer.nonce}
              offer={offer}
              onPaired={onPaired}
            />
          ) : failure ? (
            <DialogDescription asChild>
              <div>
                <PairingErrorMessage
                  cause={failure.cause}
                  fallback="Couldn’t start pairing."
                />
              </div>
            </DialogDescription>
          ) : (
            <DialogDescription asChild>
              <p role="status">Preparing pairing code…</p>
            </DialogDescription>
          ))}
      </DialogContent>
    </Dialog>
  );
}
