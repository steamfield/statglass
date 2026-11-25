import type { HostRecord } from "@core/generated/types";
import { failureReason } from "@core/remote-errors";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useHostListUpdates } from "@/data/hosts";
import { useHosts } from "@/data/hosts-list";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { Text } from "@/ui/text";

type HostEdit = { host: HostRecord; kind: "rename" | "remove" };

/** Renames, reorders and hides hosts on this phone. */
export function HostSettings() {
  useHostListUpdates();
  const hosts = useHosts();
  const names = usePhoneSettings((s) => s.hostNames);
  const removed = usePhoneSettings((s) => s.removed);
  const { set } = usePhoneSettingsActions();
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
          onRemove={() => set({ removed: [...removed, edit.host.id] })}
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
  onRemove: () => void;
}) {
  const [name, setName] = useState(edit.host.display_name);
  const [invalid, setInvalid] = useState(false);
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

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="absolute inset-0 justify-end bg-overlay"
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
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
          <View className="flex-row flex-wrap gap-2">
            <EditButton label="Cancel" onPress={onClose}>
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
                onPress={() => {
                  onRemove();
                  onClose();
                }}
              >
                Remove host
              </EditButton>
            )}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
