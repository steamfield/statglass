import { timeTicks, valueTicks } from "@core/chart-math/axis-ticks";
import { formatPercent, MISSING } from "@core/format";
import {
  FIXTURE_T_END,
  POPOVER_CPU_STREAM,
  seededWalk,
} from "@core/widget-models/fixtures/charts";
import {
  HEAT_MATRIX_FIXTURE,
  RING_GAUGE_FIXTURES,
} from "@core/widget-models/fixtures/heat-ring";
import { heatMatrixModel } from "@core/widget-models/heat-matrix";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import { ringGaugeModel } from "@core/widget-models/ring-gauge";
import { Redirect, router, Stack } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { ScrollViewContainer } from "react-native-reorderable-list";
import { BackButton, useAccessibilityEscape } from "@/ui/back-button";
import { DemoBadge } from "@/ui/demo-badge";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { HeaderButton } from "@/ui/header-button";
import { Icon } from "@/ui/icons";
import { ListRow } from "@/ui/list-row";
import { ReorderList } from "@/ui/reorder-list";
import { screenOptions } from "@/ui/screen-options";
import { ScreenScroll } from "@/ui/screen-scroll";
import { SegmentedControl } from "@/ui/segmented-control";
import { Sheet } from "@/ui/sheet";
import { SwipeRow } from "@/ui/swipe-row";
import { Text, type TextVariant } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";
import { HeatMatrix } from "@/widgets/heat-matrix";
import { RingGauge } from "@/widgets/ring-gauge";
import { Sparkbars } from "@/widgets/sparkbars";
import { StreamArea } from "@/widgets/stream-area";

const TEXT_SAMPLES = {
  largeTitle: "Large title · 34 pt",
  title: "Title · 22 pt",
  onboardingTitle: "Onboarding title · 28 pt",
  cardTitle: "Card title · 13 pt",
  cardFigure: "15.0",
  heroFigure: "28.0",
  body: "Body · 17 pt",
  label: "Label · 13 pt",
  value: "13.0",
  caption: "Caption · 12 pt",
  axis: "11.0",
} satisfies Record<TextVariant, string>;

const SEGMENTS = [
  { value: "5m", label: "5 min" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
] as const;

const NETWORK: MirrorBarsData = {
  up: [12, 7, 16, null, 3, 9],
  down: [75, 15, 40, null, 50, 32],
  upMax: 16,
  downMax: 75,
  intervalMs: 1000,
  accent: "net",
  ariaLabel: "Network sparkbars",
};

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

function PrimitivesGallery() {
  const colors = useThemeColors();
  const { onAccessibilityEscape } = useAccessibilityEscape(goBack);
  const [sheetVisible, showSheet] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <ScreenScroll className="bg-background">
      <Stack.Screen
        options={{ ...screenOptions(colors), title: "Primitives" }}
      />
      <View
        onAccessibilityEscape={onAccessibilityEscape}
        className="gap-6 px-4 pt-4 pb-safe"
      >
        <View className="flex-row flex-wrap items-center gap-4">
          <View className="min-h-11 min-w-11 items-center justify-center border border-border">
            <BackButton onPress={goBack} />
          </View>
          <View className="min-h-11 min-w-11 items-center justify-center border border-border">
            <HeaderButton
              icon="gearshape"
              accessibilityLabel="Settings"
              onPress={() => showSheet(true)}
            />
          </View>
          <Icon name="server.rack" />
          <DemoBadge onExit={() => setNotice("Exited demo")} />
        </View>
        <TypeSamples />
        <ListSamples onRemove={() => setNotice("Removed Mac mini")} />
        <Interactions
          onRelease={(id) => setNotice(`Released ${id}`)}
          openSheet={() => showSheet(true)}
        />
        {notice && (
          <Text variant="caption" accessibilityLiveRegion="polite">
            {notice}
          </Text>
        )}
        <Sheet
          title="Preview sheet"
          visible={sheetVisible}
          onClose={() => showSheet(false)}
        >
          <Text variant="body">History range</Text>
        </Sheet>
        <ChartSamples />
      </View>
    </ScreenScroll>
  );
}

