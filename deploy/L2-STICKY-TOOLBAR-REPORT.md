# L2 固定工具区验收记录

日期：2026-10-05。功能源码：`50ca15be4cdaf639c84e84ee8a2178694068c6cf`，分支 `feature/l1-sticky-toolbar`。

## 使用与兼容

L2 图片上方固定区域现包含“功能分区 / 交通连通 / 视觉连通”和紧凑类型下拉框，保留 Focus room、参考同步、整房继承与连通复核。功能分区在右侧选择 Rectangle / Polygon，连通类型使用 Vector；滚动时右侧工具栏根据顶部区域实际高度避让。

类别读取项目现有配置。切换画法保留类别；顶部选择只影响后续绘制，已有区域通过右侧“区域类型”编辑。绘制过程中禁止切换类型和 Focus room；V 返回移动/选择，Esc 取消未完成绘制。只读参考没有绘制入口。接管的标签面板和直属标题不再在图片下方重复显示，复核控件仍然注册；无法安全识别的自定义配置保留原界面。

没有修改模板、API、数据库或已保存标注格式。功能分区仍分别序列化 `zone_rectangle` / `zone_polygon` 几何和 `function_zone` 标签。

## 验证

- Editor 全量运行：181 个套件通过；另一个套件因测试容器未挂载共享 `geometry_cases.json` 未能运行。补齐挂载后，该套件的 23 项全部通过。
- 后续补充 Polygon 取消、两类 Vector 完成、固定区高度变化测试。最终新增 L2 测试 14 项通过；受布局修改影响的 Toolbar 9 项通过。合计覆盖 182 个 Editor 套件、3,905 项通过、5 项原有跳过，无待处理失败。
- `hanning/tsconfig.typed.json` 严格 TypeScript 检查通过。
- 完整前端生产构建通过。构建输出含 44 条警告；本轮没有清理上游样式弃用警告。
- 本机 Chrome 使用隔离数据副本绘制 Rectangle 与 Polygon 功能分区、Door 交通连通、Visual only 视觉连通，保存草稿后刷新，结果逐项一致。V 返回选择工具正常。
- 实测向下滚动后顶部仍固定，右侧全部绘图工具保持可见，图片下方无重复分类。检查了浅色、深色主题；未单独调整为 1280×900。
- 本轮为工具布局验收，未将测试草稿正式提交成完整合规的 L2 标注。

首次最终构建因同时运行两套服务而触及 Docker 内存上限；停止临时服务后重建成功。首次 QA 使用 macOS 绑定目录时出现 SQLite 锁等待；将一致性副本转入 Docker 原生临时卷后，app、worker、gateway 均恢复健康。正式环境始终使用原 Docker 数据卷。

## 部署与数据

- 镜像：`hanning-label-studio:1.23.2-l2-50ca15be`
- 镜像 ID：`sha256:b8b1487afb73d8a716e06a733f09578e7f69b2bd4d5291d075c3fb9c1b961345`
- 平台：`linux/arm64`，Node 22 / Python 3.13；镜像 revision 标签等于上述源码 SHA。
- 构建使用 `deploy/Dockerfile.l4-furniture-instances.qa` 的临时副本，沿用上轮 Docker Hub 故障处理：仅去掉远程 syntax 首行并设置 `BASE_IMAGE_REGISTRY=mirror.gcr.io/library`。仓库 Dockerfile 未更改。
- 本机服务 `localhost:18085` 已更新。部署前后对四张业务表逐行比较：2 个项目、2 个任务、1 份正式标注、0 份草稿完全一致，SQLite integrity_check 为 ok。该比较在浏览器打开更新后的任务之前完成；进入 L2 编辑页后会正常建立工作草稿。
- QA 的四种测试标注仅存在副本，没有写入正式项目。

日志、截图、草稿回读比较和部署数据指纹位于仓库外 `label-studio-upgrade-runtime/logs/l2-toolbar-20261005/`。部署前后备份位于 runtime 的 `snapshots/before-l2-deploy-20261005.sqlite3` 与 `after-l2-deploy-20261005.sqlite3`。

## 回退与清理

旧镜像离线包：runtime 的 `images/hanning-label-studio-1.23.2-create-ab359bfb-linux-arm64.tar.gz`，已通过 gzip 完整性检查。回退时导入旧镜像，将 `l1-qa.env` 镜像改回 `hanning-label-studio:1.23.2-create-ab359bfb`，执行项目目录 `./qa.sh up -d --wait`，继续使用当前数据卷，不能用旧数据库覆盖新标注。本轮未另行演练切回旧镜像。

临时 QA 容器、网络、卷及测试镜像在完成后清理；Docker 保留当前使用的一个镜像、三个容器、一个数据卷。旧镜像保存在仓库外用于回滚。
