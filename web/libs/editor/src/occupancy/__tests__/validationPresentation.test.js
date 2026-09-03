import {
  groupReviewIssues,
  presentGenerationIssues,
  presentOccupancyIssue,
  shortOccupancyId,
} from "../validationPresentation";

const parent = {
  id: "zone-study",
  roomLabel: "Study room",
  functionLabel: "Study/work",
};
const logical = (id, groupType, partId) => ({
  id,
  type: "furniture_group",
  context: { group_type: groupType },
  parts: [{ id: partId }],
});

test("source issue names the parent and affected furniture group", () => {
  const region = logical("oc_0e53c96b179444b960bf78af18290b72", "study_work", "part-study");
  const presentation = presentOccupancyIssue(
    { code: "source", parentId: parent.id, objectId: "part-study" },
    [parent],
    [region],
  );

  expect(presentation.title).toBe("父功能分区参考已变化");
  expect(presentation.detail).toContain("学习办公");
  expect(presentation.detail).toContain("Study room · Study/work");
  expect(presentation.region).toBe(region);
  expect(shortOccupancyId(region.id)).toBe("oc_0e53c96…0b72");
});

test("overlap issue names both conflicting furniture groups", () => {
  const first = logical("oc_learning", "study_work", "part-learning");
  const second = logical("oc_storage", "storage", "part-storage");
  const presentation = presentOccupancyIssue(
    {
      code: "overlap",
      parentId: parent.id,
      objectId: first.id,
      relatedObjectId: second.id,
    },
    [parent],
    [first, second],
  );

  expect(presentation.detail).toContain("学习办公 · oc_learning");
  expect(presentation.detail).toContain("收纳 · oc_storage");
  expect(presentation.relatedRegion).toBe(second);
});

test("duplicate storage-part issues collapse to one logical-region row", () => {
  const region = {
    ...logical("oc_multi_part_group", "storage", "part-a"),
    parts: [{ id: "part-a" }, { id: "part-b" }],
  };
  const presentations = presentGenerationIssues(
    [
      { code: "source", parentId: parent.id, objectId: "part-a" },
      { code: "source", parentId: parent.id, objectId: "part-b" },
    ],
    [parent],
    [region],
  );

  expect(presentations).toHaveLength(1);
  expect(presentations[0].object.label).toBe("收纳");
});

test("review dialog groups stale and review rows by parent without losing raw issue counts", () => {
  const secondParent = { id: "zone-sleep", roomLabel: "Bedroom", functionLabel: "Sleeping", label: "Bedroom · Sleeping" };
  const staleRegion = {
    id: "oc_walkable",
    type: "walkable",
    context: { parent_zone_id: parent.id },
    parts: [{ id: "walkable-part-a" }, { id: "walkable-part-b" }],
  };
  const groupRegion = {
    ...logical("oc_sleep", "sleeping", "sleep-part"),
    context: { group_type: "sleeping", parent_zone_id: secondParent.id },
  };
  const groups = groupReviewIssues(
    [
      { code: "review", parentId: secondParent.id, objectId: groupRegion.id },
      { code: "stale", parentId: parent.id, objectId: "walkable-part-a" },
      { code: "review", parentId: parent.id, objectId: "walkable-part-a" },
      { code: "stale", parentId: parent.id, objectId: "walkable-part-b" },
      { code: "coverage", parentId: parent.id, objectId: parent.id },
    ],
    [parent, secondParent],
    [staleRegion, groupRegion],
  );

  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    parentId: parent.id,
    staleCount: 1,
    reviewCount: 1,
  });
  expect(groups[0].issues).toHaveLength(4);
  expect(groups[0].otherIssues.map((issue) => issue.code)).toEqual(["coverage"]);
  expect(groups[1]).toMatchObject({ parentId: secondParent.id, staleCount: 0, reviewCount: 1 });
});
