import { logger } from 'app/logging/logger';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import { selectMainModelConfig, selectParamsSlice } from 'features/controlLayers/store/paramsSlice';
import { selectRefImagesSlice } from 'features/controlLayers/store/refImagesSlice';
import { selectCanvasMetadata, selectCanvasSlice } from 'features/controlLayers/store/selectors';
import { addControlNets, addT2IAdapters } from 'features/nodes/util/graph/generation/addControlAdapters';
import { addImageToImage } from 'features/nodes/util/graph/generation/addImageToImage';
import { addInpaint } from 'features/nodes/util/graph/generation/addInpaint';
import { addIPAdapters } from 'features/nodes/util/graph/generation/addIPAdapters';
import { addNSFWChecker } from 'features/nodes/util/graph/generation/addNSFWChecker';
import { addOutpaint } from 'features/nodes/util/graph/generation/addOutpaint';
import { addSDXLLoRAs } from 'features/nodes/util/graph/generation/addSDXLLoRAs';
import { addSDXLRefiner } from 'features/nodes/util/graph/generation/addSDXLRefiner';
import { addSeamless } from 'features/nodes/util/graph/generation/addSeamless';
import { addTextToImage } from 'features/nodes/util/graph/generation/addTextToImage';
import { addWatermarker } from 'features/nodes/util/graph/generation/addWatermarker';
import { Graph } from 'features/nodes/util/graph/generation/Graph';
import {
  getSizes,
  selectCanvasOutputFields,
  selectPresetModifiedPrompts,
} from 'features/nodes/util/graph/graphBuilderUtils';
import type { GraphBuilderArg, GraphBuilderReturn, ImageOutputNodes } from 'features/nodes/util/graph/types';
import type { Invocation } from 'services/api/types';
import type { Equals } from 'tsafe';
import { assert } from 'tsafe';

import { addRegions } from './addRegions';

const log = logger('system');

