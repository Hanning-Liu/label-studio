import {
  assertRing,
  canonical,
  clone,
  equivalent,
  fingerprint,
  resultGeometry,
  storageParts,
  union,
} from "../occupancy/geometry";
import { logicalRegions } from "../occupancy/domain";

export const CONTROLS = Object.freeze({
  rectangle: "furniture_instance_rectangle",
  polygon: "furniture_instance_polygon",
  type: "furniture_instance_type",
  frontDirection: "furniture_front_direction",
  frontEdge: "furniture_front_edge",
});

export const GEOMETRY_CONTROLS = new Set([CONTROLS.rectangle, CONTROLS.polygon]);
export const ORIENTATION_CONTROLS = new Set([CONTROLS.frontDirection, CONTROLS.frontEdge]);
export const ALL_CONTROLS = new Set([...GEOMETRY_CONTROLS, CONTROLS.type, ...ORIENTATION_CONTROLS]);

// Label configs show the Chinese value and persist the stable English alias.
// Never rename an alias after production annotations have used it.
export const FURNITURE_TYPES = Object.freeze({
  bed: "床",
  bedside_table: "床头柜",
  wardrobe: "衣柜",
  desk: "书桌",
  office_chair: "办公椅",
  sofa: "沙发",
  armchair: "扶手椅",
  coffee_table: "茶几",
  dining_table: "餐桌",
  dining_chair: "餐椅",
  cabinet: "柜体",
  bookshelf: "书架",
  tv_stand: "电视柜",
  television: "电视",
  refrigerator: "冰箱",
  stove: "灶具",
  kitchen_cabinet: "橱柜",
  sink: "水槽",
  toilet: "坐便器",
  washbasin: "洗手盆",
  bathtub: "浴缸",
  shower: "淋浴设施",
  washing_machine: "洗衣机",
  dryer: "烘干机",
  shoe_cabinet: "鞋柜",
  other: "其他",
});

export const ROLE_BY_CONTROL = Object.freeze({
  [CONTROLS.rectangle]: "geometry",
  [CONTROLS.polygon]: "geometry",
  [CONTROLS.type]: "category",
  [CONTROLS.frontDirection]: "front_direction",
  [CONTROLS.frontEdge]: "front_edge",
});

export const controlName = (result) => result?.from_name?.name || result?.from_name;
export const context = (result) => result?.meta?.furniture_instance_context || {};
export const roleForResult = (result) => ROLE_BY_CONTROL[controlName(result)] || null;

export function effectiveFurnitureInstanceSelection(regions, fallback = "") {
  const selected = new Set(
    (regions || []).flatMap((region) =>
      (region?.results || []).map((result) => context(result).instance_id).filter(Boolean),
    ),
  );
  if (selected.size === 1) return selected.values().next().value;
  return selected.size ? "" : fallback;
}

