import { orthogonalizePolygon } from "@hanning/frontend/domain/rooms/orthogonalize";
import { isSimplePolygon } from "@hanning/frontend/domain/rooms/roomConstraintGeometry";

const points = (pairs) => pairs.map(([x, y]) => ({ x, y }));
const checkAxes = (polygon) => polygon.forEach((p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  expect((p.x === q.x) !== (p.y === q.y)).toBe(true);
});

const pixelPoints = (pairs, width, height) => pairs.map(([x, y]) => ({ x: x / width * 100, y: y / height * 100 }));
const checkPixels = (polygon, width, height) => polygon.forEach((p) => {
  expect(p.x * width / 100).toBeCloseTo(Math.round(p.x * width / 100), 9);
  expect(p.y * height / 100).toBeCloseTo(Math.round(p.y * height / 100), 9);
});

test("projects a slanted rectangle to orthogonal coordinate groups on original image pixels", () => {
  const input = points([[10, 10], [30, 10.2], [30.3, 40], [10.1, 39.8]]);
  const copy = JSON.stringify(input);
  const result = orthogonalizePolygon(input, 693, 1000);
  expect(result.changed).toBe(true);
  expect(result.points).toEqual(pixelPoints([[70, 101], [209, 101], [209, 399], [70, 399]], 693, 1000));
  expect(JSON.stringify(input)).toBe(copy);
  checkAxes(result.points);
  checkPixels(result.points, 693, 1000);
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
      checkPixels(result.points, 693, 1000);
    }
  }
});

test("edge direction uses the image aspect ratio, not percentage or screen distances", () => {
  const input = points([[10, 10], [12, 20], [12, 60], [10, 50]]);
  const wide = orthogonalizePolygon(input, 1000, 100);
  expect(wide.points).toEqual(pixelPoints([[100, 15], [120, 15], [120, 55], [100, 55]], 1000, 100));
  checkPixels(wide.points, 1000, 100);
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

test.each([[693, 1000], [4031, 3023], [32, 48]])("already orthogonal off-grid vertices are snapped using %i x %i original pixels", (width, height) => {
  const input = pixelPoints([[4.2, 3.4], [20.3, 3.4], [20.3, 25.2], [4.2, 25.2]], width, height);
  const result = orthogonalizePolygon(input, width, height);
  expect(result.changed).toBe(true);
  expect(result.points).toEqual(pixelPoints([[4, 3], [20, 3], [20, 25], [4, 25]], width, height));
  checkAxes(result.points);
  checkPixels(result.points, width, height);
  expect(orthogonalizePolygon(result.points, width, height)).toEqual({ points: result.points, changed: false });
});

test("rounding cannot silently collapse a subpixel-wide edge", () => {
  const input = pixelPoints([[10.1, 10], [10.4, 10], [10.4, 30], [10.1, 30]], 693, 1000);
  const before = JSON.stringify(input);
  expect(() => orthogonalizePolygon(input, 693, 1000)).toThrow("像素吸附");
  expect(JSON.stringify(input)).toBe(before);
});

test("integer image boundaries and collinear intermediate vertices remain on-grid", () => {
  const input = pixelPoints([[0, 0.1], [30, 0.2], [693, 0], [693, 1000], [0, 1000]], 693, 1000);
  const result = orthogonalizePolygon(input, 693, 1000);
  expect(result.points).toEqual(pixelPoints([[0, 0], [30, 0], [693, 0], [693, 1000], [0, 1000]], 693, 1000));
  checkAxes(result.points);
  checkPixels(result.points, 693, 1000);
});
