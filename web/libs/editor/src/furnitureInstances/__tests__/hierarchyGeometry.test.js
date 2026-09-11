import { lockRectangleToActiveAnchor } from "../../occupancy/transform";
import { area, equivalent, storageParts } from "../../occupancy/geometry";
import { buildWalkableReferences, walkableReferencesFor } from "../walkableReferences";

describe("rotated rectangle stationary edges use source-pixel lengths", () => {
  test.each([[1080, 671], [671, 1080], [1080, 1080]])("legal shrink on %s x %s never moves a fixed edge", (W, H) => {
    for (const rotation of [0, 30, 45, 89.999, 180, 312.8494665626217, 359.999]) {
      for (const anchor of ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]) {
        const c = Math.cos(rotation * Math.PI / 180), s = Math.sin(rotation * Math.PI / 180);
        const left = anchor.includes("left"), top = anchor.includes("top");
        const dw = anchor.endsWith("center") ? 0 : 10;
        const dh = anchor.startsWith("middle") ? 0 : 10;
        const old = { x: 200 / W * 100, y: 200 / H * 100, width: 120 / W * 100, height: 60 / H * 100, rotation };
        const target = { x: (200 + (left ? dw*c : 0) - (top ? dh*s : 0)) / W*100,
          y: (200 + (left ? dw*s : 0) + (top ? dh*c : 0)) / H*100,
          width: (120-dw)/W*100, height: (60-dh)/H*100, rotation };
        const result = lockRectangleToActiveAnchor(old, target, anchor, { naturalWidth: W, naturalHeight: H });
        for (const key of ["x", "y", "width", "height", "rotation"]) expect(result[key]).toBeCloseTo(target[key], 10);
      }
    }
  });
});

const polygon = [[[0,0],[20,0],[20,20],[0,20],[0,0]], [[5,5],[5,10],[10,10],[10,5],[5,5]]];
const reference = (geometry, logicalId="walk", zoneId="zone") => storageParts(geometry).flatMap((points, i) => [
  {id:`${logicalId}-${i}`,from_name:"occupancy_polygon",to_name:"image",original_width:1080,original_height:671,
    value:{points},meta:{occupancy_context:{logical_id:logicalId,parent_room_id:"room",parent_zone_id:zoneId}}},
  {id:`${logicalId}-${i}`,from_name:"occupancy_type",value:{labels:["walkable"]}},
]);
test("triangulated references preserve the union and holes without changing storage", () => {
  const data=reference([polygon]), before=JSON.stringify(data);
  const result=buildWalkableReferences(data);
  expect(result.errors).toEqual([]);
  expect(result.regions).toHaveLength(1);
  expect(result.regions[0].geometry[0]).toHaveLength(2);
  expect(equivalent(result.regions[0].geometry,[polygon])).toBe(true);
  expect(area(result.regions[0].geometry)).toBe(375);
  expect(result.partIds.size).toBe(data.length/2);
  expect(JSON.stringify(data)).toBe(before);
});
test("different logical IDs remain independent and bad groups retain their native parts", () => {
  const data=[...reference([polygon]),...reference([polygon],"other","other-zone")];
  expect(buildWalkableReferences(data).regions).toHaveLength(2);
  data[0].meta.occupancy_context.parent_zone_id="wrong";
  const result=buildWalkableReferences(data);
  expect(result.regions.map(r=>r.id)).toEqual(["other"]);
  expect(result.errors).toHaveLength(1);
  expect(result.partIds.has(data[0].id)).toBe(false);
});
test("zoom and furniture-only changes reuse cached reference geometry", () => {
  const item={}, data=reference([polygon]);
  const first=walkableReferencesFor(item,data);
  expect(walkableReferencesFor(item,[...data,{from_name:"furniture_instance_rectangle",value:{x:20}}])).toBe(first);
  const changed=JSON.parse(JSON.stringify(data)); changed[0].value.points[0][0]+=0.01;
  expect(walkableReferencesFor(item,changed)).not.toBe(first);
});
