import {
  cacheOccupancyRecovery,
  downloadJson,
  exportOccupancyRecovery,
  readCachedOccupancyRecovery,
} from "../download";
let click;
beforeEach(() => {
  sessionStorage.clear();
  click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => click.mockRestore());
test("JSON backup works when the browser URL object lacks Blob helpers", () => {
  const previous = URL.createObjectURL;
  URL.createObjectURL = undefined;
  downloadJson({ result: [{ id: "区域" }] }, "backup.json");
  const link = click.mock.instances[0];
  expect(link.download).toBe("backup.json");
  expect(JSON.parse(decodeURIComponent(link.href.split(",")[1]))).toEqual({ result: [{ id: "区域" }] });
  expect(document.body.contains(link)).toBe(false);
  URL.createObjectURL = previous;
});
test("recovery includes all results and the config, not only the current group", () => {
  const result = [{ id: "ref", readonly: true }, { id: "manual" }];
  exportOccupancyRecovery(
    {
      store: { task: { id: 22, data: '{"image":"local.png"}' }, config: "<View/>" },
      referenceVersion: "v1",
      serializeAnnotation: () => result,
    },
    "test",
  );
  const link = click.mock.instances[0];
  const data = JSON.parse(decodeURIComponent(link.href.split(",")[1]));
  expect(data[0].annotations[0].result).toEqual(result);
  expect(data[0].meta.occupancy_recovery.label_config).toBe("<View/>");
});
test("automatic recovery uses one session cache entry and never downloads a file", () => {
  const result = [{ id: "manual" }];
  const annotation = {
    store: { task: { id: 22, data: '{"image":"local.png"}' }, config: "<View/>" },
    referenceVersion: "v1",
    draftId: 7,
    draftRevision: "2026-08-28T00:00:00Z",
    serializeAnnotation: () => result,
  };

  const firstKey = cacheOccupancyRecovery(annotation, "before-first-operation");
  const secondKey = cacheOccupancyRecovery(annotation, "before-l3-walkable-generation");
  const cached = readCachedOccupancyRecovery(annotation);

  expect(firstKey).toBe(secondKey);
  expect(sessionStorage.length).toBe(1);
  expect(cached[0].annotations[0].result).toEqual(result);
  expect(cached[0].meta.occupancy_recovery.reason).toBe("before-l3-walkable-generation");
  expect(click).not.toHaveBeenCalled();
});
