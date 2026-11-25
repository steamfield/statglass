import { commandError, commandErrorText } from "@core/command-error";
import type { PairingOffer, PairingStatus } from "@core/generated/types";
import { remoteErrorText } from "@core/remote-errors";
import { unwrap } from "@core/transport";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import { DialogDescription, DialogFooter } from "~/components/ui/dialog";
import { useTransport } from "~/lib/transport-context";

const POLL_MS = 1000;

function waiting(status: PairingStatus | undefined) {
  return !status || status.kind === "waiting" || status.kind === "pending";
}

function PairingQr({ source }: { source: string }) {
  const qr = useMemo(() => {
    // The installed app's image CSP excludes data URLs. Render the two paths
    // from the Rust QR renderer without inserting its markup into the page.
    const svg = new DOMParser().parseFromString(
      source,
      "image/svg+xml"
    ).documentElement;
    const viewBox = svg.getAttribute("viewBox");
    const [background, modules] = Array.from(
      svg.querySelectorAll("path"),
      (path) => path.getAttribute("d")
    );
    return svg.localName === "svg" && viewBox && background && modules
      ? { viewBox, background, modules }
      : null;
  }, [source]);

  return qr ? (
    <svg
      role="img"
      aria-label="Pairing QR code"
      className="mx-auto aspect-square w-full max-w-56"
      viewBox={qr.viewBox}
      shapeRendering="crispEdges"
    >
      <path fill="#fff" d={qr.background} />
      <path fill="#000" d={qr.modules} />
    </svg>
  ) : (
    <InlineMessage tone="error">
      Couldn’t display the pairing QR code.
    </InlineMessage>
  );
}

function Countdown({ seconds }: { seconds: number }) {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return (
    <p className="figures text-muted-foreground text-small">
      {seconds > 0
        ? `Expires in ${minutes}:${remainder}`
        : "Checking pairing status…"}
    </p>
  );
}

export function PairingErrorMessage({
  cause,
  fallback,
}: {
  cause: unknown;
  fallback: string;
}) {
  const error = commandError(cause);
  if (error?.kind !== "pairing") {
    return (
      <InlineMessage tone="error">
        {commandErrorText(cause, fallback)}
      </InlineMessage>
    );
  }

  const title = remoteErrorText({ ...error, message: "" });
  return (
    <InlineMessage tone="error">
      {title}
      {error.message && error.message !== title && (
        <span className="block">{error.message}</span>
      )}
    </InlineMessage>
  );
}

function PairingResult({ status }: { status: PairingStatus }) {
  switch (status.kind) {
    case "paired":
      return <InlineMessage tone="status">iPhone paired.</InlineMessage>;
    case "denied":
      return <InlineMessage tone="status">Pairing denied.</InlineMessage>;
    case "expired":
      return (
        <InlineMessage tone="status">
          Pairing expired. Open a new code to try again.
        </InlineMessage>
      );
    case "failed":
      return (
        <PairingErrorMessage
          cause={{ ...status, kind: "pairing" }}
          fallback="Couldn’t check pairing."
        />
      );
    default:
      return null;
  }
}

export function PairingOfferView({
  offer,
  onPaired,
}: {
  offer: PairingOffer;
  onPaired: () => void;
}) {
  const transport = useTransport();
  const client = useQueryClient();
  const nonce = offer.nonce;
  const statusKey = ["pairing-status", nonce];
  const [now, setNow] = useState(Date.now);
  const status = useQuery({
    queryKey: statusKey,
    queryFn: async () => {
      const result = await unwrap(transport.pairingStatus(nonce));
      if (result.kind === "paired") onPaired();
      return result;
    },
    refetchInterval: (query) => (waiting(query.state.data) ? POLL_MS : false),
    refetchIntervalInBackground: true,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: async (decision: "approve" | "deny") => {
      if (Date.now() >= offer.expires_ms)
        return unwrap(transport.pairingStatus(nonce));
      if (decision === "approve")
        return unwrap(transport.pairingApprove(nonce));
      return unwrap(transport.pairingDeny(nonce));
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: statusKey });
      client.setQueryData(statusKey, result);
      if (result.kind === "paired") onPaired();
    },
  });
  const current = status.data;
  const active = waiting(current);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  if (current && !active) {
    return (
      <DialogDescription asChild>
        <div>
          <PairingResult status={current} />
        </div>
      </DialogDescription>
    );
  }
  const seconds = Math.max(0, Math.ceil((offer.expires_ms - now) / 1000));
  const pending =
    !status.isError && current?.kind === "pending" ? current : null;
  return (
    <>
      <p role="status" className="sr-only">
        {pending && `${pending.device_name} is waiting for approval.`}
      </p>
      {pending ? (
        <div className="wrap-anywhere min-w-0">
          <p className="font-semibold text-body">{pending.device_name}</p>
          <p className="text-muted-foreground text-small">{pending.model}</p>
          <DialogDescription className="mt-3">
            Approve only if this code matches your iPhone.
          </DialogDescription>
        </div>
      ) : (
        <>
          <DialogDescription>
            Scan in StatGlass on your iPhone.
          </DialogDescription>
          <PairingQr source={offer.qr_svg} />
        </>
      )}
      <dl className="flex items-end justify-between gap-3">
        <div>
          <dt className="text-label text-muted-foreground">Pairing code</dt>
          <dd className="figures select-all font-semibold text-title">
            {pending?.code ?? offer.code}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Time remaining</dt>
          <dd>
            <Countdown seconds={seconds} />
          </dd>
        </div>
      </dl>
      {(decide.isError || status.isError) && (
        <PairingErrorMessage
          cause={status.error ?? decide.error}
          fallback="Couldn’t check pairing."
        />
      )}
      {pending && seconds > 0 && (
        <DialogFooter>
          <Button
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate("deny")}
          >
            Deny
          </Button>
          <Button
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve
          </Button>
        </DialogFooter>
      )}
    </>
  );
}
