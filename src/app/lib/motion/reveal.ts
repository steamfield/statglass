import { useState } from "react";
import styles from "./motion.module.css";

/**
 * Class for a chart's data layer: empty until the chart has been loading and
 * then stopped, when it plays the one-shot settle from the baseline. The class
 * stays on through later ticks, so they do not replay the animation; a chart
 * mounted with its data never gets it.
 *
 * "Has been loading" is state, not a ref: a render React throws away (a chart
 * under `useDeferredValue`) must not leave it set.
 */
export function useReveal(loading: boolean | undefined): string {
  const [seen, setSeen] = useState(loading === true);
  if (loading && !seen) setSeen(true);
  return seen && !loading ? (styles.reveal ?? "") : "";
}
