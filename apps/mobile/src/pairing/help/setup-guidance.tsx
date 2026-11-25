import { View } from "react-native";
import { Text } from "@/ui/text";

const releases = "https://github.com/steamfield/statglass/releases/latest";

export function SetupGuidance() {
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text variant="body">
          1. On a Mac, open StatGlass Settings and choose Pair iPhone under
          iPhone access. On Linux, run{" "}
          <Text variant="body" className="font-mono">
            sudo statglass-agent pair
          </Text>{" "}
          on the host.
        </Text>
        <Text variant="body">2. Scan the code or paste it.</Text>
        <Text variant="body">3. Approve on the host.</Text>
        <Text variant="body">4. Done.</Text>
      </View>
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
