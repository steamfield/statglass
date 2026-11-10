import { useLayoutEffect, useState } from "react";

/** Re-measure when the text changes or its element is resized or replaced. */
export function useIsTruncated(text: string) {
  const [element, ref] = useState<HTMLElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    if (!element || element.textContent !== text) return;
    const measure = () => {
      setIsTruncated(element.scrollWidth > element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text]);

  return { ref, isTruncated };
}
