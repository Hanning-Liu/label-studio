import {
  clampPointToPolygon,
  clampRectangleTransform,
  isSimplePolygon,
  nearestPointOnPolygon,
  partitionContext,
  pointInPolygon,
  polygonArea,
  polygonBoundaryOverlaps,
  polygonInsidePolygon,
  polygonsHavePositiveOverlap,
  rectanglePortalGeometry,
  rotatedRectanglePoints,
  segmentInsidePolygon,
  snapSegmentToOpening,
} from "@hanning/frontend/domain/rooms/roomConstraintGeometry";
import { csvNames, rectangleToInternalPolygon, regionToInternalPolygon, vectorToInternalSegment, segmentLength, normalizedOpeningType, canvasRectangleFromEdge } from "@hanning/frontend/domain/rooms/imageGeometry";

export const roomViews = (self) => ({
    get roomConstraintControls() {
      return Array.from(self.annotation?.names?.values?.() || []).filter((control) => !!control.constrainto);
    },

    get hasRoomConstraints() {
      return self.roomConstraintControls.length > 0;
    },

    get roomControlNames() {
      const names = new Set();
      self.roomConstraintControls.forEach((control) =>
        csvNames(control.constrainto).forEach((name) => names.add(name)),
      );
      return names;
    },

    get openingControlNames() {
      const names = new Set();
      self.roomConstraintControls.forEach((control) =>
        csvNames(control.openingfrom).forEach((name) => names.add(name)),
      );
      return names;
    },

    get roomV3RoomControlNames() {
      return csvNames(self.roomv3controls);
    },

    get roomV3PortalRectangleControlNames() {
      return csvNames(self.portalrectanglecontrols);
    },

    get roomV3PortalVectorControlNames() {
      return csvNames(self.portalvectorcontrols);
    },

    get roomV3ReferenceControlNames() {
      return csvNames(self.roomv3referencecontrols);
    },

    get roomV3Regions() {
      return self.regs.filter((region) =>
        region.results.some((result) => self.roomV3RoomControlNames.has(result.from_name?.name)),
      );
    },

    get roomV3PortalRegions() {
      return self.regs.filter((region) =>
        region.results.some(
          (result) =>
            self.roomV3PortalRectangleControlNames.has(result.from_name?.name) ||
            self.roomV3PortalVectorControlNames.has(result.from_name?.name),
        ),
      );
    },

    get functionZoneControlNames() {
      return csvNames(self.functionzonecontrols);
    },

    get connectionVectorControlNames() {
      return csvNames(self.connectionvectorcontrols);
    },

    geometryReviewControlFor(vectorControlName) {
      const mapping = new Map(
        String(self.geometryreviewmap || "")
          .split(",")
          .map((item) => item.split(":").map((value) => value.trim()))
          .filter(([source, review]) => source && review),
      );
      return mapping.get(vectorControlName) || null;
    },

    get functionZoneRegions() {
      return self.regs.filter((region) =>
        region.results.some((result) => self.functionZoneControlNames.has(result.from_name?.name)),
      );
    },

    get connectionVectorRegions() {
      return self.regs.filter((region) =>
        region.results.some((result) => self.connectionVectorControlNames.has(result.from_name?.name)),
      );
    },

    get roomReferenceRegions() {
      const byId = new Map();
      [...self.regs, ...self.suggestions].forEach((region) => {
        const controlName = region.results.find((result) => result.meta?.room_graph_node)?.from_name?.name;
        if (region.isRoomReference && self.roomControlNames.has(controlName)) byId.set(region.cleanId, region);
      });
      return [...byId.values()];
    },

    get openingReferenceRegions() {
      const byId = new Map();
      [...self.regs, ...self.suggestions].forEach((region) => {
        const controlName = region.results.find((result) => result.meta?.room_graph_edge)?.from_name?.name;
        if (region.isOpeningReference && self.openingControlNames.has(controlName)) byId.set(region.cleanId, region);
      });
      return [...byId.values()];
    },

    get focusedRoom() {
      return self.roomReferenceRegions.find((region) => region.cleanId === self.focusedRoomId) || null;
    },

    get focusRoomOptions() {
      return self.roomReferenceRegions
        .map((region) => ({
          id: region.cleanId,
          label: `${region.roomGraphNode?.room_type || region.labelName || "Room"} · ${
            region.type === "rectangleregion" ? "Rectangle" : "Polygon"
          } · ${region.cleanId.slice(0, 8)}`,
        }))
        .sort((first, second) => first.label.localeCompare(second.label));
    },

    getRoomById(roomId) {
      return self.roomReferenceRegions.find((region) => region.cleanId === roomId) || null;
    },

    getRoomPolygon(roomId = self.focusedRoomId) {
      return regionToInternalPolygon(self.getRoomById(roomId), self);
    },

    isCanvasPointInFocusedRoom(canvasX, canvasY) {
      const room = self.getRoomPolygon();
      if (!room) return false;
      const [fixedX, fixedY] = self.fixZoomedCoords([canvasX, canvasY]);
      return pointInPolygon({ x: self.canvasToInternalX(fixedX), y: self.canvasToInternalY(fixedY) }, room);
    },

    getAreaPolygon(area) {
      return regionToInternalPolygon(area, self);
    },

    getConstraintParentRoomId(area) {
      return area?.partitionContext?.parent_room_id || self.focusedRoom?.cleanId || null;
    },

    getOpeningSegments(parentRoomId, control = null) {
      const allowed = control ? csvNames(control.openingfrom) : self.openingControlNames;
      return self.openingReferenceRegions
        .filter((opening) => {
          const result = opening.results.find((candidate) => candidate.meta?.room_graph_edge);
          const roomIds = opening.roomGraphEdge?.connected_room_ids || opening.roomGraphEdge?.room_ids || [];
          return allowed.has(result?.from_name?.name) && roomIds.includes(parentRoomId);
        })
        .flatMap((opening) => {
          const edge = opening.roomGraphEdge || {};
          const roomIds = [...(edge.connected_room_ids || edge.room_ids || [])];
          if (edge.connects_to_exterior && !roomIds.includes("Exterior")) roomIds.push("Exterior");
          const storedSegments = edge.boundary_segments?.[parentRoomId];
          if (Array.isArray(storedSegments) && storedSegments.length) {
            return storedSegments
              .map((segment) => {
                const points = Array.isArray(segment)
                  ? segment
                  : segment?.start && segment?.end
                    ? [segment.start, segment.end]
                    : null;
                return points?.length === 2 ? { id: opening.cleanId, roomIds, points } : null;
              })
              .filter(Boolean);
          }
          const points = vectorToInternalSegment(opening, self);
          return points ? [{ id: opening.cleanId, roomIds, points }] : [];
        })
        .filter(Boolean);
    },

    buildPartitionContext(area, parentRoomId) {
      const polygon = self.getAreaPolygon(area);
      if (!polygon || polygon.length < 3) return null;
      return partitionContext(
        polygon,
        parentRoomId,
        self.getOpeningSegments(parentRoomId, area.constraintControl),
        1e-5,
        Number.parseInt(self.partitioncontextschema, 10) || 1,
      );
    },

    constrainPoint(area, previous, target) {
      const parentRoomId = self.getConstraintParentRoomId(area);
      const room = self.getRoomPolygon(parentRoomId);
      if (!room) return target;
      const control = area?.constraintControl;
      const threshold = Number.parseFloat(control?.constraintsnappx || "10");
      const canvasDistance = (first, second) =>
        Math.hypot(
          self.internalToCanvasX(first.x - second.x) * self.zoomScale,
          self.internalToCanvasY(first.y - second.y) * self.zoomScale,
        );
      let candidate = target;
      const corner = room
        .map((point) => ({ point, distance: canvasDistance(point, target) }))
        .sort((first, second) => first.distance - second.distance)[0];
      if (corner?.distance <= threshold) {
        candidate = corner.point;
      } else {
        const boundary = nearestPointOnPolygon(target, room);
        if (boundary && canvasDistance(boundary, target) <= threshold) candidate = boundary;
      }
      return pointInPolygon(candidate, room) ? candidate : clampPointToPolygon(previous, candidate, room);
    },

    snapEdgeToOpening(area, start, end) {
      const parentRoomId = self.getConstraintParentRoomId(area);
      const room = self.getRoomPolygon(parentRoomId);
      const control = area?.constraintControl;
      if (!room || !control) return null;
      const threshold = Number.parseFloat(control.constraintsnappx || "10");
      const angle = Number.parseFloat(control.openingsnapangledeg || "5");
      const toCanvas = (point) => ({ x: self.internalToCanvasX(point.x), y: self.internalToCanvasY(point.y) });
      const toInternal = (point) => ({ x: self.canvasToInternalX(point.x), y: self.canvasToInternalY(point.y) });
      for (const opening of self.getOpeningSegments(parentRoomId, control)) {
        const snapped = snapSegmentToOpening(
          [toCanvas(start), toCanvas(end)],
          opening.points.map(toCanvas),
          threshold / self.zoomScale,
          angle,
        );
        if (!snapped) continue;
        const segment = snapped.segment.map(toInternal);
        if (segmentInsidePolygon(segment[0], segment[1], room)) return { ...snapped, segment, opening };
      }
      return null;
    },

    constrainRectangle(area, previous, target) {
      const parentRoomId = self.getConstraintParentRoomId(area);
      const room = self.getRoomPolygon(parentRoomId);
      if (!room) return target;
      const toPolygon = (attrs) => rectangleToInternalPolygon(area, self, attrs);
      const accepted = clampRectangleTransform(previous, target, room, toPolygon);
      const control = area?.constraintControl;
      if (!control) return accepted;

      const canvasAttrs = {
        x: self.internalToCanvasX(accepted.x),
        y: self.internalToCanvasY(accepted.y),
        width: self.internalToCanvasX(accepted.width),
        height: self.internalToCanvasY(accepted.height),
        rotation: accepted.rotation,
      };
      const rectangle = rotatedRectanglePoints(canvasAttrs);
      const threshold = Number.parseFloat(control.constraintsnappx || "10") / self.zoomScale;
      const angle = Number.parseFloat(control.openingsnapangledeg || "5");
      for (let edgeIndex = 0; edgeIndex < rectangle.length; edgeIndex++) {
        for (const opening of self.getOpeningSegments(parentRoomId, control)) {
          const openingCanvas = opening.points.map((point) => ({
            x: self.internalToCanvasX(point.x),
            y: self.internalToCanvasY(point.y),
          }));
          const snapped = snapSegmentToOpening(
            [rectangle[edgeIndex], rectangle[(edgeIndex + 1) % rectangle.length]],
            openingCanvas,
            threshold,
            angle,
          );
          if (!snapped) continue;
          const snappedCanvas = canvasRectangleFromEdge(canvasAttrs, edgeIndex, snapped.segment);
          const candidate = {
            x: self.canvasToInternalX(snappedCanvas.x),
            y: self.canvasToInternalY(snappedCanvas.y),
            width: self.canvasToInternalX(snappedCanvas.width),
            height: self.canvasToInternalY(snappedCanvas.height),
            rotation: snappedCanvas.rotation,
          };
          if (polygonInsidePolygon(toPolygon(candidate), room)) return candidate;
        }
      }
      return accepted;
    },
});
