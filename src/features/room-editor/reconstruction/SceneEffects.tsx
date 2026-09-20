import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { DoubleSide, OrthographicCamera } from "three";

// AO supplies the missing depth at wall joints, under bedding and in cabinets.
// Compute it at half resolution; the color image retains its full resolution.
export function SceneEffects() {
  const { gl, scene, camera, size, viewport, invalidate } = useThree();
  const effects = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.renderTarget1.samples = 4;
    composer.renderTarget2.samples = 4;
    const render = new RenderPass(scene, camera);
    const ao = new SSAOPass(scene, camera, 1, 1, 16);
    ao.normalMaterial.side = DoubleSide;
    ao.ssaoMaterial.defines.PERSPECTIVE_CAMERA =
      camera instanceof OrthographicCamera ? 0 : 1;
    ao.kernelRadius = 0.3;
    ao.minDistance = 0.0001;
    ao.maxDistance = 0.02;
    const output = new OutputPass();
    composer.addPass(render);
    composer.addPass(ao);
    composer.addPass(output);
    return { composer, ao, render, output };
  }, [gl, scene, camera]);
  useEffect(() => {
    effects.composer.setPixelRatio(viewport.dpr);
    effects.composer.setSize(size.width, size.height);
    effects.ao.setSize(
      Math.max(1, Math.round((size.width * viewport.dpr) / 2)),
      Math.max(1, Math.round((size.height * viewport.dpr) / 2)),
    );
    invalidate();
  }, [effects, size.width, size.height, viewport.dpr, invalidate]);
  useEffect(
    () => () => {
      effects.ao.dispose();
      effects.render.dispose();
      effects.output.dispose();
      effects.composer.dispose();
    },
    [effects],
  );
  useFrame((_state, delta) => effects.composer.render(delta), 1);
  return null;
}
