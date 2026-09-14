# L4 晾衣架类别（2026-09-14）

基线：`207072b9e2adeb4b6e9066107015e8964075b514`。可执行代码：`3b8239db3844c19323bf1e4bc1225c80f222858a`。
镜像：`label-studio-window-l4:rack-3b8239db3`；镜像 ID：`sha256:e6e16e8da7ff10003bb752261992247dc920851170619f09e4e9682136b66ee7`。

## 行为与阅读路径

原类别按钮取前端目录与项目 Choices 的交集，后端与聚合器使用允许类别集。本次增加 `drying_rack`（晾衣架），追加在“卫浴设施”的淋浴设施之后，沿用 `#0F766E`，类别共 30 项。已有实例不自动改类。

阅读顺序：`web/libs/editor/src/furnitureInstances/domain.js` → `presentation.js` / `catalogDetails.json` → `label_studio/tasks/furniture_instances/__init__.py` → `catalog_upgrade.py`。新模板自动使用后端清单；既有绘制、轮廓创建、改类、复核及导出保存路径保持不变。

标注边界与别称见 `deploy/L4-furniture-catalog.md`。仅标注可辨识的晾衣架设施轮廓，不以整个晾晒空间代替架体；不根据界面“卫浴设施”分组推断 IFC 卫生终端类型。

## 验证

- 家具与 Image 前端回归：21 文件、248 项通过。测试发现初次实现遗漏独立说明目录，补齐后全组复跑通过。
- 家具实例后端、模板和安全配置升级：56 项通过，含旧 29 类仅补晾衣架、旧 28/26 类兼容、XML 保留、幂等及身份/并发/别名冲突拒绝。
- 聚合、严格 Schema、导出往返：17 项通过，新增晾衣架往返用例。生产镜像完整构建通过。
- 独立 QA：`label-studio-l4-drying-rack-qa`，`127.0.0.1:18087`，使用当前 8080 数据一致性副本和只读图片。
- QA 按钮位于正确分组且可选，说明正常；在洗衣晾晒组团创建、保存、复核并正式提交新实例，重新加载显示 61 个已复核实例。
- QA 仅新增测试实例的两条结果，原有 497 条结果完全不变；除项目 13 类别配置及其测试标注外，其余正式标注、草稿、任务和参考关系保持一致。QA 数据不迁入生产。

## 目标项目升级与回退

仅升级 `L4_FurnitureInstances_merged_real_test`（项目 13）。已验收配置差异仅追加 `<Choice value="晾衣架" alias="drying_rack"/>`，SHA-256 从 `c4559f88ea5971526a267ae99e01ec9ea81028caef1ac9ab29004cd971df6c05` 到 `8266011420c3eb659194ea87492ed6840fb3a0f9d0c63e28c53bfdd6f30a3f42`；生产应用前重新核对。

在用户保存并暂停编辑后，备份数据库、数据文件、环境和 Compose，再同时升级 8080 app 与 sync worker，并通过既有 `upgrade_furniture_instance_choices` 命令的项目名称及 SHA-256 保护追加选项。完整私有日志、截图和部署记录位于本地 `work/drying-rack-audit`，不提交研究数据。

旧镜像 `label-studio-window-l4:progress-797e1a5f3` 仅支持 29 类：尚无晾衣架结果时，可核对后恢复旧配置与旧镜像；产生 `drying_rack` 结果后必须保留选项、数据和支持 30 类的兼容镜像，不能直接回退旧镜像或覆盖数据库。
