import { observable, runInAction } from "mobx";
import { getFurnitureReviewSession } from "../reviewSession";
import { confirmFurnitureInstances, validateFurnitureInstances } from "../constraints";
import { furnitureGroups, furnitureInstances } from "../domain";
import { makeInstance, makeOccupancy, resetIds, square } from "./helpers";
export function reviewSetup() {
  resetIds();
  const refs = makeOccupancy([
    { id: "g1", type: "sleeping", geometry: [square(10, 10, 55, 90)] },
    { id: "g2", type: "study_work", geometry: [square(60, 10, 95, 90)] },
  ]);
  const state = observable(
    {
      results: [
        ...refs,
        ...makeInstance(refs, { groupId: "g1", instanceId: "a", instanceType: "bed" }),
        ...makeInstance(refs, {
          groupId: "g1",
          instanceId: "b",
          instanceType: "bedside_table",
          geometry: [square(20, 20, 30, 30), square(40, 40, 50, 50)],
        }),
        ...makeInstance(refs, {
          groupId: "g2",
          instanceId: "c",
          instanceType: "desk",
          geometry: [square(65, 20, 85, 40)],
        }),
      ],
      focus: "g1",
      selected: "a",
      busy: false,
      switched: false,
      drawing: false,
      readonly: false,
    },
    {},
    { deep: false },
  );
  const calls = [];
  const status = {
    enabled: true,
    sync_type: "occupancy_to_furniture_instances",
    source_version: "v1",
    reference_version: "v1",
  };
  const controller = {
    state: { status },
    subscribe: jest.fn(() => () => {}),
    checkFurnitureInstancesReference: jest.fn(async () => {
      calls.push("reference");
    }),
  };
  const annotation = {
    referenceVersion: "v1",
    store: { referenceSyncController: controller },
    get isDrawing() {
      return state.drawing;
    },
    isReadOnly: () => state.readonly,
    saveDraftImmediatelyWithResults: jest.fn(async () => {
      calls.push("save");
    }),
  };
  const otherAnnotation = { ...annotation };
  const item = {
    name: "image",
    get annotation() {
      return state.switched ? otherAnnotation : annotation;
    },
    get furnitureInstanceData() {
      return state.results;
    },
    get furnitureInstanceLogicals() {
      return furnitureInstances(state.results);
    },
    get furnitureInstanceParents() {
      return furnitureGroups(state.results);
    },
    get furnitureInstanceErrors() {
      return validateFurnitureInstances(state.results, state.results);
    },
    get furnitureInstanceFocusId() {
      return state.focus;
    },
    get furnitureInstanceEffectiveSelectedId() {
      return state.selected;
    },
    get furnitureInstanceBusy() {
      return state.busy;
    },
    setFurnitureInstanceBusy: (value) =>
      runInAction(() => {
        state.busy = value;
      }),
    selectFurnitureInstance: jest.fn((id) =>
      runInAction(() => {
        state.selected = id;
        state.focus = furnitureInstances(state.results).find((i) => i.id === id).context.group_id;
      }),
    ),
    setFurnitureInstanceFocus: jest.fn((id) =>
      runInAction(() => {
        state.focus = id;
        state.selected = "";
      }),
    ),
    confirmFurnitureInstanceReviews: jest.fn((ids) =>
      runInAction(() => {
        calls.push("confirm");
        state.results = confirmFurnitureInstances(state.results, state.results, ids);
      }),
    ),
  };
  const session = getFurnitureReviewSession(item);
  return { session, item, state, annotation, controller, calls, refs };
}
