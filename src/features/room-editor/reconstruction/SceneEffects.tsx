import { useLayoutEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { GammaCorrectionShader } from "three/addons/shaders/GammaCorrectionShader.js";
import { DoubleSide, OrthographicCamera } from "three";

// Keep the pipeline alive across camera changes. Allocate GPU resources in an
// effect so StrictMode's setup/cleanup cycle never reuses disposed resources.
export function SceneEffects({
  ambientOcclusion = true,
}: {
  ambientOcclusion?: boolean;
}) {
  const { gl, scene, invalidate, get } = useThree();
  const effects = useRef<{
    composer: EffectComposer;
    render: RenderPass;
    ao: SSAOPass | null;
    aa: ShaderPass;
    width: number;
    height: number;
    dpr: number;
  } | null>(null);
  useLayoutEffect(() => {
    const composer = new EffectComposer(gl);
    composer.renderTarget1.samples = 4;
    composer.renderTarget2.samples = 4;
    // The active camera is assigned before every rendered frame.
    const camera = get().camera;
    const render = new RenderPass(scene, camera);
    const ao = ambientOcclusion ? new SSAOPass(scene, camera, 1, 1, 32) : null;
    if (ao) {
      ao.normalMaterial.side = DoubleSide;
      ao.kernelRadius = 0.3;
      ao.minDistance = 0.0001;
      ao.maxDistance = 0.02;
    }
    // Captured photos already contain lighting and must bypass tone mapping.
    const output = ambientOcclusion
      ? new OutputPass()
      : new ShaderPass(GammaCorrectionShader);
    const aa = new ShaderPass(FXAAShader);
    composer.addPass(render);
    if (ao) composer.addPass(ao);
    composer.addPass(output);
    composer.addPass(aa);
    effects.current = { composer, render, ao, aa, width: 0, height: 0, dpr: 0 };
    invalidate();
    return () => {
      effects.current = null;
      ao?.dispose();
      // SSAOPass.dispose does not release these two owned resources.
      ao?.ssaoMaterial.dispose();
      ao?.noiseTexture.dispose();
      render.dispose();
      output.dispose();
      aa.dispose();
      composer.dispose();
    };
  }, [gl, scene, invalidate, get, ambientOcclusion]);
  useFrame(({ camera, size, viewport }, delta) => {
    const value = effects.current;
    if (!value) return;
    const { composer, render, ao, aa } = value;
    render.camera = camera;
    // SSAOPass only copies projection matrices during construction/setSize.
    // Orbit zoom and camera switches must update them before the normal pass.
    if (ao) {
      ao.camera = camera;
      const perspective = camera instanceof OrthographicCamera ? 0 : 1;
      if (ao.ssaoMaterial.defines.PERSPECTIVE_CAMERA !== perspective) {
        ao.ssaoMaterial.defines.PERSPECTIVE_CAMERA = perspective;
        ao.ssaoMaterial.needsUpdate = true;
      }
      const uniforms = ao.ssaoMaterial.uniforms;
      uniforms.cameraNear.value = camera.near;
      uniforms.cameraFar.value = camera.far;
      uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
      uniforms.cameraInverseProjectionMatrix.value.copy(
        camera.projectionMatrixInverse,
      );
    }
    if (
      value.width !== size.width ||
      value.height !== size.height ||
      value.dpr !== viewport.dpr
    ) {
      value.width = size.width;
      value.height = size.height;
      value.dpr = viewport.dpr;
      composer.setPixelRatio(viewport.dpr);
      // Full-resolution depth avoids half-resolution AO crawling along edges.
      composer.setSize(Math.max(1, size.width), Math.max(1, size.height));
      aa.uniforms.resolution.value.set(
        1 / Math.max(1, size.width * viewport.dpr),
        1 / Math.max(1, size.height * viewport.dpr),
      );
    }
    composer.render(delta);
  }, 1);
  return null;
}
