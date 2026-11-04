import { useEffect, useRef, useState } from "react";

export default function AnimatedNumber({ value, active = true }) {
  const valueString = String(value ?? 0);
  const match = valueString.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
  const target = match ? Number(match[2].replaceAll(",", "")) : null;
  const decimals = match?.[2].split(".")[1]?.length || 0;
  const [current, setCurrent] = useState(active && target !== null ? target : 0);
  const currentValue = useRef(current);

  useEffect(() => {
    if (!active || target === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      currentValue.current = active && target !== null ? target : 0;
      setCurrent(currentValue.current);
      return undefined;
    }

    const from = currentValue.current;
    if (from === target) return undefined;
    let frameId;
    const startTime = performance.now();
    const duration = 200;
    const tick = (now) => {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - (1 - progress) ** 3;
      currentValue.current = from + (target - from) * eased;
      setCurrent(currentValue.current);
      if (progress < 1) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [active, target]);

  if (target === null) return valueString;
  const formatted = current.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${match[1]}${formatted}${match[3]}`;
}
