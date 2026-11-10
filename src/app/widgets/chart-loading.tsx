import { cn } from "~/lib/utils";
import styles from "./chart-loading.module.css";

export interface ChartLoadingProps {
  /** Positions the 1 px track on the chart's baseline. */
  className?: string;
}

export function ChartLoading({ className }: ChartLoadingProps) {
  return (
    <span
      data-chart-loading
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute h-px overflow-hidden",
        className
      )}
    >
      <span className={styles.scan} />
    </span>
  );
}
