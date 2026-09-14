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

import { isAlive } from "mobx-state-tree";
import { formatFunctionZoneRoomLabel } from "@hanning/frontend/domain/rooms/functionZoneValidationLabels";

export const roomMetadataActions = (self) => ({
    refreshRoomV3Metadata() {
      if (!self.roomv3validate) return [];
      const tolerance = Number.parseFloat(self.roomv3tolerance) || 0.02;
      const rooms = self.roomV3Regions
        .map((region) => {
          const polygon = regionToInternalPolygon(region, self);
          const result = region.results.find((candidate) => self.roomV3RoomControlNames.has(candidate.from_name?.name));
          if (result) {
            result.setMetaValue("room_graph_node", {
              ...(result.meta?.room_graph_node || {}),
              schema_version: 3,
              node_id: region.cleanId,
              room_type: region.labelName || result.meta?.room_graph_node?.room_type || "Unclear/other",
              geometry_type: region.type === "rectangleregion" ? "rectangle" : "polygon",
            });
          }
          return { id: region.cleanId, region, result, polygon };
        })
        .filter((room) => room.result);
      const errors = [];
      rooms.forEach((room) => {
        if (!isSimplePolygon(room.polygon)) errors.push(`房间 ${room.id} 的几何无效或存在自交。`);
      });
      for (let first = 0; first < rooms.length; first++) {
        for (let second = first + 1; second < rooms.length; second++) {
          if (polygonsHavePositiveOverlap(rooms[first].polygon, rooms[second].polygon, tolerance)) {
            errors.push(`房间 ${rooms[first].id} 与 ${rooms[second].id} 发生面积重叠。`);
          }
        }
      }

      const pointToPixels = (point) => ({
        x: self.internalToImageX(point.x),
        y: self.internalToImageY(point.y),
      });
      const analyzeBoundaryContacts = (segments) => {
        const contacts = {};
        const segmentRooms = segments.map(() => new Set());
        segments.forEach((segment, segmentIndex) => {
          rooms.forEach((room) => {
            const overlaps = polygonBoundaryOverlaps(room.polygon, segment, tolerance);
            if (!overlaps.length) return;
            segmentRooms[segmentIndex].add(room.id);
            contacts[room.id] = [...(contacts[room.id] || []), ...overlaps];
          });
        });
        return { contacts, segmentRooms };
      };

      self.roomV3PortalRegions.forEach((portal) => {
        const result = portal.results.find(
          (candidate) =>
            self.roomV3PortalRectangleControlNames.has(candidate.from_name?.name) ||
            self.roomV3PortalVectorControlNames.has(candidate.from_name?.name),
        );
        if (!result) return;
        const openingType = normalizedOpeningType(portal.labelName || result.meta?.room_graph_edge?.opening_type);
        let connectedRoomIds = [];
        let boundarySegments = {};
        let geometryType = "vector";
        let clearWidthPercent = 0;
        let depthPercent = 0;
        let clearWidthPx = 0;
        let depthPx = 0;
        let centerline = [];
        let centerlinePx = [];

        if (self.roomV3PortalRectangleControlNames.has(result.from_name?.name)) {
          geometryType = "rectangle";
          const polygon = regionToInternalPolygon(portal, self);
          const geometry = rectanglePortalGeometry(polygon, tolerance);
          if (!geometry) {
            errors.push(`Portal ${portal.cleanId} 的矩形几何无效。`);
          } else {
            const contacts = analyzeBoundaryContacts(geometry.longEdges);
            boundarySegments = contacts.contacts;
            connectedRoomIds = Object.keys(boundarySegments).sort();
            const occupiedLongEdges = contacts.segmentRooms.filter((roomIds) => roomIds.size > 0).length;
            const duplicatedRoom = connectedRoomIds.some(
              (roomId) => contacts.segmentRooms.filter((roomIds) => roomIds.has(roomId)).length > 1,
            );
            const overlapsRoomInterior = rooms.some((room) =>
              polygonsHavePositiveOverlap(polygon, room.polygon, tolerance),
            );
            if (connectedRoomIds.length === 0 || connectedRoomIds.length > 2) {
              errors.push(`Portal ${portal.cleanId} 必须连接 1 个室内房间（入户）或 2 个室内房间。`);
            }
            if (connectedRoomIds.length === 2 && occupiedLongEdges !== 2) {
              errors.push(`Portal ${portal.cleanId} 的两条房间侧长边必须分别与两个房间共边。`);
            }
            if (connectedRoomIds.length === 1 && occupiedLongEdges !== 1) {
              errors.push(`入户 Portal ${portal.cleanId} 只能有一条房间侧长边与室内房间共边。`);
            }
            if (duplicatedRoom) errors.push(`Portal ${portal.cleanId} 的两条长边不能同时连接同一房间。`);
            if (overlapsRoomInterior) errors.push(`Portal ${portal.cleanId} 不得进入房间净空间内部。`);
            clearWidthPercent = geometry.clearWidth;
            depthPercent = geometry.depth;
            centerline = geometry.centerline;
            const pixelGeometry = rectanglePortalGeometry(polygon.map(pointToPixels), tolerance);
            clearWidthPx = pixelGeometry?.clearWidth || 0;
            depthPx = pixelGeometry?.depth || 0;
            centerlinePx = pixelGeometry?.centerline || [];
          }
        } else {
          const segment = vectorToInternalSegment(portal, self);
          if (!segment || segmentLength(segment) <= tolerance) {
            errors.push(`Open passage ${portal.cleanId} 必须是正长度两点 Vector。`);
          } else {
            const contacts = analyzeBoundaryContacts([segment]);
            boundarySegments = contacts.contacts;
            connectedRoomIds = Object.keys(boundarySegments).sort();
            const fullySupported = connectedRoomIds.every((roomId) => {
              const supportedLength = boundarySegments[roomId].reduce(
                (total, supported) => total + segmentLength(supported),
                0,
              );
              return supportedLength >= segmentLength(segment) - tolerance;
            });
            if (openingType !== "open_passage") {
              errors.push(`Portal Vector ${portal.cleanId} 只允许标注 Open passage。`);
            }
            if (connectedRoomIds.length !== 2 || !fullySupported) {
              errors.push(`Open passage ${portal.cleanId} 必须完整位于两个房间的共享边界上。`);
            }
            clearWidthPercent = segmentLength(segment);
            clearWidthPx = segmentLength(segment.map(pointToPixels));
            centerline = segment;
            centerlinePx = segment.map(pointToPixels);
          }
        }

        result.setMetaValue("room_graph_edge", {
          ...(result.meta?.room_graph_edge || {}),
          schema_version: 3,
          edge_id: portal.cleanId,
          opening_type: openingType,
          geometry_type: geometryType,
          connected_room_ids: connectedRoomIds,
          room_ids: connectedRoomIds,
          connects_to_exterior: geometryType === "rectangle" && connectedRoomIds.length === 1,
          clear_width_percent: clearWidthPercent,
          depth_percent: depthPercent,
          clear_width_px: clearWidthPx,
          depth_px: depthPx,
          centerline,
          centerline_px: centerlinePx,
          boundary_segments: boundarySegments,
        });
      });
      return errors;
    },

    refreshGeometryReviewMetadata() {
      self.connectionVectorRegions.forEach((region) => {
        const labeling = region.results.find((result) => self.connectionVectorControlNames.has(result.from_name?.name));
        if (!labeling) return;
        const reviewControl = self.geometryReviewControlFor(labeling.from_name?.name);
        const reviewed = region.results.some(
          (result) => result.from_name?.name === reviewControl && result.mainValue?.includes?.("Reviewed"),
        );
        labeling.setMetaValue("geometry_review", {
          ...(labeling.meta?.geometry_review || {}),
          schema_version: 3,
          status: reviewed ? "reviewed" : "pending",
        });
      });
    },

    validateFunctionZoneV3() {
      if (!self.functionzonev3validate) return [];
      const errors = [];
      const coverageTolerance = Number.parseFloat(self.functionzonecoveragetolerance) || 0.001;
      const zones = self.functionZoneRegions.map((region) => ({
        id: region.cleanId,
        region,
        polygon: regionToInternalPolygon(region, self),
        parentRoomId: region.partitionContext?.parent_room_id,
      }));
      const byRoom = new Map();
      zones.forEach((zone) => {
        const room = self.getRoomById(zone.parentRoomId);
        const roomPolygon = regionToInternalPolygon(room, self);
        if (!zone.parentRoomId || !roomPolygon) {
          errors.push(
            `功能分区 ${zone.id} 未能归属到有效的 Room v3 房间：${formatFunctionZoneRoomLabel(
              room,
              zone.parentRoomId,
            )}。`,
          );
          return;
        }
        if (!isSimplePolygon(zone.polygon) || !polygonInsidePolygon(zone.polygon, roomPolygon)) {
          errors.push(`功能分区 ${zone.id} 超出父房间 ${formatFunctionZoneRoomLabel(room)} 的净空间。`);
        }
        if (!byRoom.has(zone.parentRoomId)) byRoom.set(zone.parentRoomId, []);
        byRoom.get(zone.parentRoomId).push(zone);
      });

      byRoom.forEach((roomZones, roomId) => {
        const roomLabel = formatFunctionZoneRoomLabel(self.getRoomById(roomId), roomId);
        for (let first = 0; first < roomZones.length; first++) {
          for (let second = first + 1; second < roomZones.length; second++) {
            if (polygonsHavePositiveOverlap(roomZones[first].polygon, roomZones[second].polygon)) {
              errors.push(`房间 ${roomLabel} 内的分区 ${roomZones[first].id} 与 ${roomZones[second].id} 重叠。`);
            }
          }
        }
      });

      self.roomReferenceRegions.forEach((room) => {
        const roomPolygon = regionToInternalPolygon(room, self);
        if (!roomPolygon) return;
        const roomArea = polygonArea(roomPolygon);
        const zoneArea = (byRoom.get(room.cleanId) || []).reduce((total, zone) => total + polygonArea(zone.polygon), 0);
        if (roomArea <= 0 || Math.abs(roomArea - zoneArea) / roomArea > coverageTolerance) {
          errors.push(`房间 ${formatFunctionZoneRoomLabel(room)} 的功能分区未完整覆盖净空间。`);
        }
      });

      self.connectionVectorRegions.forEach((region) => {
        const labeling = region.results.find((result) => self.connectionVectorControlNames.has(result.from_name?.name));
        const reviewControl = self.geometryReviewControlFor(labeling?.from_name?.name);
        const reviewed = region.results.some(
          (result) => result.from_name?.name === reviewControl && result.mainValue?.includes?.("Reviewed"),
        );
        if (!reviewed) errors.push(`连通 Vector ${region.cleanId} 修改或迁移后尚未复核。`);
      });
      return errors;
    },

    invalidateGeometryReviews() {
      self.connectionVectorRegions.forEach((region) => region.invalidateGeometryReview?.());
    },
});

