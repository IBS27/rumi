import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
/** Measure only consecutive rendered frames, so demand-mode idle gaps do not count as slow frames. */
export function AdaptiveQuality({ onSlow }: { onSlow: () => void }) {
  const sample = useRef({ elapsed: 0, count: 0, slow: 0, done: false });
  useFrame((_state, delta) => {
    const value = sample.current;
    if (value.done || document.hidden || delta > 0.2) return;
    value.elapsed += delta;
    value.count++;
    if (delta > 1 / 30) value.slow++;
    if (value.count >= 120) {
      value.done = true;
      if (value.slow / value.count > 0.25) onSlow();
    }
  });
  return null;
}
