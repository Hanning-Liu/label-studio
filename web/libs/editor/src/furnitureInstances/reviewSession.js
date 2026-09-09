import { action, computed, decorate, extendObservable, observable, reaction, runInAction } from "mobx";
import { useEffect } from "react";
import { applyFurnitureInstanceOperation, retryFurnitureInstanceSave } from "./operations";
import {
  emptyReviewCounts,
  furnitureReferenceBlock,
  furnitureReviewOrder,
  furnitureReviewSnapshot,
  nextFurnitureReviewId,
} from "./review";
import { focusFurnitureReview, furnitureReviewPoints } from "./reviewFocus";

const sessions = new WeakMap();

export class FurnitureReviewSession {
  connections = 0;
  disposers = [];
  lastFocus = "";
  lastReference = "";

  constructor(item) {
    this.annotation = item.annotation;
    extendObservable(
      this,
      {
        item,
        filter: "pending",
        checked: {},
        active: false,
        order: [],
        busy: false,
        unsaved: false,
        frozenCounts: null,
        pending: null,
        error: "",
        notice: "",
        problems: [],
        referenceStatus: this.annotation.store.referenceSyncController?.state?.status,
      },
      {
        item: observable.ref,
        checked: observable.ref,
        order: observable.ref,
        frozenCounts: observable.ref,
        pending: observable.ref,
        referenceStatus: observable.ref,
        problems: observable.ref,
      },
    );
  }
  get current() {
    return this.item.annotation === this.annotation;
  }
  get snapshot() {
    return furnitureReviewSnapshot(
      this.item.furnitureInstanceLogicals,
      this.item.furnitureInstanceParents,
      this.item.furnitureInstanceErrors,
    );
  }
  get referenceToken() {
    const status = this.referenceStatus;
    return JSON.stringify([
      this.annotation.referenceVersion,
      status?.enabled,
      status?.sync_type,
      status?.source_version,
      status?.reference_version,
      status?.error,
    ]);
  }
  get referenceBlock() {
    return furnitureReferenceBlock(this.item, this.referenceStatus);
  }
  get navigationBlock() {
    const annotation = this.annotation;
    return !this.current
      ? "标注已切换"
      : this.busy || this.item.furnitureInstanceBusy
        ? "L4 操作或保存正在进行"
        : this.unsaved
          ? "请先重试保存或导出窗口备份"
          : annotation.submissionStarted
            ? "正式提交正在进行"
            : annotation.isDrawing || annotation.hasIncompletePolygons
              ? "请先完成或取消当前绘制"
              : "";
  }
  get blockReason() {
    return (
      this.navigationBlock ||
      (this.annotation.isReadOnly() ? "当前标注为只读" : "") ||
      this.referenceBlock ||
      (this.snapshot.globalIssues.length ? "存在无法归属实例的校验错误，请先处理" : "")
    );
  }
  get counts() {
    return this.frozenCounts || this.snapshot;
  }
  get groupCounts() {
    return this.counts.groups[this.item.furnitureInstanceFocusId] || emptyReviewCounts();
  }
  get selectedRow() {
    return this.snapshot.rows.find((row) => row.id === this.item.furnitureInstanceEffectiveSelectedId);
  }
  get checkedIds() {
    return Object.keys(this.checked);
  }

