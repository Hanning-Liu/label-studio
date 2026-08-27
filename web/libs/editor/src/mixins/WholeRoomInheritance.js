import { applySnapshot, getSnapshot, types } from "mobx-state-tree";
import { guidGenerator } from "../core/Helpers";
import {
  buildWholeRoomResults,
  inheritanceCandidates,
  inheritanceReview,
  zoneFingerprint,
} from "../utils/wholeRoomInheritance";
import { partitionContext } from "../utils/roomConstraintGeometry";

export const WholeRoomInheritance = types
  .model("WholeRoomInheritance", {
    wholeroomzoneinheritance: types.optional(types.boolean, false),
  })
  .views((self) => ({
    get wholeRoomInheritanceEnabled() {
      return self.wholeroomzoneinheritance && self.functionzonev3validate;
    },
    get wholeRoomLabels() {
      return (
        self.annotation.names
          .get("function_zone")
          ?.children?.filter((tag) => tag.type === "label")
          .map((tag) => tag.value) || []
      );
    },
    get wholeRoomSources() {
      return self.roomReferenceRegions.map((room) => {
        getSnapshot(room);
        return {
          id: room.cleanId,
          roomType: room.roomGraphNode?.room_type || room.labelName,
          result: room.results.find((result) => result.meta?.room_graph_node).serialize(),
          polygon: self.getRoomPolygon(room.cleanId),
        };
      });
    },
    get wholeRoomZones() {
      return self.functionZoneRegions.map((region) => {
        getSnapshot(region);
        const geometry = region.results.find((result) => self.functionZoneControlNames.has(result.from_name?.name));
        const result = geometry.serialize();
        const labelResult = region.results.find((result) => result.from_name?.name === "function_zone");
        const label = labelResult?.mainValue?.[0] || "";
        const parentRoomId = result.meta?.partition_context?.parent_room_id;
        const source = self.wholeRoomSources.find((room) => room.id === parentRoomId);
        return {
          id: region.cleanId,
          region,
          geometry,
          result,
          labelResult,
          label,
          parentRoomId,
          source,
          review: inheritanceReview(result, label, source?.result, source?.roomType),
        };
      });
    },
    get wholeRoomCandidates() {
      const zones = self.wholeRoomZones;
      const orphanLabels = self.regs.some(
        (region) =>
          region.results.some((result) => result.from_name?.name === "function_zone") &&
          !zones.some((zone) => zone.id === region.cleanId),
      );
      return inheritanceCandidates(
        self.wholeRoomSources,
        zones,
        self.wholeRoomLabels,
        self.annotation.isDrawing || self.regs.some((region) => region.incomplete || region.isDrawing),
        orphanLabels,
      );
    },
    wholeRoomSubdivisionReason(zoneId) {
      const zone = self.wholeRoomZones.find((candidate) => candidate.id === zoneId);
      if (!zone?.review) return "请选择自动继承的整室分区";
      if (zone.region.isReadOnly()) return "此分区不可编辑";
      if (!zone.review.wholeRoom) return "分区已被调整，请使用常规工具手工处理";
      if (self.wholeRoomZones.filter((other) => other.parentRoomId === zone.parentRoomId).length !== 1)
        return "房间已有其他分区，请手工处理";
      if (
        self.annotation.relationStore
          .serialize()
          .some((relation) => [relation.from_id, relation.to_id].some((id) => String(id).split("#")[0] === zoneId))
      )
        return "分区存在手工 Relations，请先处理关系";
      return null;
    },
  }))
  .actions((self) => ({
    assertWholeRoomEditable() {
      if (!self.wholeRoomInheritanceEnabled || self.annotation.isReadOnly())
        throw new Error("整室继承未启用或当前标注不可编辑");
      if (self.annotation.submissionStarted) throw new Error("提交正在进行，请稍后操作");
    },
    generateWholeRoomZones(selections) {
      self.assertWholeRoomEditable();
      if (!selections.length || new Set(selections.map((choice) => choice.roomId)).size !== selections.length)
        throw new Error("请选择未重复的房间");
      const current = self.wholeRoomCandidates;
      const results = selections.flatMap((choice) => {
        const room = current.find((candidate) => candidate.id === choice.roomId);
        if (!room?.eligible || room.sourceFingerprint !== choice.sourceFingerprint)
          throw new Error("预览后房间或分区已变化，请重新打开预览");
        if (!self.wholeRoomLabels.includes(choice.label)) throw new Error("功能类别不在当前配置中");
        const controlName = room.result.type === "rectanglelabels" ? "zone_rectangle" : "zone_polygon";
        const control = self.annotation.names.get(controlName);
        if (!control) throw new Error(`缺少控件 ${controlName}`);
        return buildWholeRoomResults({
          roomResult: room.result,
          roomType: room.roomType,
          label: choice.label,
          id: guidGenerator(),
          context: partitionContext(room.polygon, room.id, self.getOpeningSegments(room.id, control), 1e-5, 3),
        });
      });
      const history = self.annotation.history;
      const previous = getSnapshot(self.annotation.areas);
      history.freeze("whole-room-inheritance");
      try {
        const added = self.annotation.appendResults(results);
        if (added?.length !== selections.length || added.some((region) => region.results.length !== 2))
          throw new Error("整室分区未完整载入，已取消此次生成");
        return added.map((region) => region.cleanId);
      } catch (error) {
        applySnapshot(self.annotation.areas, previous);
        self.annotation.updateObjects();
        throw error;
      } finally {
        history.unfreeze("whole-room-inheritance");
      }
    },
    refreshWholeRoomReviews() {
      if (!self.wholeRoomInheritanceEnabled) return;
      for (const zone of self.wholeRoomZones) {
        if (zone.review && !zone.review.reviewed && zone.result.meta.zone_inheritance.review_status === "reviewed") {
          zone.geometry.setMetaValue("zone_inheritance", {
            ...zone.result.meta.zone_inheritance,
            review_status: "pending",
          });
        }
      }
    },
    confirmWholeRoomZones(ids) {
      self.assertWholeRoomEditable();
      const zones = ids.map((id) => self.wholeRoomZones.find((zone) => zone.id === id));
      if (zones.some((zone) => !zone?.review || !zone.source || !self.wholeRoomLabels.includes(zone.label)))
        throw new Error("部分分区已变化，请重新检查");
      self.annotation.history.freeze("whole-room-review");
      try {
        for (const zone of zones) {
          zone.geometry.setMetaValue("zone_inheritance", {
            ...zone.result.meta.zone_inheritance,
            review_status: "reviewed",
            reviewed_zone_fingerprint: zoneFingerprint(zone.result, zone.label),
            reviewed_source_fingerprint: zone.review.sourceFingerprint,
          });
        }
      } finally {
        self.annotation.history.unfreeze("whole-room-review");
      }
    },
    setWholeRoomZoneLabel(id, label) {
      self.assertWholeRoomEditable();
      const zone = self.wholeRoomZones.find((zone) => zone.id === id);
      if (!zone?.review || !zone.labelResult || !self.wholeRoomLabels.includes(label))
        throw new Error("无法更新该分区类别");
      zone.labelResult.setValue([label]);
      self.refreshWholeRoomReviews();
      self.annotation.updateObjects();
    },
    startWholeRoomSubdivision(id) {
      self.assertWholeRoomEditable();
      const reason = self.wholeRoomSubdivisionReason(id);
      if (reason) throw new Error(reason);
      const zone = self.wholeRoomZones.find((zone) => zone.id === id);
      self.setFocusedRoom(zone.parentRoomId);
      self.annotation.history.freeze("whole-room-subdivision");
      try {
        zone.region.deleteRegion();
      } finally {
        self.annotation.history.unfreeze("whole-room-subdivision");
      }
    },
    validateWholeRoomInheritance() {
      if (!self.wholeRoomInheritanceEnabled) return [];
      self.refreshWholeRoomReviews();
      const pending = self.wholeRoomZones.filter((zone) => zone.review && !zone.review.reviewed);
      return pending.length
        ? [
            `${pending.length} 个自动继承分区尚未确认功能类别：${pending.map((zone) => `${zone.source?.roomType || "来源房间缺失"} (${zone.parentRoomId})`).join("、")}`,
          ]
        : [];
    },
  }));
