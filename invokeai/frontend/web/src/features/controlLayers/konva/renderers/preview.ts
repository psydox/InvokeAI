import { getArbitraryBaseColor } from '@invoke-ai/ui-library';
import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import { roundToMultiple, roundToMultipleMin } from 'common/util/roundDownToMultiple';
import {
  BRUSH_BORDER_INNER_COLOR,
  BRUSH_BORDER_OUTER_COLOR,
  BRUSH_ERASER_BORDER_WIDTH,
} from 'features/controlLayers/konva/constants';
import {
  PREVIEW_BRUSH_BORDER_INNER_ID,
  PREVIEW_BRUSH_BORDER_OUTER_ID,
  PREVIEW_BRUSH_FILL_ID,
  PREVIEW_BRUSH_GROUP_ID,
  PREVIEW_GENERATION_BBOX_DUMMY_RECT,
  PREVIEW_GENERATION_BBOX_GROUP,
  PREVIEW_GENERATION_BBOX_TRANSFORMER,
  PREVIEW_LAYER_ID,
  PREVIEW_RECT_ID,
  PREVIEW_TOOL_GROUP_ID,
} from 'features/controlLayers/konva/naming';
import type { KonvaNodeManager } from 'features/controlLayers/konva/nodeManager';
import { createImageObjectGroup, updateImageSource } from 'features/controlLayers/konva/renderers/objects';
import type { CanvasEntity, CanvasV2State, Position, RgbaColor } from 'features/controlLayers/store/types';
import { imageDTOToImageObject, imageDTOToImageWithDims } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { IRect } from 'konva/lib/types';
import { atom } from 'nanostores';
import { assert } from 'tsafe';

/**
 * Creates the konva preview layer.
 * @returns The konva preview layer
 */
export const createPreviewLayer = (): Konva.Layer => new Konva.Layer({ id: PREVIEW_LAYER_ID, listening: true });

/**
 * Creates the bbox konva nodes.
 * @param stage The konva stage
 * @param getBbox A function to get the bbox
 * @param onBboxTransformed A callback for when the bbox is transformed
 * @param getShiftKey A function to get the shift key state
 * @param getCtrlKey A function to get the ctrl key state
 * @param getMetaKey A function to get the meta key state
 * @param getAltKey A function to get the alt key state
 * @returns The bbox nodes
 */
