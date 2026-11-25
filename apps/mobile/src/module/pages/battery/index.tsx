import { GenericModulePage } from "@/module/pages/generic";
import type { ModulePageProps } from "@/module/pages/index";

/** Phase 12 scaffold: renders the generic page until its lane fills it in. */
export function BatteryPage(props: ModulePageProps) {
  return <GenericModulePage {...props} />;
}
