import type { CSSProperties, ReactNode } from "react";
import styles from "./phone.module.css";
import { useTilt } from "./use-tilt";

const EDGES = [1, 2, 3, 4, 5, 6, 7, 8];

/** Side buttons, top offset and length in points (iPhone 17 Pro). */
const BUTTONS = [
  { side: "left", top: 150, height: 34 },
  { side: "left", top: 220, height: 62 },
  { side: "left", top: 296, height: 62 },
  { side: "right", top: 250, height: 96 },
  { side: "right", top: 560, height: 54 },
] as const;

function StatusBar() {
  return (
    <div
      className={`${styles.statusBar} flex items-center justify-between px-[46px] pt-1`}
      aria-hidden="true"
    >
      <span className="text-[17px] font-semibold tracking-[-0.02em]">9:41</span>
      <span className="flex items-center gap-[7px]">
        <svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor">
          <rect x="0" y="7.5" width="3.2" height="4.5" rx="1" />
          <rect x="5" y="5" width="3.2" height="7" rx="1" />
          <rect x="10" y="2.5" width="3.2" height="9.5" rx="1" />
          <rect x="15" y="0" width="3.2" height="12" rx="1" />
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor">
          <path d="M8.5 2.6c2.3 0 4.4.9 6 2.4l1.2-1.2A10.2 10.2 0 0 0 8.5.9 10.2 10.2 0 0 0 1.3 3.8L2.5 5a8.5 8.5 0 0 1 6-2.4Z" />
          <path d="M8.5 6c1.4 0 2.6.5 3.6 1.4l1.2-1.2A6.8 6.8 0 0 0 8.5 4.3a6.8 6.8 0 0 0-4.8 1.9l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Z" />
          <path d="M8.5 12 11 9.5a3.5 3.5 0 0 0-5 0L8.5 12Z" />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="23"
            height="12"
            rx="3.8"
            stroke="currentColor"
            strokeOpacity="0.4"
          />
          <rect
            x="2"
            y="2"
            width="17"
            height="9"
            rx="2.5"
            fill="currentColor"
          />
          <path
            d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z"
            fill="currentColor"
            fillOpacity="0.4"
          />
        </svg>
      </span>
    </div>
  );
}

/**
 * An iPhone drawn in CSS 3D: a titanium band with real depth, side buttons,
 * the Dynamic Island and a glass sheen, turned toward the pointer. The
 * screen is always dark, as the app's store screenshots are.
 */
export function PhoneFrame({ children }: { children: ReactNode }) {
  const stage = useTilt<HTMLDivElement>();
  return (
    <div ref={stage} className={styles.stage}>
      <div className={styles.shadow} aria-hidden="true" />
      <div className={styles.phone}>
        <div className={styles.body}>
          {EDGES.map((i) => (
            <div
              key={i}
              className={styles.edge}
              style={{ "--i": i } as CSSProperties}
              aria-hidden="true"
            />
          ))}
          {BUTTONS.map((b) => (
            <span
              key={`${b.side}-${b.top}`}
              className={styles.button}
              data-side={b.side}
              style={{ top: b.top, height: b.height }}
              aria-hidden="true"
            />
          ))}
          <div className={styles.band}>
            <div className={styles.bezel}>
              <div
                data-phone-screen=""
                className={`dark ${styles.screen} font-sans`}
              >
                <StatusBar />
                <div className={styles.island} aria-hidden="true" />
                {children}
                <div className={styles.homeIndicator} aria-hidden="true" />
                <div className={styles.glare} aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
