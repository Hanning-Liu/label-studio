import { applySnapshot, flow, getSnapshot, types } from "mobx-state-tree";
import { vectorReviewDockEnabled, vectorReviewRows } from "../utils/vectorReviewDock";

export const VectorReview = types
  .model("VectorReview", {})
  .volatile(() => ({ vectorReviewBusy: false }))
  .actions((self) => ({
    vectorReviewBlockReason() {
      if (!vectorReviewDockEnabled(self)) return "当前标注不可编辑";
      const annotation = self.annotation;
      if (annotation.submissionStarted) return "提交正在进行";
      if (
        self.isDrawing ||
        annotation.isDrawing ||
        annotation.hasIncompletePolygons ||
        self.regs.some((r) => r.incomplete || r.isDrawing)
      )
        return "请先完成或取消当前绘制";
      const controller = annotation.store.referenceSyncController;
      const status = controller?.state?.status;
      if (controller?.state?.busy) return "参考同步正在进行";
      if (controller && !status) return "参考版本尚未就绪";
      if (status?.enabled && status.mode !== "source" && status.reference_version !== annotation.referenceVersion)
        return "请先保存人工修改并安全应用新参考";
      return "";
    },
    captureVectorReview() {
      const rows = vectorReviewRows(self).filter((row) => !row.reviewed);
      return {
        rows: rows.map(({ id, type, label }) => ({ id, type, label })),
        fingerprint: JSON.stringify({
          reference: self.annotation.referenceVersion,
          zones: self.functionZoneRegions.map((region) => ({
            id: region.cleanId,
            value: region.serialize({ fast: true })?.value,
          })),
          rows: rows
            .map((row) => {
              const result = row.region.results
                .find((r) => self.connectionVectorControlNames.has(r.from_name?.name))
                .serialize({ fast: true });
              return {
                id: row.id,
                control: row.control?.name,
                value: result.value,
                width: result.original_width,
                height: result.original_height,
                rotation: result.image_rotation,
              };
            })
            .sort((a, b) => a.id.localeCompare(b.id)),
        }),
      };
    },
    setVectorReview(ids, reviewed, expectedFingerprint) {
      const reason = self.vectorReviewBlockReason();
      if (reason) throw new Error(reason);
      if (expectedFingerprint && expectedFingerprint !== self.captureVectorReview().fingerprint)
        throw new Error("确认期间 Vector 或参考版本已变化，请重新检查");
      const available = vectorReviewRows(self);
      if (new Set(ids).size !== ids.length) throw new Error("复核对象重复");
      const rows = ids.map((id) => available.find((row) => row.id === id));
      if (
        rows.some(
          (row) =>
            !row?.control?.perregion ||
            !row.control.children.some((c) => c.value === "Reviewed") ||
            row.region.results.filter((r) => r.from_name === row.control).length > 1,
        )
      )
        throw new Error("复核对象或控件已变化，请重新检查");
      const snapshots = rows.map((row) => getSnapshot(row.region.results));
      const history = self.annotation.history;
      history.freeze("vector-review");
      try {
        for (const row of rows) {
          const result = row.region.results.find((r) => r.from_name === row.control);
          const values = (result?.mainValue || []).filter((value) => value !== "Reviewed");
          if (reviewed) values.push("Reviewed");
          if (result) result.setValue(values);
          else if (reviewed)
            row.region.addResult({
              area: row.region,
              from_name: row.control,
              to_name: self,
              type: "choices",
              value: { choices: values },
            });
        }
      } catch (error) {
        rows.forEach((row, index) => applySnapshot(row.region.results, snapshots[index]));
        throw error;
      } finally {
        try {
          rows.forEach((row) => row.control.needsUpdate());
        } finally {
          history.unfreeze("vector-review");
        }
      }
      return ids.length;
    },
  }))
  .actions((self) => ({
    confirmAllVectorsAndSave: flow(function* (preview) {
      if (self.vectorReviewBusy) throw new Error("复核操作正在进行，请勿重复点击");
      if (!preview?.rows?.length) return 0;
      let applied = false;
      self.vectorReviewBusy = true;
      try {
        const reason = self.vectorReviewBlockReason();
        if (reason) throw new Error(reason);
        yield self.annotation.saveDraftImmediatelyWithResults();
        const count = self.setVectorReview(
          preview.rows.map((row) => row.id),
          true,
          preview.fingerprint,
        );
        applied = true;
        yield self.annotation.saveDraftImmediatelyWithResults();
        return count;
      } catch (error) {
        if (applied) throw new Error(`复核已保留在本地，但草稿未保存：${error.message}。请重试保存或导出备份。`);
        throw error;
      } finally {
        self.vectorReviewBusy = false;
      }
    }),
  }));
