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

export function PairingDialog({
  onPaired,
  open: controlledOpen,
  onOpenChange,
  onCloseAutoFocus,
}: {
  onPaired: () => void;
  onCloseAutoFocus?: (event: Event) => void;
} & (
  | { open?: never; onOpenChange?: never }
  | { open: boolean; onOpenChange: (open: boolean) => void }
)) {
  const transport = useTransport();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const changeOpen = onOpenChange ?? setLocalOpen;
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

  useEffect(
    () =>
      transport.onWindowVisibility((visible) => {
        if (!visible && attempt.current) {
          close();
          changeOpen(false);
        }
      }),
    [transport, close, changeOpen]
  );

  useEffect(() => {
    setOffer(null);
    setFailure(null);
    if (!open) return;
    const opening: NonNullable<typeof attempt.current> = { nonce: null };
    attempt.current = opening;
    const start = async () => {
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
        if (attempt.current === opening) setFailure({ cause });
      }
    };
    void start();
    return close;
  }, [open, transport, cancel, close]);

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {controlledOpen === undefined && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Pair iPhone
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm"
        onCloseAutoFocus={onCloseAutoFocus}
      >
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
