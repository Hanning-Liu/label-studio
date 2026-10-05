# Editor 测试夹具修复

日期：2026-10-05。分支：`feature/l1-sticky-toolbar`。修复前提交：`a9aec20b9a4c9f2a18eed93a1bf1c45d00ef5257`。

此前记录的 61 项 Editor 失败均来自 `ImageView.test.jsx`：模拟 annotation 缺少真实模型提供的 `store`，导致渲染参考同步控件时读取 `referenceSyncController` 抛出 TypeError，测试尚未执行到各自的行为断言。

本次在共享测试构造器中补齐 `annotation.store` 和空的 `referenceSyncController`，并将特殊 annotation 参数合并到默认值，确保只读等场景也保留完整结构。未修改产品代码、断言或跳过规则。

## 验证结果

使用既有 `graph-label-l4-frontend-test:local` 测试镜像及 `hanning-l1-frontend-deps` 依赖卷执行完整 Editor Jest：

```sh
node node_modules/jest/bin/jest.js --config libs/editor/jest.config.js --runInBand --forceExit --json --outputFile=/results/imageview-fixture-fix-editor.json
```

- 180 套测试全部通过；3884 项通过、0 项失败、5 项原有跳过。
- 与修复前 `l1-orthogonal-editor-final.json` 按完整测试名称比较：原 61 项失败全部变为通过；跳过测试名称集合完全一致。
- `git diff --check` 通过。
- 本机完整日志和 JSON 位于相邻运行目录 `label-studio-upgrade-runtime/logs/imageview-fixture-fix-editor.{log,json}`。

此前升级、工具栏及正交化报告中的 61 项失败是当时的历史结果，已由本次修复消除。其他检查的历史诊断不属于这 61 项，本次未修改或重新验收。

此修复仅涉及测试数据构造，无需重建或部署应用镜像，不影响现有标注数据。
