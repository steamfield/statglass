import type { HostRecord } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import { failureReason, remoteErrorText } from "@core/remote-errors";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { ActionButton } from "@/components/action-button";
import { useHostListUpdates } from "@/data/hosts";
import { useHosts } from "@/data/hosts-list";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { usePhoneTransport } from "@/data/transport-context";
import { isNativeTransport } from "@/transport";
import { Text } from "@/ui/text";

type HostEdit = { host: HostRecord; kind: "rename" | "remove" };

/** Renames, reorders and removes hosts on this phone. */
export function HostSettings() {
  useHostListUpdates();
  const hosts = useHosts();
  const names = usePhoneSettings((s) => s.hostNames);
  const { set } = usePhoneSettingsActions();
  const transport = usePhoneTransport();
  const cache = useQueryClient();
  const [edit, setEdit] = useState<HostEdit | null>(null);

  function move(from: number, change: -1 | 1) {
    const order = hosts.data?.map((host) => host.id) ?? [];
    const to = from + change;
    const id = order[from];
    const adjacent = order[to];
    if (id === undefined || adjacent === undefined) return;
    order[from] = adjacent;
    order[to] = id;
    set({ hostOrder: order });
  }

  async function remove(host: HostRecord) {
    if (!isNativeTransport(transport)) {
      set(({ removed }) => ({ removed: [...removed, host.id] }));
      return null;
    }
    const result = await transport.removeHost(host.id);
    if (result.status === "error") return remoteErrorText(result.error);
    set((current) => {
      const hostNames = { ...current.hostNames };
      delete hostNames[host.id];
      return {
        hostNames,
        hostOrder: current.hostOrder.filter((id) => id !== host.id),
      };
    });
    cache.setQueryData<HostRecord[]>(hostKeys.list(), (current) =>
      current?.filter(({ id }) => id !== host.id)
    );
    void cache.invalidateQueries({ queryKey: hostKeys.all });
    return null;
  }

  return (
    <>
      <ScrollView
        accessibilityElementsHidden={edit !== null}
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View className="gap-2 px-4 pt-2 pb-safe-or-4">
          {hosts.isPending && <Text role="body">Loading hosts…</Text>}
          {hosts.isError && (
            <Text
              role="body"
              accessibilityRole="alert"
              className="text-destructive!"
            >
              Couldn’t load hosts.{" "}
              {failureReason(hosts.error, "Return to Hosts and try again.")}
            </Text>
          )}
          {hosts.isSuccess && hosts.data.length === 0 && (
            <Text role="body">No hosts on this iPhone.</Text>
          )}
          {hosts.data?.map((host, index, list) => (
            <View
              key={host.id}
              className="rounded-xl border border-border bg-card px-3 pt-3 pb-1"
            >
              <Text role="cardTitle">{host.display_name}</Text>
              <View className="flex-row flex-wrap items-center">
                <EditButton
                  label={`Rename ${host.display_name}`}
                  onPress={() => setEdit({ host, kind: "rename" })}
                >
                  Rename
                </EditButton>
                <EditButton
                  label={`Move ${host.display_name} up`}
                  disabled={index === 0}
                  onPress={() => move(index, -1)}
                >
                  ↑
                </EditButton>
                <EditButton
                  label={`Move ${host.display_name} down`}
                  disabled={index === list.length - 1}
                  onPress={() => move(index, 1)}
                >
                  ↓
                </EditButton>
                <EditButton
                  label={`Remove ${host.display_name}`}
                  onPress={() => setEdit({ host, kind: "remove" })}
                >
                  Remove
                </EditButton>
              </View>
            </View>
          ))}
          <ActionButton label="Add a host" href="/pair" weight="primary" />
          <ActionButton
            label="Update from Mac"
            href="/update-from-mac"
            weight="secondary"
          />
        </View>
      </ScrollView>
      {edit && (
        <HostEditSheet
          key={edit.host.id}
          edit={edit}
          onClose={() => setEdit(null)}
          onRename={(name) =>
            set({ hostNames: { ...names, [edit.host.id]: name } })
          }
          onRemove={() => remove(edit.host)}
        />
      )}
    </>
  );
}

function EditButton({
  children,
  label,
  disabled = false,
  destructive = false,
  onPress,
}: {
  children: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-[44px] min-w-[44px] items-center justify-center px-2 py-2 active:opacity-70 ${disabled ? "opacity-40" : ""}`}
    >
      <Text
        role="body"
        className={destructive ? "text-destructive!" : "text-link"}
      >
        {children}
      </Text>
    </Pressable>
  );
}

function HostEditSheet({
  edit,
  onClose,
  onRename,
  onRemove,
}: {
  edit: HostEdit;
  onClose: () => void;
  onRename: (name: string) => void;
  onRemove: () => Promise<string | null>;
}) {
  const [name, setName] = useState(edit.host.display_name);
  const [invalid, setInvalid] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const inFlight = useRef(false);
  const rename = edit.kind === "rename";

  function save() {
    const trimmed = name.trim();
    if (!trimmed || [...trimmed].length > 64) {
      setInvalid(true);
      return;
    }
    onRename(trimmed);
    onClose();
  }

  async function remove() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRemoving(true);
    setRemoveError(null);
    const error = await onRemove();
    inFlight.current = false;
    setRemoving(false);
    if (error) setRemoveError(error);
    else onClose();
  }

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="absolute inset-0 justify-end bg-overlay"
      accessibilityViewIsModal
      onAccessibilityEscape={removing ? undefined : onClose}
    >
      <ScrollView
        bounces={false}
        keyboardShouldPersistTaps="handled"
        className="max-h-full grow-0 rounded-t-2xl border border-border bg-card"
      >
        <View className="gap-3 px-5 pt-5 pb-safe-or-5">
          <Text role="title">
            {rename ? "Rename host" : `Remove ${edit.host.display_name}?`}
          </Text>
          {rename ? (
            <>
              <Text role="label">Name on this iPhone</Text>
              <TextInput
                accessibilityLabel="Name on this iPhone"
                value={name}
                onChangeText={(value) => {
                  setName(value);
                  setInvalid(false);
                }}
                onSubmitEditing={save}
                returnKeyType="done"
                className="min-h-[44px] rounded-lg border border-input bg-card px-3 py-2 text-[17px] text-foreground"
              />
              {invalid && (
                <Text
                  role="caption"
                  accessibilityRole="alert"
                  className="text-destructive!"
                >
                  Enter a name between 1 and 64 characters.
                </Text>
              )}
            </>
          ) : (
            <Text role="body">
              This removes the host from this iPhone’s list.
            </Text>
          )}
          {removeError && (
            <Text
              role="caption"
              accessibilityRole="alert"
              className="text-destructive!"
            >
              {removeError}
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            <EditButton label="Cancel" disabled={removing} onPress={onClose}>
              Cancel
            </EditButton>
            {rename ? (
              <EditButton label="Save name" onPress={save}>
                Save name
              </EditButton>
            ) : (
              <EditButton
                label="Remove host"
                destructive
                disabled={removing}
                onPress={() => void remove()}
              >
                {removing ? "Removing…" : "Remove host"}
              </EditButton>
            )}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
