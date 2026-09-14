const path = require("node:path");

module.exports = function withHanning(config) {
  const web = path.resolve(__dirname, "..");
  const custom = path.resolve(web, "../hanning");
  config.resolve.alias = {
    ...config.resolve.alias,
    "@hanning": custom,
    "@humansignal/editor": path.join(web, "libs/editor/src"),
    ...Object.fromEntries(["react", "react-dom", "mobx", "mobx-react", "mobx-state-tree"].map((name) =>
      [name, path.join(web, "node_modules", name)],
    )),
  };
  // Preserve each dependency's own nested versions. The web root is only a
  // fallback for custom sources living outside the workspace.
  config.resolve.modules = [...(config.resolve.modules || ["node_modules"]), path.join(web, "node_modules")];
  config.resolveLoader = {
    ...config.resolveLoader,
    modules: [path.join(web, "node_modules"), "node_modules"],
  };
  // Reuse the Editor's exact Babel transforms for source outside Nx's root.
  // Existing SCSS/JSON rules apply without a sourceRoot restriction.
  function excludeCustom(rules) {
    for (const rule of rules) {
      const loaders = [rule.loader, ...[].concat(rule.use || []).map((use) => typeof use === "string" ? use : use.loader)];
      if (loaders.some((loader) => loader?.includes("babel-loader"))) {
        rule.exclude = [...[].concat(rule.exclude || []), custom];
      }
      if (rule.oneOf) excludeCustom(rule.oneOf);
      if (rule.rules) excludeCustom(rule.rules);
    }
  }
  excludeCustom(config.module.rules);
  const editorBabel = JSON.parse(require("node:fs").readFileSync(path.join(web, "libs/editor/.babelrc"), "utf8"));
  const resolveEntries = (entries) => entries.map((entry) => Array.isArray(entry)
    ? [require.resolve(entry[0]), ...entry.slice(1)] : require.resolve(entry));
  config.module.rules.push({
    test: /\.[jt]sx?$/,
    include: custom,
    use: {
      loader: require.resolve("babel-loader"),
      options: {
        babelrc: false,
        configFile: false,
        presets: resolveEntries(editorBabel.presets),
        plugins: resolveEntries(editorBabel.plugins),
      },
    },
  });
  return config;
};
