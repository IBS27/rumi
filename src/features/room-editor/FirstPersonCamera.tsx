import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import type { PerspectiveCamera as ThreeCamera } from "three";
import {
  EYE_HEIGHT,
  moveWalk,
  walkPosition,
  type Walkthrough,
} from "../../../shared/capture/walkthrough";

export type WalkInput = { pressed: Set<string> };

const movementKeys = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "KeyQ",
  "KeyE",
]);

export function FirstPersonCamera({
  model,
  input,
  width,
  depth,
}: {
  model: Walkthrough;
  input: RefObject<WalkInput>;
  width: number;
  depth: number;
}) {
  const camera = useRef<ThreeCamera>(null);
  const position = useRef(model.start);
  const look = useRef({ yaw: 0, pitch: 0 });
  const canvas = useThree((state) => state.gl.domElement);
  const initialModel = useRef(model);

  useLayoutEffect(() => {
    const start = initialModel.current.start;
    if (!start || !camera.current) return;
    position.current = { ...start };
    look.current = {
      yaw: Math.atan2(start.x - width / 2, start.z - depth / 2),
      pitch: 0,
    };
    camera.current.position.set(start.x, start.y + EYE_HEIGHT, start.z);
    camera.current.rotation.set(0, look.current.yaw, 0, "YXZ");
  }, [width, depth]);

  useEffect(() => {
    const current = position.current;
    if (
      current &&
      !walkPosition(model, { x: current.x, z: current.z }, current.y)
    )
      position.current = model.start;
  }, [model]);

  useEffect(() => {
    const pressed = input.current.pressed;
    let drag: { id: number; x: number; y: number } | null = null;
    const stop = () => {
      pressed.clear();
      if (drag && canvas.hasPointerCapture(drag.id))
        canvas.releasePointerCapture(drag.id);
      drag = null;
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !movementKeys.has(event.code)
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      event.preventDefault();
      pressed.add(event.code);
    };
    const keyup = (event: KeyboardEvent) => {
      pressed.delete(event.code);
    };
    const pointerdown = (event: PointerEvent) => {
      if (event.button !== 0 || drag) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const pointermove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      look.current.yaw -= (event.clientX - drag.x) * 0.004;
      look.current.pitch = Math.max(
        -1.35,
        Math.min(1.35, look.current.pitch - (event.clientY - drag.y) * 0.004),
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const pointerup = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) {
        drag = null;
        if (canvas.hasPointerCapture(event.pointerId))
          canvas.releasePointerCapture(event.pointerId);
      }
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    canvas.addEventListener("pointerdown", pointerdown);
    canvas.addEventListener("pointermove", pointermove);
    canvas.addEventListener("pointerup", pointerup);
    canvas.addEventListener("pointercancel", pointerup);
    canvas.addEventListener("lostpointercapture", pointerup);
    return () => {
      stop();
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      canvas.removeEventListener("pointerdown", pointerdown);
      canvas.removeEventListener("pointermove", pointermove);
      canvas.removeEventListener("pointerup", pointerup);
      canvas.removeEventListener("pointercancel", pointerup);
      canvas.removeEventListener("lostpointercapture", pointerup);
    };
  }, [canvas, input]);

  useFrame((_, elapsed) => {
    if (!camera.current || !position.current) return;
    const delta = Math.min(elapsed, 0.05);
    const pressed = input.current.pressed;
    const has = (...keys: string[]) =>
      keys.some((key) => pressed.has(key)) ? 1 : 0;
    look.current.yaw += (has("KeyQ") - has("KeyE")) * delta * 1.6;
    const forward =
      has("KeyW", "ArrowUp", "forward") - has("KeyS", "ArrowDown", "backward");
    const right =
      has("KeyD", "ArrowRight", "right") - has("KeyA", "ArrowLeft", "left");
    const length = Math.hypot(forward, right);
    if (length) {
      const distance = (1.8 * delta) / length;
      const { yaw } = look.current;
      position.current = moveWalk(
        model,
        position.current,
        (right * Math.cos(yaw) - forward * Math.sin(yaw)) * distance,
        (-forward * Math.cos(yaw) - right * Math.sin(yaw)) * distance,
      );
    }
    const p = position.current;
    camera.current.position.set(p.x, p.y + EYE_HEIGHT, p.z);
    camera.current.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");
  });

  return (
    <PerspectiveCamera
      ref={camera}
      makeDefault
      fov={65}
      near={0.03}
      far={Math.max(width, depth, 10) * 4}
    />
  );
}
