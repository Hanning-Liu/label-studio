import Konva from "konva";
import { memo, useContext, useEffect, useMemo } from "react";
import { Group, Line } from "react-konva";
import { destroy, detach, getRoot, isAlive, types } from "mobx-state-tree";

import Constants from "../core/Constants";
import NormalizationMixin from "../mixins/Normalization";
import RegionsMixin from "../mixins/Regions";
import Registry from "../core/Registry";
import { ImageModel } from "../tags/object/Image";
import { LabelOnPolygon } from "../components/ImageView/LabelOnRegion";
import { PolygonPoint, PolygonPointView } from "./PolygonPoint";
import { green } from "@ant-design/colors";
import { guidGenerator } from "../core/Helpers";
import { AreaMixin, shouldRenderRoomReference } from "../mixins/AreaMixin";
import { useRegionStyles } from "../hooks/useRegionColor";
import { AliveRegion } from "./AliveRegion";
import { KonvaRegionMixin } from "../mixins/KonvaRegion";
import { observer } from "mobx-react";
import { createDragBoundFunc } from "../utils/image";
import { ImageViewContext } from "../components/ImageView/ImageViewContext";
import {
  clampPolygonTransform,
  isSimplePolygon,
  polygonInsidePolygon,
  withAlpha,
} from "../utils/roomConstraintGeometry";

