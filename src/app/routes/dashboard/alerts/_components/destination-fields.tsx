/**
 * The destination dialog's form: its state (`DestinationForm`), the
 * conversions to and from a `Destination`, and the fields that render it.
 * The fields report each edit as the next form.
 */
import { generateTopic, newDestination } from "@core/alert-destinations";
import type { Destination } from "@core/generated/bindings";
import { type ReactNode, useId } from "react";
import { InlineMessage } from "~/components/inline-message";
import { SegmentedControl } from "~/components/segmented-control";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";

/**
 * What the dialog edits: the name, the chosen kind, and the fields of both
 * kinds, so switching kind and back loses nothing typed.
 */
export interface DestinationForm {
  id: string;
  enabled: boolean;
  name: string;
  kind: "ntfy" | "webhook";
  server: string;
  topic: string;
  /** Empty means no token. */
  token: string;
  url: string;
}

/** The form a destination opens with; the other kind starts at its defaults. */
export function formFromDestination(d: Destination): DestinationForm {
  const form: DestinationForm = {
    id: d.id,
    enabled: d.enabled,
    name: d.name,
    kind: d.kind.type,
    server: defaultServer(),
    topic: "",
    token: "",
    url: "",
  };
  if (d.kind.type === "webhook") return { ...form, url: d.kind.url };
  const { server, topic, token } = d.kind;
  return { ...form, server, topic, token: token ?? "" };
}

/** The server a new ntfy destination starts on, as `newDestination` sets it. */
function defaultServer(): string {
  const { kind } = newDestination("ntfy", "");
  return kind.type === "ntfy" ? kind.server : "";
}

/**
 * The destination the form describes, with only the chosen kind's fields
 * and the name trimmed (Rust refuses surrounding spaces).
 */
export function destinationFromForm(form: DestinationForm): Destination {
  const base = { id: form.id, name: form.name.trim(), enabled: form.enabled };
  if (form.kind === "webhook") {
    return { ...base, kind: { type: "webhook", url: form.url } };
  }
  return {
    ...base,
    kind: {
      type: "ntfy",
      server: form.server,
      topic: form.topic,
      token: form.token === "" ? null : form.token,
    },
  };
}

/** Props of `DestinationFields`. */
export interface DestinationFieldsProps {
  form: DestinationForm;
  /** The topic an existing ntfy destination is saved with; null when new. */
  savedTopic: string | null;
  /** The form after one edit. */
  onChange: (form: DestinationForm) => void;
}

const TEXT_INPUT =
  "h-8 rounded-control border border-input bg-background px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring";

const KINDS = [
  { value: "ntfy", label: "ntfy" },
  { value: "webhook", label: "Webhook" },
] as const;

/** Lines on subscribing from the phone, under the ntfy fields. */
const PHONE_STEPS = [
  "Install the ntfy app",
  "Subscribe to this topic",
  "Send a test",
] as const;

/**
 * A "Delivery" panel: "Kind" (ntfy, Webhook) and "Name", then the kind's
 * fields. ntfy adds "Server", "Topic" with "Generate" and "Access token" (a
 * password input), with the phone steps under the panel and, once the
 * topic differs from `savedTopic`, a note that the phone must subscribe
 * again; a webhook adds "URL".
 */
export function DestinationFields({
  form,
  savedTopic,
  onChange,
}: DestinationFieldsProps): ReactNode {
  const id = useId();
  const isNtfy = form.kind === "ntfy";
  const moved = savedTopic !== null && form.topic !== savedTopic;
  const after = isNtfy && <PhoneSteps topicMoved={moved} />;
  return (
    <SettingsPanel title="Delivery" after={after}>
      <SettingsRow label="Kind">
        <SegmentedControl
          ariaLabel="Kind"
          options={KINDS}
          value={form.kind}
          onChange={(kind) => onChange({ ...form, kind })}
        />
      </SettingsRow>
      <SettingsRow label="Name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={`${TEXT_INPUT} w-full max-w-72`}
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
      </SettingsRow>
      {isNtfy ? (
        <NtfyRows form={form} onChange={onChange} />
      ) : (
        <SettingsRow label="URL" htmlFor={`${id}-url`}>
          <input
            id={`${id}-url`}
            className={`${TEXT_INPUT} w-full max-w-80`}
            placeholder="https://"
            value={form.url}
            onChange={(e) => onChange({ ...form, url: e.target.value })}
          />
        </SettingsRow>
      )}
    </SettingsPanel>
  );
}

/** Server, topic with "Generate", and the optional access token. */
function NtfyRows({
  form,
  onChange,
}: Pick<DestinationFieldsProps, "form" | "onChange">) {
  const id = useId();
  const generate = () =>
    onChange({
      ...form,
      topic: generateTopic((n) => crypto.getRandomValues(new Uint8Array(n))),
    });
  return (
    <>
      <SettingsRow label="Server" htmlFor={`${id}-server`}>
        <input
          id={`${id}-server`}
          className={`${TEXT_INPUT} w-full max-w-72`}
          value={form.server}
          onChange={(e) => onChange({ ...form, server: e.target.value })}
        />
      </SettingsRow>
      <SettingsRow label="Topic" htmlFor={`${id}-topic`}>
        <div className="flex w-full max-w-72 items-center gap-2">
          <input
            id={`${id}-topic`}
            className={`${TEXT_INPUT} min-w-0 flex-1`}
            value={form.topic}
            onChange={(e) => onChange({ ...form, topic: e.target.value })}
          />
          <Button variant="outline" size="sm" onClick={generate}>
            Generate
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Access token"
        sub="Only for a protected topic"
        htmlFor={`${id}-token`}
      >
        <input
          id={`${id}-token`}
          type="password"
          autoComplete="off"
          className={`${TEXT_INPUT} w-full max-w-72`}
          value={form.token}
          onChange={(e) => onChange({ ...form, token: e.target.value })}
        />
      </SettingsRow>
    </>
  );
}

/**
 * The three steps to receive alerts on a phone, as plain numbered lines,
 * after a note when the topic has moved: a phone still on the old topic
 * gets nothing once this is saved.
 */
function PhoneSteps({ topicMoved }: { topicMoved: boolean }) {
  return (
    <>
      {topicMoved && (
        <InlineMessage tone="note">
          Your phone needs to subscribe to the new topic.
        </InlineMessage>
      )}
      <ol className="m-0 list-decimal pl-5 text-muted-foreground text-small">
        {PHONE_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </>
  );
}
