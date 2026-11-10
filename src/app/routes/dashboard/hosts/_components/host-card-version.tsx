import type { HostVersionState } from "@core/remote-hosts";
import { ArrowUpCircle, CircleCheck, OctagonAlert } from "lucide-react";
import { TruncatedText } from "~/components/truncated-text";
import { useTransport } from "~/lib/transport-context";
import { MeterTrack } from "~/widgets/meter-track";

export function HostCardVersion({ version }: { version: HostVersionState }) {
  const transport = useTransport();
  const notes = version.notes;
  const Icon =
    version.icon === "check"
      ? CircleCheck
      : version.icon === "up"
        ? ArrowUpCircle
        : version.icon === "error"
          ? OctagonAlert
          : null;
  const upload =
    version.progress?.kind === "uploading" ? version.progress : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className={`flex min-w-0 items-center gap-1.5 text-small ${version.kind === "failed" ? "text-destructive" : "text-fg-subtle"}`}
      >
        {Icon && <Icon aria-hidden className="size-3 shrink-0" />}
        <TruncatedText text={version.text} className="figures min-w-0" />
        {notes && (
          <button
            type="button"
            className="shrink-0 rounded-chip text-link outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              void transport.openUrl(notes).catch((error: unknown) =>
                console.error("[hosts] opening release notes failed", {
                  url: notes,
                  error,
                })
              )
            }
          >
            What’s new
          </button>
        )}
      </div>
      {version.progress && (
        <div
          role="progressbar"
          aria-label={version.text}
          {...(upload
            ? {
                "aria-valuemin": 0,
                "aria-valuenow": upload.sent_bytes,
                "aria-valuemax": upload.total_bytes,
              }
            : {})}
        >
          <MeterTrack
            fraction={
              upload && upload.total_bytes > 0
                ? upload.sent_bytes / upload.total_bytes
                : 1
            }
            fill="var(--color-cpu)"
            className={upload ? "" : "opacity-30"}
          />
        </div>
      )}
    </div>
  );
}