export const createBboxNodes = (
  stage: Konva.Stage,
  getBbox: () => IRect,
  onBboxTransformed: (bbox: IRect) => void,
  getShiftKey: () => boolean,
  getCtrlKey: () => boolean,
  getMetaKey: () => boolean,
  getAltKey: () => boolean
): { group: Konva.Group; rect: Konva.Rect; transformer: Konva.Transformer } => {
  // Create a stash to hold onto the last aspect ratio of the bbox - this allows for locking the aspect ratio when
  // transforming the bbox.
  const bbox = getBbox();
  const $aspectRatioBuffer = atom(bbox.width / bbox.height);

  // Use a transformer for the generation bbox. Transformers need some shape to transform, we will use a fully
  // transparent rect for this purpose.
  const group = new Konva.Group({ id: PREVIEW_GENERATION_BBOX_GROUP, listening: false });
  const rect = new Konva.Rect({
    id: PREVIEW_GENERATION_BBOX_DUMMY_RECT,
    listening: false,
    strokeEnabled: false,
    draggable: true,
    ...getBbox(),
  });
  rect.on('dragmove', () => {
    const gridSize = getCtrlKey() || getMetaKey() ? 8 : 64;
    const oldBbox = getBbox();
    const newBbox: IRect = {
      ...oldBbox,
      x: roundToMultiple(rect.x(), gridSize),
      y: roundToMultiple(rect.y(), gridSize),
    };
    rect.setAttrs(newBbox);
    if (oldBbox.x !== newBbox.x || oldBbox.y !== newBbox.y) {
      onBboxTransformed(newBbox);
    }
  });
  const transformer = new Konva.Transformer({
    id: PREVIEW_GENERATION_BBOX_TRANSFORMER,
    borderDash: [5, 5],
    borderStroke: 'rgba(212,216,234,1)',
    borderEnabled: true,
    rotateEnabled: false,
    keepRatio: false,
    ignoreStroke: true,
    listening: false,
    flipEnabled: false,
    anchorFill: 'rgba(212,216,234,1)',
    anchorStroke: 'rgb(42,42,42)',
    anchorSize: 12,
    anchorCornerRadius: 3,
    shiftBehavior: 'none', // we will implement our own shift behavior
    centeredScaling: false,
    anchorStyleFunc: (anchor) => {
      // Make the x/y resize anchors little bars
      if (anchor.hasName('top-center') || anchor.hasName('bottom-center')) {
        anchor.height(8);
        anchor.offsetY(4);
        anchor.width(30);
        anchor.offsetX(15);
      }
      if (anchor.hasName('middle-left') || anchor.hasName('middle-right')) {
        anchor.height(30);
        anchor.offsetY(15);
        anchor.width(8);
        anchor.offsetX(4);
      }
    },
    anchorDragBoundFunc: (_oldAbsPos, newAbsPos) => {
      // This function works with absolute position - that is, a position in "physical" pixels on the screen, as opposed
      // to konva's internal coordinate system.

      // We need to snap the anchors to the grid. If the user is holding ctrl/meta, we use the finer 8px grid.
      const gridSize = getCtrlKey() || getMetaKey() ? 8 : 64;
      // Because we are working in absolute coordinates, we need to scale the grid size by the stage scale.
      const scaledGridSize = gridSize * stage.scaleX();
      // To snap the anchor to the grid, we need to calculate an offset from the stage's absolute position.
      const stageAbsPos = stage.getAbsolutePosition();
      // The offset is the remainder of the stage's absolute position divided by the scaled grid size.
      const offsetX = stageAbsPos.x % scaledGridSize;
      const offsetY = stageAbsPos.y % scaledGridSize;
      // Finally, calculate the position by rounding to the grid and adding the offset.
      return {
        x: roundToMultiple(newAbsPos.x, scaledGridSize) + offsetX,
        y: roundToMultiple(newAbsPos.y, scaledGridSize) + offsetY,
      };
    },
  });

  transformer.on('transform', () => {
    // In the transform callback, we calculate the bbox's new dims and pos and update the konva object.

    // Some special handling is needed depending on the anchor being dragged.
    const anchor = transformer.getActiveAnchor();
    if (!anchor) {
      // Pretty sure we should always have an anchor here?
      return;
    }

    const alt = getAltKey();
    const ctrl = getCtrlKey();
    const meta = getMetaKey();
    const shift = getShiftKey();

    // Grid size depends on the modifier keys
    let gridSize = ctrl || meta ? 8 : 64;

    // Alt key indicates we are using centered scaling. We need to double the gride size used when calculating the
    // new dimensions so that each size scales in the correct increments and doesn't mis-place the bbox. For example, if
    // we snapped the width and height to 8px increments, the bbox would be mis-placed by 4px in the x and y axes.
    // Doubling the grid size ensures the bbox's coords remain aligned to the 8px/64px grid.
    if (getAltKey()) {
      gridSize = gridSize * 2;
    }

    // The coords should be correct per the anchorDragBoundFunc.
    let x = rect.x();
    let y = rect.y();

    // Konva transforms by scaling the dims, not directly changing width and height. At this point, the width and height
    // *have not changed*, only the scale has changed. To get the final height, we need to scale the dims and then snap
    // them to the grid.
    let width = roundToMultipleMin(rect.width() * rect.scaleX(), gridSize);
    let height = roundToMultipleMin(rect.height() * rect.scaleY(), gridSize);

    // If shift is held and we are resizing from a corner, retain aspect ratio - needs special handling. We skip this
    // if alt/opt is held - this requires math too big for my brain.
    if (shift && CORNER_ANCHORS.includes(anchor) && !alt) {
      // Fit the bbox to the last aspect ratio
      let fittedWidth = Math.sqrt(width * height * $aspectRatioBuffer.get());
      let fittedHeight = fittedWidth / $aspectRatioBuffer.get();
      fittedWidth = roundToMultipleMin(fittedWidth, gridSize);
      fittedHeight = roundToMultipleMin(fittedHeight, gridSize);

      // We need to adjust the x and y coords to have the resize occur from the right origin.
      if (anchor === 'top-left') {
        // The transform origin is the bottom-right anchor. Both x and y need to be updated.
        x = x - (fittedWidth - width);
        y = y - (fittedHeight - height);
      }
      if (anchor === 'top-right') {
        // The transform origin is the bottom-left anchor. Only y needs to be updated.
        y = y - (fittedHeight - height);
      }
      if (anchor === 'bottom-left') {
        // The transform origin is the top-right anchor. Only x needs to be updated.
        x = x - (fittedWidth - width);
      }
      // Update the width and height to the fitted dims.
      width = fittedWidth;
      height = fittedHeight;
    }

    const bbox = {
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
    };

    // Update the bboxRect's attrs directly with the new transform, and reset its scale to 1.
    // TODO(psyche): In `renderBboxPreview()` we also call setAttrs, need to do it twice to ensure it renders correctly.
    // Gotta be a way to avoid setting it twice...
    rect.setAttrs({ ...bbox, scaleX: 1, scaleY: 1 });

    // Update the bbox in internal state.
    onBboxTransformed(bbox);

    // Update the aspect ratio buffer whenever the shift key is not held - this allows for a nice UX where you can start
    // a transform, get the right aspect ratio, then hold shift to lock it in.
    if (!shift) {
      $aspectRatioBuffer.set(bbox.width / bbox.height);
    }
  });

  transformer.on('transformend', () => {
    // Always update the aspect ratio buffer when the transform ends, so if the next transform starts with shift held,
    // we have the correct aspect ratio to start from.
    $aspectRatioBuffer.set(rect.width() / rect.height());
  });

  // The transformer will always be transforming the dummy rect
  transformer.nodes([rect]);
  group.add(rect);
  group.add(transformer);
  return { group, rect, transformer };
};