export const buildSDXLGraph = async (arg: GraphBuilderArg): Promise<GraphBuilderReturn> => {
  const { generationMode, state } = arg;
  log.debug({ generationMode }, 'Building SDXL graph');

  const model = selectMainModelConfig(state);
  assert(model, 'No model found in state');
  assert(model.base === 'sdxl');

  const params = selectParamsSlice(state);
  const canvas = selectCanvasSlice(state);
  const refImages = selectRefImagesSlice(state);

  const { bbox } = canvas;

  const {
    cfgScale: cfg_scale,
    cfgRescaleMultiplier: cfg_rescale_multiplier,
    scheduler,
    seed,
    steps,
    shouldUseCpuNoise,
    vaePrecision,
    vae,
    refinerModel,
    refinerStart,
  } = params;

  assert(model, 'No model found in state');

  const fp32 = vaePrecision === 'fp32';
  const { originalSize, scaledSize } = getSizes(bbox);
  const { positivePrompt, negativePrompt, positiveStylePrompt, negativeStylePrompt } =
    selectPresetModifiedPrompts(state);

  const g = new Graph(getPrefixedId('sdxl_graph'));
  const modelLoader = g.addNode({
    type: 'sdxl_model_loader',
    id: getPrefixedId('sdxl_model_loader'),
    model,
  });
  const posCond = g.addNode({
    type: 'sdxl_compel_prompt',
    id: getPrefixedId('pos_cond'),
    prompt: positivePrompt,
    style: positiveStylePrompt,
  });
  const posCondCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('pos_cond_collect'),
  });
  const negCond = g.addNode({
    type: 'sdxl_compel_prompt',
    id: getPrefixedId('neg_cond'),
    prompt: negativePrompt,
    style: negativeStylePrompt,
  });
  const negCondCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('neg_cond_collect'),
  });
  const noise = g.addNode({
    type: 'noise',
    id: getPrefixedId('noise'),
    seed,
    width: scaledSize.width,
    height: scaledSize.height,
    use_cpu: shouldUseCpuNoise,
  });
  const denoise = g.addNode({
    type: 'denoise_latents',
    id: getPrefixedId('denoise_latents'),
    cfg_scale,
    cfg_rescale_multiplier,
    scheduler,
    steps,
    denoising_start: 0,
    denoising_end: refinerModel ? refinerStart : 1,
  });
  const l2i = g.addNode({
    type: 'l2i',
    id: getPrefixedId('l2i'),
    fp32,
  });
  const vaeLoader =
    vae?.base === model.base
      ? g.addNode({
          type: 'vae_loader',
          id: getPrefixedId('vae'),
          vae_model: vae,
        })
      : null;

  g.addEdge(modelLoader, 'unet', denoise, 'unet');
  g.addEdge(modelLoader, 'clip', posCond, 'clip');
  g.addEdge(modelLoader, 'clip', negCond, 'clip');
  g.addEdge(modelLoader, 'clip2', posCond, 'clip2');
  g.addEdge(modelLoader, 'clip2', negCond, 'clip2');
  g.addEdge(posCond, 'conditioning', posCondCollect, 'item');
  g.addEdge(negCond, 'conditioning', negCondCollect, 'item');
  g.addEdge(posCondCollect, 'collection', denoise, 'positive_conditioning');
  g.addEdge(negCondCollect, 'collection', denoise, 'negative_conditioning');
  g.addEdge(noise, 'noise', denoise, 'noise');
  g.addEdge(denoise, 'latents', l2i, 'latents');

  g.upsertMetadata({
    cfg_scale,
    cfg_rescale_multiplier,
    width: originalSize.width,
    height: originalSize.height,
    positive_prompt: positivePrompt,
    negative_prompt: negativePrompt,
    model: Graph.getModelMetadataField(model),
    seed,
    steps,
    rand_device: shouldUseCpuNoise ? 'cpu' : 'cuda',
    scheduler,
    positive_style_prompt: positiveStylePrompt,
    negative_style_prompt: negativeStylePrompt,
    vae: vae ?? undefined,
  });

  const seamless = addSeamless(state, g, denoise, modelLoader, vaeLoader);

  addSDXLLoRAs(state, g, denoise, modelLoader, seamless, posCond, negCond);

  // We might get the VAE from the main model, custom VAE, or seamless node.
  const vaeSource = seamless ?? vaeLoader ?? modelLoader;
  g.addEdge(vaeSource, 'vae', l2i, 'vae');

  // Add Refiner if enabled
  if (refinerModel) {
    await addSDXLRefiner(state, g, denoise, seamless, posCond, negCond, l2i);
  }

  const denoising_start = refinerModel
    ? Math.min(refinerStart, 1 - params.img2imgStrength)
    : 1 - params.img2imgStrength;

  let canvasOutput: Invocation<ImageOutputNodes> = l2i;

  if (generationMode === 'txt2img') {
    canvasOutput = addTextToImage({ g, l2i, originalSize, scaledSize });
    g.upsertMetadata({ generation_mode: 'sdxl_txt2img' });
  } else if (generationMode === 'img2img') {
    canvasOutput = await addImageToImage({
      g,
      manager: arg.canvasManager,
      l2i,
      i2lNodeType: 'i2l',
      denoise,
      vaeSource,
      originalSize,
      scaledSize,
      bbox,
      denoising_start,
      fp32,
    });
    g.upsertMetadata({ generation_mode: 'sdxl_img2img' });
  } else if (generationMode === 'inpaint') {
    canvasOutput = await addInpaint({
      state,
      g,
      manager: arg.canvasManager,
      l2i,
      i2lNodeType: 'i2l',
      denoise,
      vaeSource,
      modelLoader,
      originalSize,
      scaledSize,
      denoising_start,
      fp32,
      seed,
    });
    g.upsertMetadata({ generation_mode: 'sdxl_inpaint' });
  } else if (generationMode === 'outpaint') {
    canvasOutput = await addOutpaint({
      state,
      g,
      manager: arg.canvasManager,
      l2i,
      i2lNodeType: 'i2l',
      denoise,
      vaeSource,
      modelLoader,
      originalSize,
      scaledSize,
      denoising_start,
      fp32,
      seed,
    });
    g.upsertMetadata({ generation_mode: 'sdxl_outpaint' });
  } else {
    assert<Equals<typeof generationMode, never>>(false);
  }

  if (generationMode === 'img2img' || generationMode === 'inpaint' || generationMode === 'outpaint') {
    const controlNetCollector = g.addNode({
      type: 'collect',
      id: getPrefixedId('control_net_collector'),
    });
    const controlNetResult = await addControlNets({
      manager: arg.canvasManager,
      entities: canvas.controlLayers.entities,
      g,
      rect: canvas.bbox.rect,
      collector: controlNetCollector,
      model,
    });
    if (controlNetResult.addedControlNets > 0) {
      g.addEdge(controlNetCollector, 'collection', denoise, 'control');
    } else {
      g.deleteNode(controlNetCollector.id);
    }

    const t2iAdapterCollector = g.addNode({
      type: 'collect',
      id: getPrefixedId('t2i_adapter_collector'),
    });
    const t2iAdapterResult = await addT2IAdapters({
      manager: arg.canvasManager,
      entities: canvas.controlLayers.entities,
      g,
      rect: canvas.bbox.rect,
      collector: t2iAdapterCollector,
      model,
    });
    if (t2iAdapterResult.addedT2IAdapters > 0) {
      g.addEdge(t2iAdapterCollector, 'collection', denoise, 't2i_adapter');
    } else {
      g.deleteNode(t2iAdapterCollector.id);
    }
  }

  const ipAdapterCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('ip_adapter_collector'),
  });
  const ipAdapterResult = addIPAdapters({
    entities: refImages.entities,
    g,
    collector: ipAdapterCollect,
    model,
  });
  let totalIPAdaptersAdded = ipAdapterResult.addedIPAdapters;

  if (generationMode === 'img2img' || generationMode === 'inpaint' || generationMode === 'outpaint') {
    const regionsResult = await addRegions({
      manager: arg.canvasManager,
      regions: canvas.regionalGuidance.entities,
      g,
      bbox: canvas.bbox.rect,
      model,
      posCond,
      negCond,
      posCondCollect,
      negCondCollect,
      ipAdapterCollect,
      fluxReduxCollect: null,
    });
    totalIPAdaptersAdded += regionsResult.reduce((acc, r) => acc + r.addedIPAdapters, 0);
  }

  if (totalIPAdaptersAdded > 0) {
    g.addEdge(ipAdapterCollect, 'collection', denoise, 'ip_adapter');
  } else {
    g.deleteNode(ipAdapterCollect.id);
  }

  if (state.system.shouldUseNSFWChecker) {
    canvasOutput = addNSFWChecker(g, canvasOutput);
  }

  if (state.system.shouldUseWatermarker) {
    canvasOutput = addWatermarker(g, canvasOutput);
  }

  g.upsertMetadata(selectCanvasMetadata(state));

  g.updateNode(canvasOutput, selectCanvasOutputFields(state));

  g.setMetadataReceivingNode(canvasOutput);
  return {
    g,
    seedFieldIdentifier: { nodeId: noise.id, fieldName: 'seed' },
    positivePromptFieldIdentifier: { nodeId: posCond.id, fieldName: 'prompt' },
  };
};
