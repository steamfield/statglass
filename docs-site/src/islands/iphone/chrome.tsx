import { type ReactNode, useState } from "react";
import styles from "./phone.module.css";

/** Glass circle buttons in the navigation bar, as iOS 26 draws them. */
const GLASS =
  "flex size-11 items-center justify-center rounded-full bg-white/10 text-foreground shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)] backdrop-blur-md";

export function BackButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      data-back=""
      aria-label={`Back to ${label}`}
      onClick={onPress}
      className={`${GLASS} ${styles.press}`}
    >
      <svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true">
        <path
          d="M10 2 2 10l8 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function GearButton() {
  return (
    <span className={GLASS} aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path
          d="m19.4 13.5.1-1.5-.1-1.5 2-1.6-2-3.4-2.4.9a8 8 0 0 0-2.6-1.5L14 2.4h-4l-.4 2.5A8 8 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6-.1 1.5.1 1.5-2 1.6 2 3.4 2.4-.9a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8 8 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function HostIcon({ kind }: { kind: "mac" | "linux" }) {
  return kind === "mac" ? (
    <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M13.2 9.6c0-2.3 1.9-3.4 2-3.5a4.3 4.3 0 0 0-3.4-1.8c-1.4-.2-2.8.8-3.5.8-.7 0-1.9-.8-3.1-.8A4.6 4.6 0 0 0 1.3 6.7C-.4 9.6.9 14 2.5 16.3c.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.2 2.8-2.3a10 10 0 0 0 1.3-2.6 4 4 0 0 1-2.3-4.1ZM10.9 2.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.6-1.3Z"
      />
    </svg>
  ) : (
    <svg
      width="18"
      height="16"
      viewBox="0 0 18 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width="16"
        height="6"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="1"
        y="9"
        width="16"
        height="6"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="4.5" cy="4" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="9"
      viewBox="0 0 14 9"
      aria-hidden="true"
      className={`text-muted-foreground transition-transform duration-(--motion-fast) ${open ? "rotate-180" : ""}`}
    >
      <path
        d="m1.5 1.5 5.5 6 5.5-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ScreenProps {
  title: string;
  /** Under the inline title (the CPU page's chip and core count). */
  subtitle?: string;
  /** A large title that collapses into the bar on scroll, or only the bar. */
  largeTitle?: boolean;
  left?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}

/**
 * One screen's scroll view with a UIKit navigation bar: the large title
 * scrolls away and its inline copy fades in as the bar turns to material.
 */
export function Screen({
  title,
  subtitle,
  largeTitle = true,
  left,
  right,
  children,
}: ScreenProps) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <div
      className={styles.scroll}
      onScroll={(event) => {
        const next = event.currentTarget.scrollTop > (largeTitle ? 40 : 2);
        if (next !== scrolled) setScrolled(next);
      }}
    >
      <div className={styles.navBar} data-scrolled={scrolled || undefined}>
        <div className="relative flex h-[52px] items-center justify-between px-4">
          <div className="flex min-w-11">{left}</div>
          <div
            className={`${styles.navTitle} pointer-events-none absolute inset-x-[72px] text-center`}
            data-always={largeTitle ? undefined : ""}
            aria-hidden={largeTitle || undefined}
          >
            <p className="truncate text-[17px] leading-[22px] font-semibold">
              {title}
            </p>
            {subtitle && (
              <p className="truncate text-[12px] leading-4 font-normal text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>
          <div className="flex min-w-11 justify-end">{right}</div>
        </div>
      </div>
      {largeTitle && (
        <h3 className={`${styles.largeTitle} px-4 pt-1 pb-3`}>{title}</h3>
      )}
      <div className="px-4 pb-14">{children}</div>
    </div>
  );
}