const ALL_ANCHORS: string[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-right',
  'middle-left',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];
const CORNER_ANCHORS: string[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const NO_ANCHORS: string[] = [];

/**
 * Gets the bbox render function.
 * @param manager The konva node manager
 * @returns The bbox render function
 */
export const getRenderBbox = (manager: KonvaNodeManager) => {
  const { getBbox, getToolState } = manager.stateApi;

  return (): void => {
    const bbox = getBbox();
    const toolState = getToolState();
    manager.preview.bbox.group.listening(toolState.selected === 'bbox');
    // This updates the bbox during transformation
    manager.preview.bbox.rect.setAttrs({
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
      scaleX: 1,
      scaleY: 1,
      listening: toolState.selected === 'bbox',
    });
    manager.preview.bbox.transformer.setAttrs({
      listening: toolState.selected === 'bbox',
      enabledAnchors: toolState.selected === 'bbox' ? ALL_ANCHORS : NO_ANCHORS,
    });
  };
};

/**
 * Gets the tool preview konva nodes.
 * @returns The tool preview konva nodes
 */
export const createToolPreviewNodes = (): KonvaNodeManager['preview']['tool'] => {
  const group = new Konva.Group({ id: PREVIEW_TOOL_GROUP_ID });

  // Create the brush preview group & circles
  const brushGroup = new Konva.Group({ id: PREVIEW_BRUSH_GROUP_ID });
  const brushFill = new Konva.Circle({
    id: PREVIEW_BRUSH_FILL_ID,
    listening: false,
    strokeEnabled: false,
  });
  brushGroup.add(brushFill);
  const brushBorderInner = new Konva.Circle({
    id: PREVIEW_BRUSH_BORDER_INNER_ID,
    listening: false,
    stroke: BRUSH_BORDER_INNER_COLOR,
    strokeWidth: BRUSH_ERASER_BORDER_WIDTH,
    strokeEnabled: true,
  });
  brushGroup.add(brushBorderInner);
  const brushBorderOuter = new Konva.Circle({
    id: PREVIEW_BRUSH_BORDER_OUTER_ID,
    listening: false,
    stroke: BRUSH_BORDER_OUTER_COLOR,
    strokeWidth: BRUSH_ERASER_BORDER_WIDTH,
    strokeEnabled: true,
  });
  brushGroup.add(brushBorderOuter);

  // Create the rect preview - this is a rectangle drawn from the last mouse down position to the current cursor position
  const rect = new Konva.Rect({
    id: PREVIEW_RECT_ID,
    listening: false,
    strokeEnabled: false,
  });

  group.add(rect);
  group.add(brushGroup);
  return {
    group,
    brush: {
      group: brushGroup,
      fill: brushFill,
      innerBorder: brushBorderInner,
      outerBorder: brushBorderOuter,
    },
    rect: {
      rect,
    },
  };
};

/**
 * Gets the tool preview (brush, eraser, rect) render function.
 * @param manager The konva node manager
 * @returns The tool preview render function
 */
export const getRenderToolPreview = (manager: KonvaNodeManager) => {
  const {
    getToolState,
    getCurrentFill,
    getSelectedEntity,
    getLastCursorPos,
    getLastMouseDownPos,
    getIsDrawing,
    getIsMouseDown,
  } = manager.stateApi;

  return (): void => {
    const stage = manager.stage;
    const layerCount = manager.adapters.size;
    const toolState = getToolState();
    const currentFill = getCurrentFill();
    const selectedEntity = getSelectedEntity();
    const cursorPos = getLastCursorPos();
    const lastMouseDownPos = getLastMouseDownPos();
    const isDrawing = getIsDrawing();
    const isMouseDown = getIsMouseDown();
    const tool = toolState.selected;
    const isDrawableEntity =
      selectedEntity?.type === 'regional_guidance' ||
      selectedEntity?.type === 'layer' ||
      selectedEntity?.type === 'inpaint_mask';

    // Update the stage's pointer style
    if (tool === 'view') {
      // View gets a hand
      stage.container().style.cursor = isMouseDown ? 'grabbing' : 'grab';
    } else if (layerCount === 0) {
      // We have no layers, so we should not render any tool
      stage.container().style.cursor = 'default';
    } else if (!isDrawableEntity) {
      // Non-drawable layers don't have tools
      stage.container().style.cursor = 'not-allowed';
    } else if (tool === 'move') {
      // Move tool gets a pointer
      stage.container().style.cursor = 'default';
    } else if (tool === 'rect') {
      // Rect gets a crosshair
      stage.container().style.cursor = 'crosshair';
    } else if (tool === 'brush' || tool === 'eraser') {
      // Hide the native cursor and use the konva-rendered brush preview
      stage.container().style.cursor = 'none';
    } else if (tool === 'bbox') {
      stage.container().style.cursor = 'default';
    }

    stage.draggable(tool === 'view');

    if (!cursorPos || layerCount === 0 || !isDrawableEntity) {
      // We can bail early if the mouse isn't over the stage or there are no layers
      manager.preview.tool.group.visible(false);
    } else {
      manager.preview.tool.group.visible(true);

      // No need to render the brush preview if the cursor position or color is missing
      if (cursorPos && (tool === 'brush' || tool === 'eraser')) {
        const scale = stage.scaleX();
        // Update the fill circle
        const radius = (tool === 'brush' ? toolState.brush.width : toolState.eraser.width) / 2;
        manager.preview.tool.brush.fill.setAttrs({
          x: cursorPos.x,
          y: cursorPos.y,
          radius,
          fill: isDrawing ? '' : rgbaColorToString(currentFill),
          globalCompositeOperation: tool === 'brush' ? 'source-over' : 'destination-out',
        });

        // Update the inner border of the brush preview
        manager.preview.tool.brush.innerBorder.setAttrs({ x: cursorPos.x, y: cursorPos.y, radius });

        // Update the outer border of the brush preview
        manager.preview.tool.brush.outerBorder.setAttrs({
          x: cursorPos.x,
          y: cursorPos.y,
          radius: radius + BRUSH_ERASER_BORDER_WIDTH / scale,
        });

        scaleToolPreview(manager, toolState);

        manager.preview.tool.brush.group.visible(true);
      } else {
        manager.preview.tool.brush.group.visible(false);
      }

      if (cursorPos && lastMouseDownPos && tool === 'rect') {
        manager.preview.tool.rect.rect.setAttrs({
          x: Math.min(cursorPos.x, lastMouseDownPos.x),
          y: Math.min(cursorPos.y, lastMouseDownPos.y),
          width: Math.abs(cursorPos.x - lastMouseDownPos.x),
          height: Math.abs(cursorPos.y - lastMouseDownPos.y),
          fill: rgbaColorToString(currentFill),
          visible: true,
        });
      } else {
        manager.preview.tool.rect.rect.visible(false);
      }
    }
  };
};

/**
 * Scales the tool preview nodes. Depending on the scale of the stage, the border width and radius of the brush preview
 * need to be adjusted.
 * @param manager The konva node manager
 * @param toolState The tool state
 */
const scaleToolPreview = (manager: KonvaNodeManager, toolState: CanvasV2State['tool']): void => {
  const scale = manager.stage.scaleX();
  const radius = (toolState.selected === 'brush' ? toolState.brush.width : toolState.eraser.width) / 2;
  manager.preview.tool.brush.innerBorder.strokeWidth(BRUSH_ERASER_BORDER_WIDTH / scale);
  manager.preview.tool.brush.outerBorder.setAttrs({
    strokeWidth: BRUSH_ERASER_BORDER_WIDTH / scale,
    radius: radius + BRUSH_ERASER_BORDER_WIDTH / scale,
  });
};

/**
 * Creates the document overlay konva nodes.
 * @returns The document overlay konva nodes
 */
export const createDocumentOverlay = (): KonvaNodeManager['preview']['documentOverlay'] => {
  const group = new Konva.Group({ id: 'document_overlay_group', listening: false });
  const outerRect = new Konva.Rect({
    id: 'document_overlay_outer_rect',
    listening: false,
    fill: getArbitraryBaseColor(10),
    opacity: 0.7,
  });
  const innerRect = new Konva.Rect({
    id: 'document_overlay_inner_rect',
    listening: false,
    fill: 'white',
    globalCompositeOperation: 'destination-out',
  });
  group.add(outerRect);
  group.add(innerRect);
  return { group, innerRect, outerRect };
};

/**
 * Gets the document overlay render function.
 * @param manager The konva node manager
 * @returns The document overlay render function
 */
export const getRenderDocumentOverlay = (manager: KonvaNodeManager) => {
  const { getDocument } = manager.stateApi;

  function renderDocumentOverlay(): void {
    const document = getDocument();
    const stage = manager.stage;

    manager.preview.documentOverlay.group.zIndex(0);

    const x = stage.x();
    const y = stage.y();
    const width = stage.width();
    const height = stage.height();
    const scale = stage.scaleX();

    manager.preview.documentOverlay.outerRect.setAttrs({
      offsetX: x / scale,
      offsetY: y / scale,
      width: width / scale,
      height: height / scale,
    });

    manager.preview.documentOverlay.innerRect.setAttrs({
      x: 0,
      y: 0,
      width: document.width,
      height: document.height,
    });
  }

  return renderDocumentOverlay;
};

export const createStagingArea = (): KonvaNodeManager['preview']['stagingArea'] => {
  const group = new Konva.Group({ id: 'staging_area_group', listening: false });
  return { group, image: null };
};

export const getRenderStagingArea = async (manager: KonvaNodeManager) => {
  const { getStagingAreaState } = manager.stateApi;
  const stagingArea = getStagingAreaState();

  if (!stagingArea || stagingArea.selectedImageIndex === null) {
    if (manager.preview.stagingArea.image) {
      manager.preview.stagingArea.image.konvaImageGroup.visible(false);
      manager.preview.stagingArea.image = null;
    }
    return;
  }

  if (stagingArea.selectedImageIndex) {
    const imageDTO = stagingArea.images[stagingArea.selectedImageIndex];
    assert(imageDTO, 'Image must exist');
    if (manager.preview.stagingArea.image) {
      if (manager.preview.stagingArea.image.imageName !== imageDTO.image_name) {
        await updateImageSource({
          objectRecord: manager.preview.stagingArea.image,
          image: imageDTOToImageWithDims(imageDTO),
        });
      }
    } else {
      manager.preview.stagingArea.image = await createImageObjectGroup({
        obj: imageDTOToImageObject(imageDTO),
        name: imageDTO.image_name,
      });
    }
  }
};

export class KonvaPreview {
  konvaLayer: Konva.Layer;
  bbox: {
    group: Konva.Group;
    rect: Konva.Rect;
    transformer: Konva.Transformer;
  };
  tool: {
    group: Konva.Group;
    brush: {
      group: Konva.Group;
      fill: Konva.Circle;
      innerBorder: Konva.Circle;
      outerBorder: Konva.Circle;
    };
    rect: {
      rect: Konva.Rect;
    };
  };
  documentOverlay: {
    group: Konva.Group;
    innerRect: Konva.Rect;
    outerRect: Konva.Rect;
  };
  stagingArea: {
    group: Konva.Group;
    // image: KonvaImage | null;
  };

  constructor(
    stage: Konva.Stage,
    getBbox: () => IRect,
    onBboxTransformed: (bbox: IRect) => void,
    getShiftKey: () => boolean,
    getCtrlKey: () => boolean,
    getMetaKey: () => boolean,
    getAltKey: () => boolean
  ) {
    this.konvaLayer = createPreviewLayer();
    this.bbox = createBboxNodes(stage, getBbox, onBboxTransformed, getShiftKey, getCtrlKey, getMetaKey, getAltKey);
    this.tool = createToolPreviewNodes();
    this.documentOverlay = createDocumentOverlay();
    this.stagingArea = createStagingArea();
  }

  renderBbox(bbox: CanvasV2State['bbox'], toolState: CanvasV2State['tool']) {
    this.bbox.group.listening(toolState.selected === 'bbox');
    // This updates the bbox during transformation
    this.bbox.rect.setAttrs({
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
      scaleX: 1,
      scaleY: 1,
      listening: toolState.selected === 'bbox',
    });
    this.bbox.transformer.setAttrs({
      listening: toolState.selected === 'bbox',
      enabledAnchors: toolState.selected === 'bbox' ? ALL_ANCHORS : NO_ANCHORS,
    });
  }

  scaleToolPreview(stage: Konva.Stage, toolState: CanvasV2State['tool']) {
    const scale = stage.scaleX();
    const radius = (toolState.selected === 'brush' ? toolState.brush.width : toolState.eraser.width) / 2;
    this.tool.brush.innerBorder.strokeWidth(BRUSH_ERASER_BORDER_WIDTH / scale);
    this.tool.brush.outerBorder.setAttrs({
      strokeWidth: BRUSH_ERASER_BORDER_WIDTH / scale,
      radius: radius + BRUSH_ERASER_BORDER_WIDTH / scale,
    });
  }

  renderToolPreview(
    stage: Konva.Stage,
    renderedEntityCount: number,
    toolState: CanvasV2State['tool'],
    currentFill: RgbaColor,
    selectedEntity: CanvasEntity | null,
    cursorPos: Position | null,
    lastMouseDownPos: Position | null,
    isDrawing: boolean,
    isMouseDown: boolean
  ) {
    const tool = toolState.selected;
    const isDrawableEntity =
      selectedEntity?.type === 'regional_guidance' ||
      selectedEntity?.type === 'layer' ||
      selectedEntity?.type === 'inpaint_mask';

    // Update the stage's pointer style
    if (tool === 'view') {
      // View gets a hand
      stage.container().style.cursor = isMouseDown ? 'grabbing' : 'grab';
    } else if (renderedEntityCount === 0) {
      // We have no layers, so we should not render any tool
      stage.container().style.cursor = 'default';
    } else if (!isDrawableEntity) {
      // Non-drawable layers don't have tools
      stage.container().style.cursor = 'not-allowed';
    } else if (tool === 'move') {
      // Move tool gets a pointer
      stage.container().style.cursor = 'default';
    } else if (tool === 'rect') {
      // Rect gets a crosshair
      stage.container().style.cursor = 'crosshair';
    } else if (tool === 'brush' || tool === 'eraser') {
      // Hide the native cursor and use the konva-rendered brush preview
      stage.container().style.cursor = 'none';
    } else if (tool === 'bbox') {
      stage.container().style.cursor = 'default';
    }

    stage.draggable(tool === 'view');

    if (!cursorPos || renderedEntityCount === 0 || !isDrawableEntity) {
      // We can bail early if the mouse isn't over the stage or there are no layers
      this.tool.group.visible(false);
    } else {
      this.tool.group.visible(true);

      // No need to render the brush preview if the cursor position or color is missing
      if (cursorPos && (tool === 'brush' || tool === 'eraser')) {
        const scale = stage.scaleX();
        // Update the fill circle
        const radius = (tool === 'brush' ? toolState.brush.width : toolState.eraser.width) / 2;
        this.tool.brush.fill.setAttrs({
          x: cursorPos.x,
          y: cursorPos.y,
          radius,
          fill: isDrawing ? '' : rgbaColorToString(currentFill),
          globalCompositeOperation: tool === 'brush' ? 'source-over' : 'destination-out',
        });

        // Update the inner border of the brush preview
        this.tool.brush.innerBorder.setAttrs({ x: cursorPos.x, y: cursorPos.y, radius });

        // Update the outer border of the brush preview
        this.tool.brush.outerBorder.setAttrs({
          x: cursorPos.x,
          y: cursorPos.y,
          radius: radius + BRUSH_ERASER_BORDER_WIDTH / scale,
        });

        this.scaleToolPreview(stage, toolState);

        this.tool.brush.group.visible(true);
      } else {
        this.tool.brush.group.visible(false);
      }

      if (cursorPos && lastMouseDownPos && tool === 'rect') {
        this.tool.rect.rect.setAttrs({
          x: Math.min(cursorPos.x, lastMouseDownPos.x),
          y: Math.min(cursorPos.y, lastMouseDownPos.y),
          width: Math.abs(cursorPos.x - lastMouseDownPos.x),
          height: Math.abs(cursorPos.y - lastMouseDownPos.y),
          fill: rgbaColorToString(currentFill),
          visible: true,
        });
      } else {
        this.tool.rect.rect.visible(false);
      }
    }
  }

  renderDocumentOverlay(stage: Konva.Stage, document: CanvasV2State['document']) {
    this.documentOverlay.group.zIndex(0);

    const x = stage.x();
    const y = stage.y();
    const width = stage.width();
    const height = stage.height();
    const scale = stage.scaleX();

    this.documentOverlay.outerRect.setAttrs({
      offsetX: x / scale,
      offsetY: y / scale,
      width: width / scale,
      height: height / scale,
    });

    this.documentOverlay.innerRect.setAttrs({
      x: 0,
      y: 0,
      width: document.width,
      height: document.height,
    });
  }
}