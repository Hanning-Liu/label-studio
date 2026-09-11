import fs from "fs";
import path from "path";
import { connectionZoneIds } from "../scope";
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../../../examples/l4-hierarchy/connectivity-cases.json"), "utf8"),
);
test.each(fixture.cases)("exporter connectivity parity: $name", (value) => {
  const zones = fixture.zones.map((z) => ({ ...z, geometry: [[[...z.points, z.points[0]]]] }));
  const result = {
    original_width: fixture.width,
    original_height: fixture.height,
    value: { closed: false, vertices: value.vertices.map(([x, y]) => ({ x, y })) },
  };
  if (value.expected.length) expect(connectionZoneIds(result, zones)).toEqual(value.expected);
  else expect(() => connectionZoneIds(result, zones)).toThrow();
});
