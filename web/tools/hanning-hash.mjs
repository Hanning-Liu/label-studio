import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Nx's workspace is web/. Hash the external tree explicitly, including file
// names and lengths, so additions, removals and edits all invalidate tasks.
const root = join(dirname(fileURLToPath(import.meta.url)), "../../hanning");
const hash = createHash("sha256");
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (["__pycache__", ".pytest_cache", "node_modules"].includes(entry.name) || entry.name.endsWith(".pyc")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      hash.update(`${relative(root, path).replaceAll("\\", "/")}\0${bytes.length}\0`);
      hash.update(bytes);
    } else throw new Error(`Unsupported customization source entry: ${path}`);
  }
}
visit(root);
process.stdout.write(`${hash.digest("hex")}\n`);
