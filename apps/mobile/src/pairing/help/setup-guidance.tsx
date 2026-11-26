import { View } from "react-native";
import { Text } from "@/ui/text";

const releases = "https://github.com/steamfield/statglass/releases/latest";

export function SetupGuidance() {
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text variant="body">
          1. On the Mac, open StatGlass Settings › Paired devices › Pair iPhone.
          The Mac also offers to share the other hosts it monitors.
        </Text>
        <Text variant="body">
          For a Linux host your Mac doesn't monitor or couldn't share, connect
          over SSH. Run{" "}
          <Text variant="body" className="font-mono">
            ~/.local/bin/statglass-agent pair
          </Text>{" "}
          as the user who installed the agent, or{" "}
          <Text variant="body" className="font-mono">
            sudo /usr/local/bin/statglass-agent pair
          </Text>{" "}
          for a system install.
        </Text>
        <Text variant="body">
          2. Scan the QR code shown on the Mac or printed in the Linux terminal,
          or paste the pairing text.
        </Text>
        <Text variant="body">3. Approve on the host.</Text>
        <Text variant="body">4. Done.</Text>
      </View>
      <Text variant="body">
        If you add more hosts on the Mac later, click Add to iPhone on the
        Mac&apos;s Hosts page, then choose Settings › Hosts › Update from Mac on
        your iPhone and scan the code.
      </Text>
      <View className="gap-2">
        <Text variant="title">Host doesn&apos;t have StatGlass yet?</Text>
        <Text variant="body">Download the latest Mac release.</Text>
        <Text variant="body" selectable>
          {releases}
        </Text>
        <Text variant="body">
          The Linux agent is installed from the Mac app (see the README&apos;s
          &quot;Monitor a Linux host&quot;).
        </Text>
      </View>
      <View className="gap-2">
        <Text variant="title">What the phone can see</Text>
        <Text variant="body">
          This iPhone gets a read-only, restricted key. It can see metrics and
          history, can&apos;t run commands, and you can revoke it from the host
          at any time.
        </Text>
      </View>
    </View>
  );
}
