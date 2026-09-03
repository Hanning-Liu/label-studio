import { colorWithAlpha, roomColor, shortId } from "../OccupancyPresentation";

test("room presentation keeps the reference color and makes long IDs secondary", () => {
  expect(roomColor({ roomColor: "#FFA39E" })).toBe("#FFA39E");
  expect(colorWithAlpha("#FFA39E", 0.08)).toBe("rgba(255, 163, 158, 0.08)");
  expect(shortId("oc_0123456789abcdef", 8)).toBe("…89abcdef");
});

test("room presentation has a neutral fallback", () => {
  expect(roomColor({})).toBe("#7b8a83");
  expect(colorWithAlpha("invalid", 0.16)).toBe("rgba(123, 138, 131, 0.16)");
});