const Model = types
  .model({
    id: types.optional(types.identifier, guidGenerator),
    pid: types.optional(types.string, guidGenerator),
    type: "polygonregion",
    object: types.late(() => types.reference(ImageModel)),

    points: types.array(types.union(PolygonPoint, types.array(types.number)), []),
    closed: true,
  })
  .volatile(() => ({
    mouseOverStartPoint: false,
    selectedPoint: null,
    hideable: true,
    _supportsTransform: true,
    useTransformer: true,
    preferTransformer: false,
    supportsRotate: false,
    supportsScale: true,
  }))
  .views((self) => ({
    get store() {
      return getRoot(self);
    },
    get bboxCoords() {
      if (!self.points?.length || !isAlive(self)) return {};

      const bbox = self.points.reduce(
        (bboxCoords, point) => ({
          left: Math.min(bboxCoords.left, point.x),
          top: Math.min(bboxCoords.top, point.y),
          right: Math.max(bboxCoords.right, point.x),
          bottom: Math.max(bboxCoords.bottom, point.y),
        }),
        {
          left: self.points[0].x,
          top: self.points[0].y,
          right: self.points[0].x,
          bottom: self.points[0].y,
        },
      );

      return bbox;
    },
    get flattenedPoints() {
      return getFlattenedPoints(this.points);
    },
    get incomplete() {
      return !self.closed;
    },
  }))
  .actions((self) => {
    return {
      afterCreate() {
        if (!self.points.length) return;
        if (!self.points[0].id) {
          self.points = self.points.map(([x, y], index) => ({
            id: guidGenerator(),
            x,
            y,
            size: self.pointSize,
            style: self.pointStyle,
            index,
          }));
        }
        self.checkSizes();
      },

      /**
       * @todo excess method; better to handle click only on start point
       * Handler for mouse on start point of Polygon
       * @param {boolean} val
       */
      setMouseOverStartPoint(value) {
        self.mouseOverStartPoint = value;
      },

      // @todo not used
      setSelectedPoint(point) {
        if (self.selectedPoint) {
          self.selectedPoint.selected = false;
        }

        point.selected = true;
        self.selectedPoint = point;
      },

      handleMouseMove({ e, flattenedPoints }) {
        const { offsetX, offsetY } = e.evt;
        const [cursorX, cursorY] = self.parent.fixZoomedCoords([offsetX, offsetY]);
        const [x, y] = getAnchorPoint({ flattenedPoints, cursorX, cursorY });

        const group = e.currentTarget;
        const layer = e.currentTarget.getLayer();
        const zoom = self.parent.zoomScale;

        moveHoverAnchor({ point: [x, y], group, layer, zoom });
      },

      handleMouseLeave({ e }) {
        removeHoverAnchor({ layer: e.currentTarget.getLayer() });
      },

      handleLineClick({ e, flattenedPoints, insertIdx }) {
        if (!self.closed || !self.selected) return;

        e.cancelBubble = true;

        removeHoverAnchor({ layer: e.currentTarget.getLayer() });

        const { offsetX, offsetY } = e.evt;

        const [cursorX, cursorY] = self.parent.fixZoomedCoords([offsetX, offsetY]);
        const point = getAnchorPoint({ flattenedPoints, cursorX, cursorY });

        self.insertPoint(insertIdx, point[0], point[1]);
      },

      deletePoint(point) {
        const willNotEliminateClosedShape = self.points.length <= 3 && point.parent.closed;
        const isLastPoint = self.points.length === 1;
        const isSelected = self.selectedPoint === point;

        if (willNotEliminateClosedShape || isLastPoint) return;
        if (isSelected) self.selectedPoint = null;
        destroy(point);
        self.refreshPartitionContext?.();
      },

      addPoint(x, y) {
        if (self.closed) return;

        let point = self.control?.getSnappedPoint({ x, y }) || { x, y };
        const previous = self.points[self.points.length - 1];

        if (self.control?.constrainto) {
          point = self.parent.constrainPoint(self, previous || point, point);
          if (previous) {
            const snapped = self.parent.snapEdgeToOpening(self, previous, point);
            if (snapped) {
              previous.x = snapped.segment[0].x;
              previous.y = snapped.segment[0].y;
              point = snapped.segment[1];
            }
          }
        }

        self._addPoint(point.x, point.y);
      },

      setPoints(points) {
        const previous = self.points.map((point) => ({ x: point.x, y: point.y }));
        let target = self.points.map((_, index) => ({ x: points[index * 2], y: points[index * 2 + 1] }));
        if (self.control?.constrainto) {
          const room = self.parent.getRoomPolygon(self.partitionContext?.parent_room_id);
          if (room) target = clampPolygonTransform(previous, target, room);
        }
        self.points.forEach((point, index) => {
          point.x = target[index].x;
          point.y = target[index].y;
        });
        self.refreshPartitionContext?.();
      },

      moveByCanvasOffset(offsetX, offsetY) {
        const dx = self.parent.canvasToInternalX(offsetX);
        const dy = self.parent.canvasToInternalY(offsetY);
        const previous = self.points.map((point) => ({ x: point.x, y: point.y }));
        let target = previous.map((point) => ({ x: point.x + dx, y: point.y + dy }));
        if (self.control?.constrainto) {
          const room = self.parent.getRoomPolygon(self.partitionContext?.parent_room_id);
          if (room) target = clampPolygonTransform(previous, target, room);
        }
        self.points.forEach((point, index) => {
          point.x = target[index].x;
          point.y = target[index].y;
        });
        self.refreshPartitionContext?.();
      },

      moveVertex(point, target) {
        let accepted = self.parent.constrainPoint(self, { x: point.x, y: point.y }, target);
        const index = self.points.indexOf(point);
        const previous = self.points[(index - 1 + self.points.length) % self.points.length];
        const next = self.points[(index + 1) % self.points.length];
        const previousPosition = previous ? { x: previous.x, y: previous.y } : null;
        const nextPosition = next ? { x: next.x, y: next.y } : null;
        const previousSnap = previous && self.parent.snapEdgeToOpening(self, previous, accepted);
        const nextSnap = !previousSnap && next && self.parent.snapEdgeToOpening(self, accepted, next);
        if (previousSnap) {
          previous.x = previousSnap.segment[0].x;
          previous.y = previousSnap.segment[0].y;
          accepted = previousSnap.segment[1];
        } else if (nextSnap) {
          accepted = nextSnap.segment[0];
          next.x = nextSnap.segment[1].x;
          next.y = nextSnap.segment[1].y;
        }
        const candidate = self.points.map((current) => (current === point ? accepted : { x: current.x, y: current.y }));
        const room = self.parent.getRoomPolygon(self.partitionContext?.parent_room_id);
        if (room && (!isSimplePolygon(candidate) || !polygonInsidePolygon(candidate, room))) {
          if (previousPosition) {
            previous.x = previousPosition.x;
            previous.y = previousPosition.y;
          }
          if (nextPosition) {
            next.x = nextPosition.x;
            next.y = nextPosition.y;
          }
          return;
        }
        point.x = accepted.x;
        point.y = accepted.y;
        self.refreshPartitionContext?.();
      },

      insertPoint(insertIdx, x, y) {
        let pointCoords = self.control?.getSnappedPoint({
          x: self.parent.canvasToInternalX(x),
          y: self.parent.canvasToInternalY(y),
        });
        if (self.control?.constrainto) {
          pointCoords = self.parent.constrainPoint(self, self.points[insertIdx - 1] || pointCoords, pointCoords);
        }
        const isMatchWithPrevPoint =
          self.points[insertIdx - 1] && self.parent.isSamePixel(pointCoords, self.points[insertIdx - 1]);
        const isMatchWithNextPoint =
          self.points[insertIdx] && self.parent.isSamePixel(pointCoords, self.points[insertIdx]);

        if (isMatchWithPrevPoint || isMatchWithNextPoint) {
          return;
        }

        const p = {
          id: guidGenerator(),
          x: pointCoords.x,
          y: pointCoords.y,
          size: self.pointSize,
          style: self.pointStyle,
          index: self.points.length,
        };

        self.points.splice(insertIdx, 0, p);
        self.refreshPartitionContext?.();

        return self.points[insertIdx];
      },

      _addPoint(x, y) {
        const firstPoint = self.points[0];

        // This is mostly for "snap to pixel" mode,
        // 'cause there is also an ability to close polygon by clicking on the first point precisely
        if (self.parent.isSamePixel(firstPoint, { x, y })) {
          self.closePoly();
          return;
        }

        self.points.push({
          id: guidGenerator(),
          x,
          y,
          size: self.pointSize,
          style: self.pointStyle,
          index: self.points.length,
        });
      },

      closePoly() {
        if (self.closed || self.points.length < 3) return;
        if (self.control?.constrainto) {
          const polygon = self.points.map((point) => ({ x: point.x, y: point.y }));
          const room = self.parent.getRoomPolygon(self.partitionContext?.parent_room_id);
          if (!isSimplePolygon(polygon) || (room && !polygonInsidePolygon(polygon, room))) {
            self.parent.setRoomConstraintNotice?.("The polygon cannot close because it is invalid or leaves its room.");
            return;
          }
        }
        self.closed = true;
        self.refreshPartitionContext?.();
      },

      canClose(x, y) {
        if (self.points.length < 2) return false;

        const p1 = self.points[0];
        const p2 = { x, y };

        const r = 50;
        const dist_points = (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;

        if (dist_points < r) {
          return true;
        }
        return false;
      },

      destroyRegion() {
        detach(self.points);
        destroy(self.points);
      },

      afterUnselectRegion() {
        if (self.selectedPoint) {
          self.selectedPoint.selected = false;
        }

        // self.points.forEach(p => p.computeOffset());
      },

      setScale(x, y) {
        self.scaleX = x;
        self.scaleY = y;
      },

      updateImageSize() {},

      /**
       * @example
       * {
       *   "original_width": 1920,
       *   "original_height": 1280,
       *   "image_rotation": 0,
       *   "value": {
       *     "points": [[2, 2], [3.5, 8.1], [3.5, 12.6]],
       *     "polygonlabels": ["Car"]
       *   }
       * }
       * @typedef {Object} PolygonRegionResult
       * @property {number} original_width width of the original image (px)
       * @property {number} original_height height of the original image (px)
       * @property {number} image_rotation rotation degree of the image (deg)
       * @property {Object} value
       * @property {number[][]} value.points list of (x, y) coordinates of the polygon by percentage of the image size (0-100)
       */

      /**
       * @return {PolygonRegionResult}
       */
      serialize() {
        const value = {
          points: self.points.map((p) => [p.x, p.y]),
          closed: self.closed,
        };

        return self.parent.createSerializedResult(self, value);
      },
    };
  });

const PolygonRegionModel = types.compose(
  "PolygonRegionModel",
  RegionsMixin,
  AreaMixin,
  NormalizationMixin,
  KonvaRegionMixin,
  Model,
);

/**
 * Get coordinates of anchor point
 * @param {array} flattenedPoints
 * @param {number} cursorX coordinates of cursor X
 * @param {number} cursorY coordinates of cursor Y
 */
function getAnchorPoint({ flattenedPoints, cursorX, cursorY }) {
  const [point1X, point1Y, point2X, point2Y] = flattenedPoints;
  const y =
    ((point2X - point1X) * (point2X * point1Y - point1X * point2Y) +
      (point2X - point1X) * (point2Y - point1Y) * cursorX +
      (point2Y - point1Y) * (point2Y - point1Y) * cursorY) /
    ((point2Y - point1Y) * (point2Y - point1Y) + (point2X - point1X) * (point2X - point1X));
  const x =
    cursorX -
    ((point2Y - point1Y) *
      (point2X * point1Y - point1X * point2Y + cursorX * (point2Y - point1Y) - cursorY * (point2X - point1X))) /
      ((point2Y - point1Y) * (point2Y - point1Y) + (point2X - point1X) * (point2X - point1X));

  return [x, y];
}

function getFlattenedPoints(points) {
  const p = points.map((p) => [p.canvasX, p.canvasY]);

  return p.reduce((flattenedPoints, point) => flattenedPoints.concat(point), []);
}

function getHoverAnchor({ layer }) {
  return layer.findOne(".hoverAnchor");
}

/**
 * Create new anchor for current polygon
 */
function createHoverAnchor({ point, group, layer, zoom }) {
  const hoverAnchor = new Konva.Circle({
    name: "hoverAnchor",
    x: point[0],
    y: point[1],
    stroke: green.primary,
    fill: green[0],
    scaleX: 1 / (zoom || 1),
    scaleY: 1 / (zoom || 1),

    strokeWidth: 2,
    radius: 5,
  });

  group.add(hoverAnchor);
  layer.draw();
  return hoverAnchor;
}

function moveHoverAnchor({ point, group, layer, zoom }) {
  const hoverAnchor = getHoverAnchor({ layer }) || createHoverAnchor({ point, group, layer, zoom });

  hoverAnchor.to({ x: point[0], y: point[1], duration: 0 });
}

function removeHoverAnchor({ layer }) {
  const hoverAnchor = getHoverAnchor({ layer });

  if (!hoverAnchor) return;
  hoverAnchor.destroy();
  layer.draw();
}

const Poly = memo(
  observer(({ item, colors, dragProps, draggable }) => {
    const { flattenedPoints } = item;
    const name = "poly";

    return (
      <Group key={name} name={name}>
        <Line
          name="_transformable"
          lineJoin="round"
          lineCap="square"
          stroke={colors.strokeColor}
          strokeWidth={colors.strokeWidth}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          shadowForStrokeEnabled={false}
          points={flattenedPoints}
          fill={colors.fillColor}
          closed={true}
          {...dragProps}
          onTransformEnd={(e) => {
            if (e.target !== e.currentTarget) return;

            const t = e.target;

            const d = [t.getAttr("x", 0), t.getAttr("y", 0)];
            const scale = [t.getAttr("scaleX", 1), t.getAttr("scaleY", 1)];
            const points = t.getAttr("points");

            item.setPoints(
              points.reduce((result, coord, idx) => {
                const isXCoord = idx % 2 === 0;

                if (isXCoord) {
                  const point = item.control?.getSnappedPoint({
                    x: item.parent.canvasToInternalX(coord * scale[0] + d[0]),
                    y: item.parent.canvasToInternalY(points[idx + 1] * scale[1] + d[1]),
                  });

                  result.push(point.x, point.y);
                }
                return result;
              }, []),
            );

            t.setAttr("x", 0);
            t.setAttr("y", 0);
            t.setAttr("scaleX", 1);
            t.setAttr("scaleY", 1);
          }}
          draggable={draggable}
        />
      </Group>
    );
  }),
);

/**
 * Line between 2 points
 */
const Edge = observer(({ name, item, idx, p1, p2, closed, regionStyles }) => {
  const insertIdx = idx + 1; // idx1 + 1 or idx2
  const flattenedPoints = [p1.canvasX, p1.canvasY, p2.canvasX, p2.canvasY];

  const lineProps = closed
    ? {
        stroke: "transparent",
        strokeWidth: regionStyles.strokeWidth,
        strokeScaleEnabled: false,
      }
    : {
        stroke: regionStyles.strokeColor,
        strokeWidth: regionStyles.strokeWidth,
        strokeScaleEnabled: false,
      };

  return (
    <Group
      key={name}
      name={name}
      onClick={(e) => item.handleLineClick({ e, flattenedPoints, insertIdx })}
      onMouseMove={(e) => {
        if (!item.closed || !item.selected || item.isReadOnly()) return;

        item.handleMouseMove({ e, flattenedPoints });
      }}
      onMouseLeave={(e) => item.handleMouseLeave({ e })}
    >
      <Line
        lineJoin="round"
        opacity={1}
        points={flattenedPoints}
        hitStrokeWidth={20}
        strokeScaleEnabled={false}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
        {...lineProps}
      />
    </Group>
  );
});

const Edges = memo(
  observer(({ item, regionStyles }) => {
    const { points, closed } = item;
    const name = "borders";

    if (item.closed && (item.parent.useTransformer || !item.selected)) {
      return null;
    }
    return (
      <Group key={name} name={name}>
        {points.map((p, idx) => {
          const idx1 = idx;
          const idx2 = idx === points.length - 1 ? 0 : idx + 1;

          if (!closed && idx2 === 0) {
            return null;
          }

          return (
            <Edge
              key={`border_${idx1}_${idx2}`}
              name={`border_${idx1}_${idx2}`}
              item={item}
              idx={idx1}
              p1={points[idx]}
              p2={points[idx2]}
              closed={closed}
              regionStyles={regionStyles}
            />
          );
        })}
      </Group>
    );
  }),
);

const HtxPolygonView = ({ item, setShapeRef }) => {
  const { store } = item;
  const { suggestion } = useContext(ImageViewContext) ?? {};

  const regionStyles = useRegionStyles(item, {
    useStrokeAsFill: true,
  });
  const isReference = shouldRenderRoomReference(item);
  const isFocused = isReference && item.parent?.focusedRoom?.cleanId === item.cleanId;
  const displayStyles = isReference
    ? {
        fillColor: withAlpha(regionStyles.fillColor || regionStyles.strokeColor, isFocused ? 0.12 : 0.05),
        strokeColor: withAlpha(regionStyles.strokeColor, isFocused ? 0.95 : 0.35),
        strokeWidth: isFocused ? 2 : 1,
      }
    : regionStyles;

  function renderCircle({ points, idx }) {
    const name = `anchor_${points.length}_${idx}`;
    const point = points[idx];

    if (!item.closed || (item.closed && item.selected)) {
      return <PolygonPointView item={point} name={name} key={name} />;
    }
  }

  function renderCircles(points) {
    const name = "anchors";

    if (item.closed && (item.parent.useTransformer || !item.selected)) {
      return null;
    }
    return (
      <Group key={name} name={name}>
        {points.map((p, idx) => renderCircle({ points, idx }))}
      </Group>
    );
  }

  const dragProps = useMemo(() => {
    let isDragging = false;

    return {
      onDragStart: (e) => {
        if (e.target !== e.currentTarget) return;
        if (item.parent.getSkipInteractions()) {
          e.currentTarget.stopDrag(e.evt);
          return;
        }
        isDragging = true;
        item.annotation.setDragMode(true);

        item.annotation.history.freeze(item.id);
      },
      dragBoundFunc: createDragBoundFunc(item, { x: -item.bboxCoords.left, y: -item.bboxCoords.top }),
      onDragEnd: (e) => {
        if (!isDragging) return;
        const t = e.target;

        if (e.target === e.currentTarget) {
          item.annotation.setDragMode(false);

          const point = item.control?.getSnappedPoint({
            x: item.parent?.canvasToInternalX(t.getAttr("x")),
            y: item.parent?.canvasToInternalY(t.getAttr("y")),
          });

          point.x = item.parent?.internalToCanvasX(point.x);
          point.y = item.parent?.internalToCanvasY(point.y);

          item.moveByCanvasOffset(point.x, point.y);
          item.annotation.history.unfreeze(item.id);
        }

        t.setAttr("x", 0);
        t.setAttr("y", 0);
        isDragging = false;
      },
    };
  }, [item.bboxCoords.left, item.bboxCoords.top]);

  useEffect(() => {
    if (!item.closed) item.control.tools.Polygon.resumeUnfinishedRegion(item);
  }, [item.closed]);

  if (!item.parent) return null;
  if (!item.inViewPort) return null;

  const stage = item.parent?.stageRef;

  return (
    <Group
      key={item.id ? item.id : guidGenerator(5)}
      name={item.id}
      ref={(el) => setShapeRef(el)}
      onMouseOver={() => {
        if (store.annotationStore.selected.isLinkingMode) {
          item.setHighlight(true);
        }
        item.updateCursor(true);
      }}
      onMouseOut={() => {
        if (store.annotationStore.selected.isLinkingMode) {
          item.setHighlight(false);
        }
        item.updateCursor();
      }}
      onClick={(e) => {
        // create regions over another regions with Cmd/Ctrl pressed
        if (item.parent.getSkipInteractions()) return;
        if (item.isDrawing) return;

        e.cancelBubble = true;

        if (!item.closed) return;

        if (store.annotationStore.selected.isLinkingMode) {
          stage.container().style.cursor = Constants.DEFAULT_CURSOR;
        }

        item.setHighlight(false);
        item.onClickRegion(e);
      }}
      {...dragProps}
      draggable={!item.isReadOnly() && (!item.inSelection || item.parent?.selectedRegions?.length === 1)}
      listening={!suggestion && !isReference}
    >
      <LabelOnPolygon item={item} color={displayStyles.strokeColor} />

      {item.mouseOverStartPoint}

      {item.points && item.closed ? (
        <Poly
          item={item}
          colors={displayStyles}
          dragProps={dragProps}
          draggable={!item.isReadOnly() && item.inSelection && item.parent?.selectedRegions?.length > 1}
        />
      ) : null}
      {item.points && !item.isReadOnly() ? <Edges item={item} regionStyles={displayStyles} /> : null}
      {item.points && !item.isReadOnly() ? renderCircles(item.points) : null}
    </Group>
  );
};

const HtxPolygon = AliveRegion(HtxPolygonView);

Registry.addTag("polygonregion", PolygonRegionModel, HtxPolygon);
Registry.addRegionType(PolygonRegionModel, "image", (value) => !!value.points);

export { PolygonRegionModel, HtxPolygon, getAnchorPoint, getFlattenedPoints, moveHoverAnchor, removeHoverAnchor };
