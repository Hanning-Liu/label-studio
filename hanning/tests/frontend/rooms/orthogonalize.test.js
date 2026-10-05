import { orthogonalizePolygon } from "@hanning/frontend/domain/rooms/orthogonalize";
import { isSimplePolygon } from "@hanning/frontend/domain/rooms/roomConstraintGeometry";

const points = (pairs) => pairs.map(([x, y]) => ({ x, y }));
const checkAxes = (polygon) => polygon.forEach((p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  expect((p.x === q.x) !== (p.y === q.y)).toBe(true);
});

test("projects a slanted rectangle to the nearest horizontal/vertical coordinate groups", () => {
  const input = points([[10, 10], [30, 10.2], [30.3, 40], [10.1, 39.8]]);
  const copy = JSON.stringify(input);
  const result = orthogonalizePolygon(input, 693, 1000);
  expect(result.changed).toBe(true);
  expect(result.points).toEqual(points([[10.05, 10.1], [30.15, 10.1], [30.15, 39.9], [10.05, 39.9]]));
  expect(JSON.stringify(input)).toBe(copy);
  checkAxes(result.points);
  expect(orthogonalizePolygon(result.points, 693, 1000)).toEqual({ points: result.points, changed: false });
});

test("concave rooms and intermediate collinear vertices preserve vertex count and cyclic order", () => {
  const base = [[10, 10], [30, 10], [50, 10], [50, 30], [30, 30], [30, 50], [10, 50]];
  for (const reverse of [false, true]) {
    for (let seed = 0; seed < 30; seed++) {
      const shape = points(base.map(([x, y], i) => [x + Math.sin(i + seed) / 10, y + Math.cos(i + seed) / 10]));
      if (reverse) shape.reverse();
      const result = orthogonalizePolygon(shape, 693, 1000);
      expect(result.points).toHaveLength(shape.length);
      expect(isSimplePolygon(result.points)).toBe(true);
      checkAxes(result.points);
    }
  }
});

test("edge direction uses the image aspect ratio, not percentage or screen distances", () => {
  const input = points([[10, 10], [12, 20], [12, 60], [10, 50]]);
  const wide = orthogonalizePolygon(input, 1000, 100);
  expect(wide.points).toEqual(points([[10, 15], [12, 15], [12, 55], [10, 55]]));
  expect(() => orthogonalizePolygon(input, 100, 1000)).toThrow("塌缩");
});

test.each([
  [[0, 0], [10, 10], [0, 10], [10, 0]],
  [[0, 0], [10, 0], [10, 0], [0, 10]],
  [[0, 0], [10, 0], [0, 10]],
  [[-1, 0], [10, 0], [10, 10], [0, 10]],
])("invalid or unrepresentable input is rejected without mutation: %j", (...pairs) => {
  const input = points(pairs);
  const before = JSON.stringify(input);
  expect(() => orthogonalizePolygon(input, 693, 1000)).toThrow();
  expect(JSON.stringify(input)).toBe(before);
});

test("ambiguous diagonals and missing dimensions produce specific errors", () => {
  const diamond = points([[20, 10], [30, 20], [20, 30], [10, 20]]);
  expect(() => orthogonalizePolygon(diamond, 100, 100)).toThrow("45°");
  expect(() => orthogonalizePolygon(diamond, 0, 100)).toThrow("尺寸");
});
