# Create 层级项目创建验收记录

日期：2026-10-05。功能源码：`ab359bfb1fda564e7d7f3022c0ec9db86757f929`，分支 `feature/l1-sticky-toolbar`。

## 使用

项目列表 → **Create** → 选择 **L1 / L2 / L3 / L4**。

- L1：填写名称后创建，系统配置房间、门、通道与窗模板，再通过 Import 导入图片。
- L2–L4：选择上一层项目和图片，填写名称后创建。自动带入图片引用和只读参考，并建立现有参考同步绑定。
- 一次带入所选的一张图片；当前只有一个来源项目和一张有效图片时自动选中。
- 必须具有唯一有效的上游正式标注及完整来源链；草稿、过期参考、错误层级和来源变化均不会被忽略。创建失败整体回滚，同名重复创建返回明确错误。
- 原有通用创建向导在“普通项目 / 自定义模板”中保留。

未修改上游标注、已有结果格式或数据库结构。下游仍需人工标注并提交，L2 沿用自动参考同步，L3/L4 沿用手动应用。

## 自动化验证

| 范围 | 结果 |
| --- | --- |
| 新增创建 API 数据库测试 | 12 通过 |
| 包含上述 12 项的参考同步、来源链、L3、L4 回归 | 93 通过 |
| 新建界面交互测试 | 7 通过 |
| `hanning/tsconfig.typed.json` | 通过 |
| 前端生产构建 | 通过 |
| `poetry check --lock` | 通过；无依赖版本变更 |

后端通过 Django test runner 运行 `projects.test_hierarchy.HierarchyCreationTests`、`tasks.reference_sync.tests`、`tasks.reference_sync.test_lineage`、`tasks.occupancy.tests`、`tasks.furniture_instances.tests`。首次组合测试未挂载仓库 `scripts`，导致已有导出测试缺少模块；补齐挂载后全部通过。

前端使用 Editor 的 Jest 配置运行 `hanning/tests/frontend/HierarchyProjectForm.test.tsx`。测试覆盖分页、唯一来源选择、创建防重、层级切换、无正式来源、失败提示、普通入口和过期异步响应。

## Chrome 与真实数据副本

在隔离的 `localhost:18086` 环境中完成：

- 从项目 5 / 任务 5 / 正式标注 4 创建 L2 项目，打开图片任务成功。
- 24 条参考结果均为只读，包含 6 条窗线；来源链显示窗参考一致。
- 新项目创建时没有生成正式人工标注；进入编辑器后正常生成工作草稿。
- L2 尚未提交时，L3 界面显示缺少唯一正式标注并禁止创建；无 L3 项目时，L4 显示先完成上一层的提示。
- L1 创建后直接进入图片导入页；普通项目仍能进入原向导并取消。
- 浅色和深色主题可用。

L3、L4 的成功创建由真实数据库来源链测试覆盖；未在浏览器中人工完成整套 L2/L3 标注。未单独调整窗口到 1280×900 验证。

真实运行环境更新前后，项目、任务、正式标注和草稿四张表逐行完全一致：1 个项目、1 个任务、1 份正式标注、0 份草稿。图片 SHA-256：`679c1ddea021febdacdbf161e8249701d18a4d20171b03e749b812e0ba997ef7`。

## 镜像、部署与回退

- 镜像：`hanning-label-studio:1.23.2-create-ab359bfb`
- 镜像 ID：`sha256:0d4183518d5c5e7b4dbc92b1a9a44ea3a66de9f27b8fbc13983fe6aa800afe83`
- 平台：`linux/arm64`；Python 3.13、Node 22、Poetry 2.3.2。
- 本机 `localhost:18085` 的 app、worker、gateway 已使用同一镜像且健康。
- 使用 `deploy/Dockerfile.l4-furniture-instances.qa` 构建。Docker Hub 连接故障期间，仅在临时副本中去掉第一行远程 syntax 引用，改用 Docker 内置语法，并传入 `BASE_IMAGE_REGISTRY=mirror.gcr.io/library`；其余构建步骤一致。仓库 Dockerfile 未改动。

验收日志、截图和数据指纹位于仓库外 `label-studio-upgrade-runtime/logs/hierarchy-creation-20261005/`。一致性备份位于 runtime 的 `snapshots/before-hierarchy-deploy-20261005.sqlite3`；旧镜像离线包位于 `images/hanning-label-studio-1.23.2-l1-9d2ac5b1-linux-arm64.tar.gz`，用于不依赖联网重建的回退。

回退时导入旧镜像，恢复 `l1-qa.env` 中的旧镜像标签，执行同一 Compose 的 `up -d --wait`，继续使用当前数据卷。不得用旧数据库覆盖新标注。新增项目沿用原有模板、结果和绑定结构；本轮未单独切回旧镜像演练。

临时验收容器、测试数据卷和测试镜像均在验收后清理。当前运行环境保留一个镜像、三个容器、一个数据卷。