function TypeSamples() {
  return (
    <View className="gap-1">
      {(Object.keys(TEXT_SAMPLES) as TextVariant[]).map((variant) => (
        <Text key={variant} variant={variant}>
          {TEXT_SAMPLES[variant]}
        </Text>
      ))}
    </View>
  );
}

function ListSamples({ onRemove }: { onRemove(): void }) {
  return (
    <ListSection title="Grouped list" footer="Example settings">
      <GroupedList>
        <ListRow title="Plain row" />
        <ListRow title="Version" value="1.0" />
        <ListRow title="System appearance" accessory="checkmark" selected />
        <ListRow title="This iPhone" glyph="apple.logo" accessory="chevron" />
        <ListRow title="Remove host" destructive />
        <SwipeRow actionLabel="Remove" onAction={onRemove}>
          <ListRow title="Mac mini" subtitle="Swipe to remove" />
        </SwipeRow>
      </GroupedList>
    </ListSection>
  );
}

function Interactions({
  onRelease,
  openSheet,
}: {
  onRelease(id: string): void;
  openSheet(): void;
}) {
  const [order, setOrder] = useState([
    "CPU",
    "Memory",
    "GPU",
    "Network",
    "Battery",
  ]);
  const [segment, setSegment] =
    useState<(typeof SEGMENTS)[number]["value"]>("5m");
  return (
    <View className="gap-3">
      <ScrollViewContainer scrollEnabled={false}>
        <ReorderList
          data={order}
          keyOf={(item) => item}
          itemLabel={(item) => item}
          nested
          renderItem={({ item }) => <ListRow title={item} />}
          onReorder={setOrder}
          onReleaseWithoutMove={onRelease}
        />
      </ScrollViewContainer>
      <SegmentedControl<(typeof SEGMENTS)[number]["value"]>
        segments={SEGMENTS}
        value={segment}
        onChange={setSegment}
        accessibilityLabel="Range"
      />
      <Pressable
        className="min-h-11 min-w-11 justify-center"
        accessibilityRole="button"
        onPress={openSheet}
      >
        <Text variant="body" className="text-link">
          Open sheet
        </Text>
      </Pressable>
    </View>
  );
}

function ChartSamples() {
  const ticks = [
    ...valueTicks(POPOVER_CPU_STREAM.yMax, formatPercent),
    ...timeTicks(FIXTURE_T_END - 300_000, FIXTURE_T_END, 300, {
      clockOffsetMs: 0,
      nowMs: FIXTURE_T_END,
    }),
  ];
  return (
    <View className="gap-3">
      <Text variant="cardTitle">Axis ticks</Text>
      <Text variant="axis">
        {ticks.map(({ label }) => label).join(" · ") || MISSING}
      </Text>
      <StreamArea {...POPOVER_CPU_STREAM} variant="spark" height={36} />
      <StreamArea
        {...POPOVER_CPU_STREAM}
        variant="spark"
        series={[
          { key: "mem.used", values: seededWalk(60, 19, 23, 5), step: 1 },
        ]}
        height={36}
        accent="mem"
        ariaLabel="Memory, last 60 seconds"
      />
      <Sparkbars
        data={NETWORK}
        height={36}
        accessibilityLabel={NETWORK.ariaLabel}
      />
      <HeatMatrix model={heatMatrixModel(HEAT_MATRIX_FIXTURE)} height={80} />
      <View className="flex-row flex-wrap gap-3">
        {RING_GAUGE_FIXTURES.map(({ input, geometry, size }) => (
          <RingGauge
            key={input.label}
            model={ringGaugeModel(input, geometry)}
            size={size}
          />
        ))}
      </View>
    </View>
  );
}

export default function PrimitivesRoute() {
  return __DEV__ ? <PrimitivesGallery /> : <Redirect href="/" />;
}