  connect() {
    if (this.connections++ === 0) {
      const controller = this.annotation.store.referenceSyncController;
      this.referenceStatus = controller?.state?.status;
      if (controller)
        this.disposers.push(
          controller.subscribe((state) =>
            runInAction(() => {
              this.referenceStatus = state.status;
            }),
          ),
        );
      this.disposers.push(
        reaction(
          () => [
            this.item.annotation,
            this.item.furnitureInstanceFocusId,
            this.referenceToken,
            this.snapshot.rows.map((row) => `${row.id}:${row.status}:${row.token}`).join("|"),
          ],
          this.reconcile,
          { fireImmediately: true },
        ),
      );
    }
    return () => {
      if (--this.connections === 0) {
        this.disposers.splice(0).forEach((dispose) => dispose());
        runInAction(() => {
          this.active = false;
          this.checked = {};
          this.filter = "pending";
          this.order = [];
        });
      }
    };
  }
  reconcile() {
    if (!this.current) {
      this.active = false;
      this.checked = {};
      return;
    }
    if (this.busy || this.unsaved || this.pending) return;
    const changedScope =
      this.lastFocus !== this.item.furnitureInstanceFocusId || this.lastReference !== this.referenceToken;
    const rows = new Map(this.snapshot.rows.map((row) => [row.id, row]));
    const next = Object.fromEntries(
      Object.entries(this.checked).filter(([id, token]) => {
        const row = rows.get(id);
        return (
          !changedScope &&
          row?.status === "pending" &&
          row.token === token &&
          row.groupId === this.item.furnitureInstanceFocusId
        );
      }),
    );
    if (Object.keys(next).length !== this.checkedIds.length) {
      this.checked = next;
      this.notice = "勾选范围或实例内容已变化，相关勾选已清除，请重新检查。";
    }
    if (this.lastReference && this.lastReference !== this.referenceToken) this.active = false;
    this.lastFocus = this.item.furnitureInstanceFocusId;
    this.lastReference = this.referenceToken;
  }
  setFilter(value) {
    if (this.navigationBlock) return;
    this.filter = value;
    this.checked = {};
  }
  toggle(id) {
    if (this.blockReason) return;
    const row = this.snapshot.rows.find((candidate) => candidate.id === id);
    if (!row || row.status !== "pending" || row.groupId !== this.item.furnitureInstanceFocusId) return;
    const next = { ...this.checked };
    if (id in next) delete next[id];
    else next[id] = row.token;
    this.checked = next;
  }
  selectAll() {
    if (this.blockReason) return;
    this.checked = Object.fromEntries(
      this.snapshot.rows
        .filter(
          (row) =>
            row.groupId === this.item.furnitureInstanceFocusId &&
            row.status === "pending" &&
            ["all", "pending"].includes(this.filter),
        )
        .map((row) => [row.id, row.token]),
    );
  }
  clear() {
    if (!this.navigationBlock) this.checked = {};
  }
  setError(value) {
    this.error = value;
  }
  setNotice(value) {
    this.notice = value;
  }
  stop() {
    this.active = false;
  }
  async locate(id) {
    if (this.navigationBlock) return;
    const instance = this.snapshot.rows.find((row) => row.id === id)?.instance;
    if (!instance) return;
    this.item.selectFurnitureInstance(id);
    try {
      await focusFurnitureReview(
        this.item,
        furnitureReviewPoints(instance),
        () => this.current && this.item.furnitureInstanceEffectiveSelectedId === id,
      );
    } catch (error) {
      runInAction(() => {
        if (this.current) this.error = error.message;
      });
    }
  }
  async focusGroup(id) {
    if (this.navigationBlock) return;
    const parent = this.item.furnitureInstanceParents.find((candidate) => candidate.id === id);
    if (!parent) return;
    this.item.setFurnitureInstanceFocus(id);
    this.checked = {};
    try {
      await focusFurnitureReview(
        this.item,
        parent.geometry.flat(2),
        () =>
          this.current && this.item.furnitureInstanceFocusId === id && !this.item.furnitureInstanceEffectiveSelectedId,
      );
    } catch (error) {
      runInAction(() => {
        if (this.current) this.error = error.message;
      });
    }
  }
  async start() {
    if (this.blockReason) return;
    if (!["all", "pending"].includes(this.filter)) this.setFilter("pending");
    this.active = true;
    this.order = furnitureReviewOrder(
      this.snapshot,
      this.item.furnitureInstanceParents,
      this.item.furnitureInstanceFocusId,
    );
    await this.advance(this.item.furnitureInstanceEffectiveSelectedId, true);
  }
  async advance(fromId, preferCurrent = false) {
    if (!this.active || this.blockReason) return;
    const snapshot = this.snapshot;
    const fresh = furnitureReviewOrder(
      snapshot,
      this.item.furnitureInstanceParents,
      this.item.furnitureInstanceFocusId,
    );
    this.order = [...this.order.filter((id) => fresh.includes(id)), ...fresh.filter((id) => !this.order.includes(id))];
    const next = nextFurnitureReviewId(snapshot, this.order, fromId, preferCurrent);
    if (next) {
      await this.locate(next);
      return;
    }
    this.active = false;
    this.notice = snapshot.total.blocked
      ? `剩余 ${snapshot.total.blocked} 个实例需处理`
      : snapshot.total.total
        ? "全部已复核，待正式提交"
        : "尚无家具实例可复核";
  }
  async run(operation, { rethrow = false, retry = false } = {}) {
    if (this.busy || this.item.furnitureInstanceBusy) return false;
    if (!this.current || (this.unsaved && !retry)) {
      this.error = "请先重试保存或导出窗口备份";
      return false;
    }
    this.busy = true;
    this.item.setFurnitureInstanceBusy(true);
    this.error = "";
    this.notice = "";
    try {
      const message = await operation();
      runInAction(() => {
        this.unsaved = false;
        if (message) this.notice = message;
      });
      return true;
    } catch (error) {
      runInAction(() => {
        if (error.localMutationApplied) this.unsaved = true;
        this.error = error.message || "操作失败；当前修改仍保留";
      });
      if (rethrow) throw error;
      return false;
    } finally {
      runInAction(() => {
        this.busy = false;
        this.item.setFurnitureInstanceBusy(false);
        this.reconcile();
      });
    }
  }
  async confirm(ids, { advance = false, batch = false } = {}) {
    if (this.blockReason) {
      this.error = this.blockReason;
      return;
    }
    const snapshot = this.snapshot;
    const rows = ids.map((id) => snapshot.rows.find((row) => row.id === id));
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      rows.some(
        (row) =>
          !row ||
          row.status !== "pending" ||
          (batch && (row.groupId !== this.item.furnitureInstanceFocusId || this.checked[row.id] !== row.token)),
      )
    ) {
      this.problems = ids.flatMap((id, index) =>
        !rows[index] || rows[index].status !== "pending"
          ? [{ id, message: rows[index]?.errors.map((error) => error.message).join("；") || "实例已删除或状态已变化" }]
          : [],
      );
      this.error = "待复核范围已变化，请重新检查并勾选";
      if (this.problems.length && rows.find((row) => row?.id === this.problems[0].id))
        await this.locate(this.problems[0].id);
      return;
    }
    const request = {
      ids: [...ids],
      tokens: rows.map((row) => row.token),
      reference: this.referenceToken,
      focus: this.item.furnitureInstanceFocusId,
      fromId: this.item.furnitureInstanceEffectiveSelectedId,
      advance,
      batch,
    };
    this.pending = request;
    this.problems = [];
    this.frozenCounts = { total: { ...snapshot.total }, groups: { ...snapshot.groups } };
    const ok = await this.run(() =>
      applyFurnitureInstanceOperation(this.item, () => {
        const current = this.snapshot;
        const changedIds = request.ids.filter((id, index) => {
          const row = current.rows.find((candidate) => candidate.id === id);
          return !row || row.status !== "pending" || row.token !== request.tokens[index];
        });
        const changed =
          !this.current ||
          request.reference !== this.referenceToken ||
          this.referenceBlock ||
          current.globalIssues.length ||
          (batch && request.focus !== this.item.furnitureInstanceFocusId) ||
          changedIds.length;
        runInAction(() => {
          this.problems = changedIds.map((id) => ({
            id,
            message:
              current.rows
                .find((row) => row.id === id)
                ?.errors.map((error) => error.message)
                .join("；") || "实例内容、状态已变化或被删除",
          }));
        });
        if (changed) throw new Error("实例、标注或参考已变化，本次未确认；请重新检查");
        this.item.confirmFurnitureInstanceReviews(request.ids);
        return `已确认并保存 ${request.ids.length} 个实例；仍需正式提交任务。`;
      }),
    );
    if (ok) await this.finish(request);
    else if (!this.unsaved) {
      runInAction(() => {
        this.pending = null;
        this.frozenCounts = null;
      });
      if (this.current && this.item.furnitureInstanceFocusId === request.focus && this.problems.length)
        await this.locate(this.problems[0].id);
    }
  }
  async finish(request) {
    if (this.pending !== request) return;
    this.pending = null;
    this.frozenCounts = null;
    this.checked = {};
    if (!this.current) return;
    if (request.reference !== this.referenceToken || this.referenceBlock) {
      this.active = false;
      this.notice = "已保存；参考已变化，连续复核已暂停，请手动应用参考。";
      return;
    }
    if (
      request.ids.some((id, index) => {
        const row = this.snapshot.rows.find((candidate) => candidate.id === id);
        return !row || row.status !== "reviewed" || row.token !== request.tokens[index];
      })
    ) {
      this.active = false;
      this.notice = "已保存；实例内容已变化，连续复核已暂停，请重新检查。";
      return;
    }
    if (request.advance && this.item.furnitureInstanceEffectiveSelectedId === request.fromId)
      await this.advance(request.fromId);
  }
  async retry() {
    if (
      !this.unsaved ||
      this.busy ||
      this.annotation.isDrawing ||
      this.annotation.hasIncompletePolygons ||
      this.annotation.submissionStarted
    )
      return;
    const request = this.pending;
    const ok = await this.run(() => retryFurnitureInstanceSave(this.item), { retry: true });
    if (ok && request) await this.finish(request);
  }
}