export function sameFurnitureResultKeys(left, right) {
  const keys = (results) =>
    (results || []).map((result) => `${result?.id || ""}\u0000${controlName(result) || ""}`).sort();
  const first = keys(left);
  const second = keys(right);
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

export const newId = () =>
  `fi_${Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (number) =>
    number.toString(16).padStart(8, "0"),
  ).join("")}`;

const pointArray = (point) => {
  const pair = Array.isArray(point) ? point : [point?.x, point?.y];
  if (pair.length !== 2 || pair.some((number) => !Number.isFinite(number))) throw new Error("家具轮廓坐标无效");
  return [pair[0], pair[1]];
};

const internalRing = (ring) => assertRing(ring.map(pointArray));

export function internalGeometry(geometry) {
  let multi;
  if (Array.isArray(geometry)) multi = geometry.map((polygon) => polygon.map(internalRing));
  else if (geometry?.type === "Polygon") multi = [geometry.coordinates.map(internalRing)];
  else if (geometry?.type === "MultiPolygon") multi = geometry.coordinates.map((polygon) => polygon.map(internalRing));
  else throw new Error("家具实例几何必须是 Polygon 或 MultiPolygon");
  if (!multi.length || multi.some((polygon) => !polygon.length))
    throw new Error("家具实例几何必须至少包含一个 Polygon 外环");
  return multi;
}

const signedRingArea = (ring) =>
  ring.slice(0, -1).reduce((sum, point, index) => {
    const next = ring[(index + 1) % (ring.length - 1)];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;

const comparePoint = (left, right) => left[0] - right[0] || left[1] - right[1];
const compareSequence = (left, right) => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const compared = comparePoint(left[index], right[index]);
    if (compared) return compared;
  }
  return left.length - right.length;
};

function canonicalRing(ring, hole) {
  let open = internalRing(ring)
    .slice(0, -1)
    .map((point) => point.map((number) => Number(number.toFixed(10))));
  const positive = signedRingArea([...open, open[0]]) > 0;
  // Hash convention follows the GeoJSON right-hand rule in Cartesian
  // coordinates: exterior rings counter-clockwise, holes clockwise.
  if ((!hole && !positive) || (hole && positive)) open = [...open].reverse();
  let selected = open;
  for (let index = 1; index < open.length; index++) {
    const rotated = [...open.slice(index), ...open.slice(0, index)];
    if (compareSequence(rotated, selected) < 0) selected = rotated;
  }
  return [...selected.map((point) => [...point]), [...selected[0]]];
}

const canonicalKey = (value) => JSON.stringify(canonical(value));
const compareCanonical = (left, right) => {
  const a = canonicalKey(left);
  const b = canonicalKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

// This normalization is for parent hashing only. Annotation and aggregate
// geometry keep their exact coordinates, components, rings and holes.
export function canonicalizeParentGeometry(geometry) {
  const polygons = internalGeometry(geometry).map((polygon) => {
    const exterior = canonicalRing(polygon[0], false);
    const holes = polygon
      .slice(1)
      .map((ring) => canonicalRing(ring, true))
      .sort(compareCanonical);
    return [exterior, ...holes];
  });
  polygons.sort(compareCanonical);
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

export function parentFingerprintPayload(group) {
  return {
    schema_version: 1,
    room_id: group.roomId ?? group.room_id,
    zone_id: group.zoneId ?? group.zone_id,
    group_id: group.groupId ?? group.group_id ?? group.id,
    group_type: group.groupType ?? group.group_type ?? group.type,
    group_note: group.groupNote ?? group.group_note ?? group.note ?? "",
    zone_parent_fingerprint: group.zoneParentFingerprint ?? group.zone_parent_fingerprint ?? group.parent_fingerprint,
    geometry: canonicalizeParentGeometry(group.geometry),
  };
}

export const furnitureGroupFingerprint = (group) => fingerprint(parentFingerprintPayload(group));

export function furnitureGroups(results) {
  return logicalRegions(results)
    .filter((region) => region.type === "furniture_group")
    .map((region) => {
      const occupancyContext = region.context;
      const group = {
        id: occupancyContext.group_id,
        logicalId: region.id,
        groupId: occupancyContext.group_id,
        groupType: occupancyContext.group_type,
        groupNote: occupancyContext.group_note || "",
        roomId: occupancyContext.parent_room_id,
        zoneId: occupancyContext.parent_zone_id,
        zoneParentFingerprint: occupancyContext.parent_fingerprint,
        sourceVersion: occupancyContext.source_version,
        geometry: region.geometry,
        parts: region.parts,
      };
      return { ...group, fingerprint: furnitureGroupFingerprint(group) };
    });
}

export function sharedContext(value) {
  return {
    schema_version: value.schema_version,
    instance_id: value.instance_id,
    instance_type: value.instance_type,
    note: value.note || "",
    room_id: value.room_id,
    zone_id: value.zone_id,
    group_id: value.group_id,
    source_version: value.source_version,
    parent_fingerprint: value.parent_fingerprint,
    review_status: value.review_status,
    review_fingerprint: value.review_fingerprint ?? null,
  };
}

export const resultContext = (value, role) => ({ ...sharedContext(value), role });

export function baseContext(group, sourceVersion, instanceType, note = "", instanceId = newId()) {
  if (!Object.hasOwn(FURNITURE_TYPES, instanceType)) throw new Error("家具实例类别无效");
  return {
    schema_version: 1,
    instance_id: instanceId,
    instance_type: instanceType,
    note,
    room_id: group.roomId,
    zone_id: group.zoneId,
    group_id: group.groupId || group.id,
    source_version: sourceVersion,
    parent_fingerprint: group.fingerprint || furnitureGroupFingerprint(group),
    review_status: "pending",
    review_fingerprint: null,
  };
}

const categoryValue = (result) => {
  const value = result?.value || {};
  return value.choices?.[0] || value.labels?.[0] || value.rectanglelabels?.[0] || value.polygonlabels?.[0];
};

export function categoryForGeometry(results, geometryResult) {
  const instanceId = context(geometryResult).instance_id;
  return results.find(
    (result) =>
      result.id === geometryResult.id &&
      controlName(result) === CONTROLS.type &&
      context(result).instance_id === instanceId,
  );
}

export function resultsForGeometry(geometry, instanceType, value, source, idFactory = newId, preserveParts = []) {
  if (!Object.hasOwn(FURNITURE_TYPES, instanceType) || value.instance_type !== instanceType)
    throw new Error("家具实例类别与上下文不一致");
  return storageParts(internalGeometry(geometry)).flatMap((points) => {
    const id = idFactory();
    const rectangle = preserveParts.find(
      (part) => controlName(part) === CONTROLS.rectangle && equivalent(resultGeometry(part), [[points]]),
    );
    const common = {
      id,
      to_name: source.to_name || "image",
      original_width: source.original_width,
      original_height: source.original_height,
      image_rotation: source.image_rotation || 0,
    };
    const geometryResult = {
      ...common,
      from_name: rectangle ? CONTROLS.rectangle : CONTROLS.polygon,
      type: rectangle ? "rectangle" : "polygon",
      value: rectangle ? clone(rectangle.value) : { points },
      meta: { furniture_instance_context: resultContext(value, "geometry") },
    };
    const categoryResult = {
      id,
      from_name: CONTROLS.type,
      to_name: common.to_name,
      type: "choices",
      value: { choices: [instanceType] },
      meta: { furniture_instance_context: resultContext(value, "category") },
    };
    return [geometryResult, categoryResult];
  });
}

export function resultForOrientation(status, vertices, value, source, idFactory = newId) {
  if (!["front_direction", "front_edge"].includes(status)) throw new Error("家具朝向证据类别无效");
  if (!Array.isArray(vertices) || vertices.length !== 2 || vertices.some((point) => point?.isBezier === true))
    throw new Error("家具朝向证据必须包含两个直线端点");
  const normalized = vertices.map((point, index) => {
    const [x, y] = pointArray(point);
    return {
      ...(typeof point === "object" && !Array.isArray(point) ? clone(point) : {}),
      id: point?.id || `${index}`,
      x,
      y,
      isBezier: false,
    };
  });
  const id = idFactory();
  return {
    id,
    from_name: status === "front_direction" ? CONTROLS.frontDirection : CONTROLS.frontEdge,
    to_name: source.to_name || "image",
    type: "vectorlabels",
    original_width: source.original_width,
    original_height: source.original_height,
    image_rotation: source.image_rotation || 0,
    value: { closed: false, vertices: normalized, vectorlabels: [status] },
    meta: { furniture_instance_context: resultContext(value, status) },
  };
}

export function furnitureResults(results) {
  return results.filter((result) => ALL_CONTROLS.has(controlName(result)));
}

export function furnitureInstances(results) {
  const records = new Map();
  for (const result of furnitureResults(results).filter((item) => GEOMETRY_CONTROLS.has(controlName(item)))) {
    const furnitureContext = context(result);
    const id = furnitureContext.instance_id || `invalid:${result.id}`;
    if (!records.has(id)) records.set(id, { id, context: furnitureContext, parts: [], results: [] });
    records.get(id).parts.push(result);
  }
  for (const record of records.values()) {
    record.results = furnitureResults(results).filter((result) => context(result).instance_id === record.id);
    record.categories = record.results.filter((result) => controlName(result) === CONTROLS.type);
    record.orientationResults = record.results.filter((result) => ORIENTATION_CONTROLS.has(controlName(result)));
    try {
      record.geometry = union(...record.parts.map(resultGeometry));
    } catch (error) {
      record.geometry = [];
      record.geometryError = error;
    }
    record.instanceType = categoryValue(categoryForGeometry(results, record.parts[0])) || record.context.instance_type;
  }
  return [...records.values()];
}

const exportPoint = ([x, y]) => ({ x, y });

export function geometryForExport(geometry) {
  const multi = internalGeometry(geometry);
  const coordinates = multi.map((polygon) => polygon.map((ring) => ring.map(exportPoint)));
  return multi.length === 1 ? { type: "Polygon", coordinates: coordinates[0] } : { type: "MultiPolygon", coordinates };
}

export function instanceFingerprintPayload(instance, orientation) {
  const furnitureContext = instance.context || instance;
  return {
    schema_version: 1,
    instance_id: furnitureContext.instance_id || instance.id,
    instance_type: furnitureContext.instance_type || instance.instanceType,
    note: furnitureContext.note || "",
    parent: {
      room_id: furnitureContext.room_id,
      zone_id: furnitureContext.zone_id,
      group_id: furnitureContext.group_id,
    },
    source_version: furnitureContext.source_version,
    parent_fingerprint: furnitureContext.parent_fingerprint,
    geometry: canonicalizeParentGeometry(instance.geometry),
    orientation,
  };
}

export const instanceReviewFingerprint = (instance, orientation) =>
  fingerprint(instanceFingerprintPayload(instance, orientation));

export const resultCategory = categoryValue;
