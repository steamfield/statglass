export const MOTION = `
@theme static {
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-tick: cubic-bezier(0.33, 1, 0.68, 1);
  --ease-enter: cubic-bezier(0.25, 1, 0.5, 1);
}
:root { --motion-tick: 0ms; --motion-scan: 0ms; --motion-count: 0ms; }
@media (prefers-reduced-motion: no-preference) {
  :root {
    --motion-tick: 175ms;
    --motion-count: 450ms;
    --motion-fast: 150ms;
    --motion-entry: 300ms;
    --motion-enter: 280ms;
    --motion-page: 400ms;
    --motion-stagger: 40ms;
    --motion-crossfade: 150ms;
    --motion-scan: .8s;
    --motion-extra-delay: 9.5ms;
  }
}
:root[data-performance] { --motion-tick: 0ms; --motion-count: 0ms; }
`;
