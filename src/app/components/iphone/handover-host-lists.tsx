import type { HandoverOffer } from "@core/generated/types";
import { handoverReasonText } from "@core/remote-errors";
import { InlineMessage } from "~/components/inline-message";

/** Lists the hosts a handover included and the ones it couldn't, with the reason for each. */
export function HostLists({
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
