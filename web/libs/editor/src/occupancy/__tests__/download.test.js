import { downloadJson, exportOccupancyRecovery } from "../download";
let click;
beforeEach(() => {
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
