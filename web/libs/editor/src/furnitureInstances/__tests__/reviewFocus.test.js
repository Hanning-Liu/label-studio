import { furnitureReviewPoints, reviewViewportFit } from "../reviewFocus";

const view = { left: 100, top: 200, right: 700, bottom: 800 };
test.each([0.25, 0.5, 1, 2])("visible furniture leaves position and zoom %s unchanged", (zoom) => {
  expect(reviewViewportFit({ left: 200, top: 300, right: 400, bottom: 500 }, view, zoom)).toBeNull();
});
test("offscreen target pans at current zoom; large target only zooms out", () => {
  expect(reviewViewportFit({ left: 0, top: 0, right: 100, bottom: 100 }, view, 1).zoom).toBe(1);
  expect(reviewViewportFit({ left: 0, top: 0, right: 1200, bottom: 1200 }, view, 1).zoom).toBeLessThan(1);
});
test("focus includes every geometry component and orientation point", () => {
  expect(
    furnitureReviewPoints({
      geometry: [
        [
          [
            [1, 1],
            [2, 2],
          ],
        ],
        [
          [
            [20, 20],
            [30, 30],
          ],
        ],
      ],
      orientationResults: [
        {
          value: {
            vertices: [
              { x: 40, y: 40 },
              { x: 50, y: 50 },
            ],
          },
        },
      ],
    }),
  ).toEqual([
    [1, 1],
    [2, 2],
    [20, 20],
    [30, 30],
    [40, 40],
    [50, 50],
  ]);
});

test("superseded asynchronous navigation cannot move the image", async () => {
  const { focusFurnitureReview } = jest.requireActual("../reviewFocus");
  const originalFrame = global.requestAnimationFrame;
  const frames = [];
  global.requestAnimationFrame = (callback) => {
    frames.push(callback);
  };
  const canvas = { left: 0, top: 0, right: 800, bottom: 800 };
  const scroll = { getBoundingClientRect: () => canvas };
  const item = {
    annotation: {},
    currentZoom: 1,
    stageWidth: 800,
    stageHeight: 800,
    zoomingPositionX: 0,
    zoomingPositionY: 0,
    stageRef: {
      container: () => ({ getBoundingClientRect: () => canvas, closest: () => scroll }),
      getAbsoluteTransform: () => ({ point: (point) => point }),
    },
    setZoom: jest.fn(),
    setZoomPosition: jest.fn(),
    updateImageAfterZoom: jest.fn(),
  };
  try {
    const old = focusFurnitureReview(item, [
      [0, 0],
      [10, 10],
    ]);
    const newest = focusFurnitureReview(item, [
      [30, 30],
      [40, 40],
    ]);
    while (frames.length) {
      frames.splice(0).forEach((callback) => callback());
      await Promise.resolve();
    }
    await Promise.all([old, newest]);
    expect(item.setZoomPosition).not.toHaveBeenCalled();
    expect(item.setZoom).not.toHaveBeenCalled();
  } finally {
    global.requestAnimationFrame = originalFrame;
  }
});
