import { reviewFocusFit, focusReviewVector } from "../vectorReviewFocus";

test.each([
  [{ left: 0, right: 100, top: 800, bottom: 800 }, 2],
  [{ left: 900, right: 900, top: 0, bottom: 100 }, 2],
])("short horizontal/vertical lines preserve zoom", (bounds, zoom) => {
  expect(reviewFocusFit(bounds, { left: 100, right: 900, top: 200, bottom: 800 }, zoom)).toEqual({
    zoom: 2,
    x: 500,
    y: 500,
  });
});

test("long lines fit the remaining height, accounting for frozen toolbar and padding", () => {
  expect(
    reviewFocusFit({ left: 0, right: 0, top: 0, bottom: 1200 }, { left: 0, right: 1000, top: 200, bottom: 1000 }, 2)
      .zoom,
  ).toBeCloseTo(704 / 600);
});

test("a taller wrapped toolbar changes the target center and fit, without enlarging a line", () => {
  const bounds = { left: 0, right: 1200, top: 0, bottom: 500 };
  const a = reviewFocusFit(bounds, { left: 0, right: 800, top: 100, bottom: 900 }, 1);
  const b = reviewFocusFit(bounds, { left: 0, right: 800, top: 400, bottom: 900 }, 1);
  expect(b.y).toBeGreaterThan(a.y);
  expect(b.zoom).toBeLessThanOrEqual(a.zoom);
  expect(b.zoom).toBeLessThan(1);
});

test("incomplete drawing prevents any selection or viewport movement", async () => {
  const image = { vectorReviewBlockReason: () => "请先完成绘制", annotation: { unselectAreas: jest.fn() } };
  await expect(focusReviewVector(image, "x")).rejects.toThrow("完成绘制");
  expect(image.annotation.unselectAreas).not.toHaveBeenCalled();
});

test.each([
  [
    [
      { x: 10, y: 10 },
      { x: 25, y: 10 },
    ],
    2,
    150,
  ],
  [
    [
      { x: 10, y: 10 },
      { x: 10, y: 80 },
    ],
    5,
    150,
  ],
  [
    [
      { x: 70, y: 80 },
      { x: 90, y: 80 },
    ],
    2,
    240,
  ],
])(
  "navigation scrolls and pans to the visible canvas center, fitting long lines and wrapped docks",
  async (vertices, zoom, dockHeight) => {
    const raf = jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      callback();
      return 1;
    });
    try {
      const scroll = {
        scrollTop: 500,
        scrollHeight: 1500,
        clientHeight: 910,
        getBoundingClientRect: () => ({ left: 200, right: 1216, top: 90, bottom: 1000 }),
        querySelector: () => ({ getBoundingClientRect: () => ({ height: dockHeight }) }),
        scrollTo: jest.fn(({ top }) => {
          scroll.scrollTop = top;
        }),
      };
      const container = {
        closest: () => scroll,
        getBoundingClientRect: () => ({
          left: 200,
          right: 1200,
          top: 400 - scroll.scrollTop,
          bottom: 1000 - scroll.scrollTop,
        }),
      };
      const geometry = { value: { vertices } };
      const region = { cleanId: "line", isReadOnly: () => false, serialize: () => geometry };
      const image = {
        currentZoom: zoom,
        stageWidth: 1000,
        stageHeight: 600,
        zoomingPositionX: 0,
        zoomingPositionY: 0,
        connectionVectorRegions: [region],
        vectorReviewBlockReason: () => "",
        annotation: {
          selectedRegions: [],
          unselectAreas: () => {},
          selectAreas: (regions) => {
            image.annotation.selectedRegions = regions;
          },
        },
        stageRef: {
          container: () => container,
          getAbsoluteTransform: () => ({
            point: (p) => ({
              x: p.x * image.currentZoom + image.zoomingPositionX,
              y: p.y * image.currentZoom + image.zoomingPositionY,
            }),
          }),
        },
        setZoom: jest.fn((value) => {
          image.currentZoom = value;
        }),
        updateImageAfterZoom: jest.fn(),
        setZoomPosition: jest.fn((x, y) => {
          image.zoomingPositionX = x;
          image.zoomingPositionY = y;
        }),
      };
      await focusReviewVector(image, "line");
      expect(scroll.scrollTo).toHaveBeenCalled();
      expect(image.annotation.selectedRegions).toEqual([region]);
      const points = vertices.map((p) => ({
        x: 200 + p.x * 10 * image.currentZoom + image.zoomingPositionX,
        y: 400 - scroll.scrollTop + p.y * 6 * image.currentZoom + image.zoomingPositionY,
      }));
      expect((points[0].x + points[1].x) / 2).toBeCloseTo(700);
      expect((points[0].y + points[1].y) / 2).toBeCloseTo(90 + dockHeight + 300);
      expect(Math.min(...points.map((p) => p.y))).toBeGreaterThanOrEqual(90 + dockHeight + 48 - 0.01);
      expect(Math.max(...points.map((p) => p.y))).toBeLessThanOrEqual(90 + dockHeight + 600 - 48 + 0.01);
      expect(image.currentZoom).toBeLessThanOrEqual(zoom);
      if (zoom === 2) expect(image.currentZoom).toBe(zoom);
      expect(region.serialize()).toBe(geometry);
    } finally {
      raf.mockRestore();
    }
  },
);
