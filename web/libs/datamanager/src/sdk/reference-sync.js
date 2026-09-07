// The controller owns transport only. Editor results are changed only at an idle
// boundary, after checking the same annotation and fingerprint again after I/O.
export function isReferenceBusy(annotation, pointerDown = false) {
  return !annotation || pointerDown || annotation.isDraftSaving || !!annotation.submissionStarted ||
    annotation.hasIncompletePolygons || annotation.objects?.some((object) => object.isDrawing);
}

export function hasReferenceEdits(annotation) {
  if (!annotation) return false;
  if (annotation.savedResultFingerprint !== null && annotation.savedResultFingerprint !== undefined) {
    return annotation.savedResultFingerprint !== annotation.draftResultFingerprint;
  }
  if (annotation.history?.hasChanges && !annotation.draftSaved) return true;
  if (
    annotation.history?.hasChanges &&
    new Date(annotation.history.lastAdditionTime) > new Date(annotation.draftSaved)
  ) return true;
  return false;
}

const derivedState = (results) => JSON.stringify((results || []).filter((result) =>
  result.meta?.reference_review || result.meta?.partition_context || result.meta?.occupancy_context)
  .map((result) => ({
    id: result.id,
    from_name: result.from_name,
    review: result.meta?.reference_review,
    context: result.meta?.partition_context || result.meta?.occupancy_context,
  }))
  .sort((a, b) => `${a.id}:${a.from_name}`.localeCompare(`${b.id}:${b.from_name}`)));

const MANUAL_REFERENCE_PROFILES = {
  function_zone_to_occupancy: { source: "L2", target: "L3" },
  occupancy_to_furniture_instances: { source: "L3", target: "L4" },
};

export class ReferenceSyncController {
  constructor(wrapper) {
    this.wrapper = wrapper;
    this.taskId = wrapper.task.id;
    this.listeners = new Set();
    this.state = {};
    this.stopped = false;
    this.pointerDown = false;
    this.focus = () => this.poll();
    this.pointerStart = () => { this.pointerDown = true; };
    this.pointerEnd = () => { this.pointerDown = false; };
    this.abort = new AbortController();
  }