decorate(FurnitureReviewSession, {
  current: computed,
  snapshot: computed,
  referenceToken: computed,
  referenceBlock: computed,
  navigationBlock: computed,
  blockReason: computed,
  counts: computed,
  groupCounts: computed,
  selectedRow: computed,
  checkedIds: computed,
  connect: action.bound,
  reconcile: action.bound,
  setFilter: action.bound,
  toggle: action.bound,
  selectAll: action.bound,
  clear: action.bound,
  setError: action.bound,
  setNotice: action.bound,
  stop: action.bound,
  locate: action.bound,
  focusGroup: action.bound,
  start: action.bound,
  advance: action.bound,
  run: action.bound,
  confirm: action.bound,
  finish: action.bound,
  retry: action.bound,
});

export function getFurnitureReviewSession(item) {
  const annotation = item.annotation;
  let images = sessions.get(annotation);
  if (!images) {
    images = new Map();
    sessions.set(annotation, images);
  }
  const key = item.name || "image";
  if (!images.has(key)) images.set(key, new FurnitureReviewSession(item));
  const session = images.get(key);
  if (session.item !== item)
    runInAction(() => {
      session.item = item;
    });
  return session;
}

export function useFurnitureReviewSession(item) {
  const session = getFurnitureReviewSession(item);
  useEffect(() => session.connect(), [session]);
  return session;
}
