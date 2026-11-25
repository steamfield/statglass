import type { Accent } from "@core/widget-models/tokens";
import { createContext } from "react";

/** The module accent inherited by bars and swatches without an explicit accent. */
export const WidgetAccent = createContext<Accent | undefined>(undefined);