  get annotation() { return this.wrapper.currentAnnotation; }
  get historical() { return this.annotation?.type !== "prediction" && !!this.annotation?.pk && !this.annotation?.draftSelected; }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(patch) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }
  seed(annotation, raw, { loaded = true } = {}) {
    if (raw?.reference_version && raw?.base_manual_hash) {
      annotation.setReferenceBaseline(raw, loaded);
      if (loaded) annotation.markDraftLoaded(raw.updated_at);
      if (!loaded && raw.result && annotation.serializeAnnotation) {
        const local = annotation.serializeAnnotation({ fast: true });
        const referenceIds = (results) => results.filter((result) => /^(room|portal)_(rectangle|polygon|vector)$/.test(result.from_name))
          .map((result) => result.id).sort().join(",");
        this.derivedPending = derivedState(raw.result) !== derivedState(local) || referenceIds(raw.result) !== referenceIds(local);
      }
      if (loaded) this.derivedPending = false;
    }
  }
  seedAll() {
    const task = this.wrapper.task;
    for (const annotation of [...this.wrapper.annotations, ...this.wrapper.predictions]) {
      const draft = task.drafts?.find((item) => Number(item.id) === Number(annotation.draftId));
      const submitted = task.annotations?.find((item) => String(item.id) === String(annotation.pk));
      const prediction = task.predictions?.find((item) => String(item.id) === String(annotation.parent_prediction || annotation.pk)) ||
        (!annotation.pk && task.predictions?.length === 1 ? task.predictions[0] : null);
      if (submitted) annotation.setReferenceTokens("result", submitted);
      this.seed(annotation, draft || submitted || prediction);
    }
  }
  ensureBaseline(annotation) {
    if (annotation.referenceVersion) return;
    const task = this.wrapper.task;
    const raw = task.drafts?.find((item) => Number(item.id) === Number(annotation.draftId)) ||
      task.annotations?.find((item) => String(item.id) === String(annotation.pk)) ||
      task.predictions?.find((item) => Number(item.id) === Number(annotation.parent_prediction)) ||
      (!annotation.pk && task.predictions?.length === 1 ? task.predictions[0] : null);
    if (raw) {
      // Never mark existing local edits as clean when a new annotation is saved.
      annotation.setReferenceBaseline(raw);
      if (!annotation.draftRevision) annotation.setDraftRevision(raw.updated_at);
    }
  }
  start() {
    this.seedAll();
    window.addEventListener("focus", this.focus);
    window.addEventListener("pointerdown", this.pointerStart, true);
    window.addEventListener("pointerup", this.pointerEnd, true);
    window.addEventListener("pointercancel", this.pointerEnd, true);
    this.timer = setInterval(() => this.poll(), 5000);
    this.poll();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    window.removeEventListener("focus", this.focus);
    window.removeEventListener("pointerdown", this.pointerStart, true);
    window.removeEventListener("pointerup", this.pointerEnd, true);
    window.removeEventListener("pointercancel", this.pointerEnd, true);
    this.listeners.clear();
  }
  async request(path, body) {
    const csrf = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("csrftoken="));
    const response = await fetch(path, {
      credentials: "same-origin", cache: "no-store", signal: this.abort.signal,
      ...(body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf?.slice(10) || "") },
        body: JSON.stringify(body),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.validation_errors?.detail || `请求失败 (${response.status})`);
    return data;
  }
  busy(annotation = this.annotation, explicit = false) {
    const active = document.activeElement;
    const typing = !explicit && active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    return this.applying || typing || isReferenceBusy(annotation, this.pointerDown) ||
      this.wrapper.lsf?.isSubmitting || this.wrapper.lsf?.annotationStore?.viewingAll;
  }
  async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const status = await this.request(`/api/tasks/${this.taskId}/reference-sync/`);
      this.emit({ status, error: "" });
      const annotation = this.annotation;
      if (status.apply_policy !== "manual" && status.enabled && status.mode === "target" && status.status === "synced" &&
          annotation?.referenceVersion && (annotation.referenceVersion !== status.reference_version || this.derivedPending) &&
          !this.historical && !this.busy(annotation) && !hasReferenceEdits(annotation)) {
        await this.apply(false);
      }
    } catch (error) {
      if (error.name !== "AbortError") this.emit({ error: error.message });
    } finally { this.polling = false; }
  }
  async retry() {
    try {
      await this.request(`/api/tasks/${this.taskId}/reference-sync/`, {});
      await this.poll();
    } catch (error) { this.emit({ error: error.message }); }
  }
  async repairSourceMetadata() {
    const annotation = this.annotation;
    const status = this.state.status;
    const current = status?.mode === "source" ? status.bindings?.[0] : null;
    if (!current?.source_metadata_repair_available) throw new Error("当前没有可安全修复的 Room v3 派生元数据");
    if (this.busy(annotation, true) || hasReferenceEdits(annotation))
      throw new Error("当前窗口还有未保存修改，请先完成或撤销修改，再修复已提交标注");
    if (!current.source_annotation_updated_at) throw new Error("缺少来源标注版本，请重新加载同步状态");
    this.applying = true;
    this.emit({ busy: true, error: "" });
    try {
      const repaired = await this.request(`/api/tasks/${this.taskId}/reference-sync/repair-source/`, {
        expected_annotation_updated_at: current.source_annotation_updated_at,
      });
      const count = (repaired.repaired_portal_ids?.length || 0) + (repaired.repaired_room_ids?.length || 0);
      this.emit({ notice: `已修复 ${count} 个 Room/Portal 的派生元数据，正在重新同步；几何和类别未改变` });
    } catch (error) {
      this.emit({ error: error.message });
      throw error;
    } finally {
      this.applying = false;
      this.emit({ busy: false });
    }
    await this.poll();
  }
  async apply(explicit = true, enterReview = false) {
    if (this.state.status?.apply_policy === "manual") {
      if (!explicit) return;
      return this.applyManualReference();
    }
    const annotation = this.annotation;
    if (this.busy(annotation, explicit)) throw new Error("请先完成绘制或等待保存完成；当前画面已保留");
    if (this.historical && !enterReview) return;
    this.applying = true;
    this.emit({ busy: true, error: "" });
    try {
      if (hasReferenceEdits(annotation)) {
        if (!explicit) return;
        await annotation.saveDraftImmediatelyWithResults();
      }
      const fingerprint = annotation.draftResultFingerprint;
      const status = await this.request(`/api/tasks/${this.taskId}/reference-sync/`);
      if (status.status !== "synced") throw new Error(status.error || "Room 参考正在同步，请稍后再试");
      const draft = status.drafts.find((item) => Number(item.id) === Number(annotation.draftId)) ||
        (enterReview ? status.drafts.find((item) => String(item.annotation_id) === String(annotation.pk)) : null);
      let raw;
      if (draft) {
        raw = await this.request(`/api/drafts/${draft.id}/`);
      } else {
        if (annotation.pk || hasReferenceEdits(annotation)) throw new Error("未找到对应复核草稿，请保留当前窗口并重试同步");
        const task = await this.request(`/api/tasks/${this.taskId}/?resolve_uri=false`);
        raw = task.predictions.find((item) => item.reference_version === status.reference_version);
      }
      if (!raw?.reference_version || raw.reference_version !== status.reference_version)
        throw new Error("参考在加载期间再次变化，请重试；当前画面未改动");
      if (this.stopped || annotation !== this.annotation || fingerprint !== annotation.draftResultFingerprint ||
          isReferenceBusy(annotation, this.pointerDown)) {
        this.emit({ notice: "加载期间继续编辑了标注，已保留现场；请完成后安全应用参考" });
        return;
      }
      this.replace(annotation, raw, !!draft);
      this.emit({ status, notice: enterReview ? "已进入复核草稿；原提交结果保持不变" : "已加载最新 Room 参考；人工内容已保留" });
    } catch (error) {
      this.emit({ error: `${error.message}。当前修改仍在窗口中，可导出备份。` });
      throw error;
    } finally { this.applying = false; this.emit({ busy: false }); }
  }
  replace(annotation, raw, isDraft) {
    const views = annotation.objects.map((object) => ({
      object,
      zoom: object.currentZoom,
      x: object.zoomingPositionX,
      y: object.zoomingPositionY,
      focus: object.focusedRoomId,
      occupancyFocus: object.occupancyFocusId,
      furnitureInstanceFocus: object.furnitureInstanceFocusId,
    }));
    const recovery = annotation.serializeAnnotation({ fast: true });
    annotation.pauseAutosave();
    annotation.history.freeze();
    try {
      annotation.deleteAllRegions({ deleteReadOnly: true });
      annotation.deserializeResults(raw.result);
      if (isDraft) {
        annotation.addVersions({ draft: raw.result });
        annotation.setDraftId(raw.id);
        annotation.setDraftSaved(raw.updated_at);
      }
      annotation.updateObjects();
      this.seed(annotation, raw);
    } catch (error) {
      annotation.deleteAllRegions({ deleteReadOnly: true });
      annotation.deserializeResults(recovery);
      annotation.updateObjects();
      throw error;
    } finally {
      annotation.history.safeUnfreeze();
      annotation.history.reinit();
      for (const view of views) {
        if (view.zoom !== undefined) view.object.setZoom?.(view.zoom);
        if (view.x !== undefined) view.object.setZoomPosition?.(view.x, view.y);
        if (view.furnitureInstanceFocus) {
          const exists = view.object.furnitureInstanceParents?.some((parent) => parent.id === view.furnitureInstanceFocus);
          view.object.setFurnitureInstanceFocus?.(exists ? view.furnitureInstanceFocus : "");
          if (!exists) this.emit({ focusNotice: "原 Focus 家具组团已在来源中删除，已清空选择；实例仍保留为待复核/过期" });
        }
        if (view.occupancyFocus) view.object.setOccupancyFocus?.(view.object.occupancyParents?.some((p) => p.id === view.occupancyFocus) ? view.occupancyFocus : "");
        if (view.focus) {
          const exists = view.object.roomReferenceRegions?.some((room) => room.cleanId === view.focus);
          view.object.setFocusedRoom?.(exists ? view.focus : null);
          if (!exists) this.emit({ focusNotice: "原 Focus room 已在来源中删除，已清空选择；分区仍保留" });
        }
      }
      annotation.startAutosave();
    }
  }
  async review(regionIds) {
    const annotation = this.annotation;
    const uniqueRegionIds = [...new Set((regionIds || []).filter((id) => typeof id === "string" && id))];
    if (!uniqueRegionIds.length) throw new Error("当前没有可确认的参考复核对象");
    if (this.busy(annotation, true)) throw new Error("请先完成绘制或等待保存完成");
    if (annotation.referenceVersion !== this.state.status?.reference_version)
      throw new Error("请先安全应用最新参考，再确认复核");
    this.applying = true;
    this.emit({ busy: true, error: "" });
    try {
      await annotation.saveDraftImmediatelyWithResults();
      const fingerprint = annotation.draftResultFingerprint;
      const raw = await this.request(`/api/tasks/${this.taskId}/reference-sync/review/`, {
        draft_id: annotation.draftId, expected_updated_at: annotation.draftRevision,
        reference_version: annotation.referenceVersion, region_ids: uniqueRegionIds,
      });
      if (this.stopped || annotation !== this.annotation || fingerprint !== annotation.draftResultFingerprint ||
          isReferenceBusy(annotation, this.pointerDown)) throw new Error("复核期间画面发生修改，已保留本地内容，请重新核对");
      this.replace(annotation, raw, true);
      this.emit({ notice: `已保存 ${uniqueRegionIds.length} 个对象的参考变更复核；尚未提交功能分区标注` });
    } catch (error) { this.emit({ error: error.message }); throw error; }
    finally { this.applying = false; this.emit({ busy: false }); }
    await this.poll();
  }

  async applyOccupancyReference() {
    return this.applyManualReference("function_zone_to_occupancy");
  }

  async applyFurnitureInstancesReference() {
    return this.applyManualReference("occupancy_to_furniture_instances");
  }

  async applyManualReference(expectedSyncType = this.state.status?.sync_type) {
    const annotation = this.annotation;
    if (this.busy(annotation, true)) throw new Error("请先完成绘制或等待保存");
    const profile = MANUAL_REFERENCE_PROFILES[this.state.status?.sync_type];
    if (!profile || this.state.status?.sync_type !== expectedSyncType)
      throw new Error("不是受支持的手动参考配置");
    const sourceVersion = this.state.status.source_version;
    this.applying = true;
    this.emit({ busy: true, error: "" });
    try {
      await annotation.saveDraftImmediatelyWithResults();
      if (!annotation.draftId) throw new Error("请先创建并保存复核草稿");
      const fingerprint = annotation.draftResultFingerprint;
      const raw = await this.request(`/api/tasks/${this.taskId}/reference-sync/apply/`, {
        draft_id: annotation.draftId, expected_updated_at: annotation.draftRevision,
        reference_version: annotation.referenceVersion, base_manual_hash: annotation.baseManualHash,
        source_version: sourceVersion,
      });
      if (this.stopped || annotation !== this.annotation || fingerprint !== annotation.draftResultFingerprint || isReferenceBusy(annotation, this.pointerDown))
        throw new Error("应用期间本地继续编辑，已保留现场；服务器已保存参考更新，请导出本地后处理版本冲突");
      this.replace(annotation, raw, true);
      this.emit({ notice: `已手动应用最新 ${profile.source} 参考；${profile.target} 人工几何、类别和原归属保持不变` });
    } catch (error) { this.emit({ error: error.message }); throw error; }
    finally { this.applying = false; this.emit({ busy: false }); }
    await this.poll();
  }

  async checkOccupancyReference(expectedVersion) {
    return this.checkManualReference(expectedVersion, "function_zone_to_occupancy");
  }

  async checkFurnitureInstancesReference(expectedVersion) {
    return this.checkManualReference(expectedVersion, "occupancy_to_furniture_instances");
  }

  async checkManualReference(expectedVersion, syncType) {
    // Explicit safety checks must await their own fresh response, even if the
    // periodic poll is in flight. Never treat an old cached status as verified.
    const status = await this.request(`/api/tasks/${this.taskId}/reference-sync/`);
    this.emit({ status, error: "" });
    const profile = MANUAL_REFERENCE_PROFILES[syncType];
    if (!profile || !status.enabled || status.sync_type !== syncType || status.error ||
        status.source_version !== expectedVersion || status.reference_version !== expectedVersion)
      throw new Error(status.error || `${profile?.source || "上级"} 参考已变化，请先保存、备份并手动应用参考`);
    return status;
  }
}