export const roomFocusActions = (self) => ({
    setFocusedRoom(roomId) {
      self.focusedRoomId = roomId || null;
      self.roomConstraintNotice = null;
      self.updateRoomConstraintTools();
    },

    setRoomConstraintNotice(message) {
      self.roomConstraintNotice = message || null;
    },

    updateRoomConstraintTools() {
      const enabled = !!self.focusedRoom;
      const referenceControls = new Set([
        ...self.roomControlNames,
        ...self.openingControlNames,
        ...self.roomV3ReferenceControlNames,
      ]);
      self
        .getToolsManager()
        .allTools()
        .forEach((tool) => {
          if (self.furnitureInstancesEnabled) {
            if (isAlive(tool) && self.furnitureInstanceIsReference(tool.control?.name)) tool.disable();
            else if (
              isAlive(tool) &&
              [
                "furniture_instance_rectangle",
                "furniture_instance_polygon",
                "furniture_front_direction",
                "furniture_front_edge",
              ].includes(tool.control?.name)
            )
              self.furnitureInstanceDrawBlockReason(tool.control?.name) ? tool.disable() : tool.enable();
            return;
          }
          if (self.occupancyEnabled) {
            if (isAlive(tool) && self.occupancyIsReference(tool.control?.name)) tool.disable();
            return;
          }
          if (referenceControls.has(tool.control?.name)) tool.disable();
          else if (tool.control?.constrainto) enabled ? tool.enable() : tool.disable();
        });
    },
});
