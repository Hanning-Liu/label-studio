# L1 固定工具区验收记录

日期：2026-10-05。范围：本机隔离 QA，未切换生产环境。

**当前状态：本次 L1 改造验收完成。代码、自动化、镜像部署、数据回读及回退通过；2026-10-05 用户确认“我已经人工测试完成，没有问题。”，最终界面验收按用户人工确认关闭。**

后续 V 快捷键修复及当前镜像见 [L1-V-HOTKEY-FIX.md](L1-V-HOTKEY-FIX.md)。以下为原版 L1 整体人工验收记录。

## 代码与界面

- 分支：`feature/l1-sticky-toolbar`，起点为升级提交 `83b8fda361c4381c6eb9f8281ea6536f546caa4a`。升级 PR #1 的分支未修改。
- 运行源码：`d272ea9c3f6deccad69e20fcdd56691750c861c2`。
- 顶部提供房间、门与通道、窗及紧凑类型下拉框；右侧显示当前类型支持的 Rectangle、Polygon、Vector，保留移动、平移、缩放。
- 同任务记住各对象的类型及画法，包括提交后模型重建；切换任务重置。未选类型不能开始绘制。
- 绘制时锁定选择，Esc 取消当前未完成区域，开放窗线按 Enter 完成。顶部选择不修改已有区域，右侧区域属性提供分类修改。
- 已识别配置隐藏受管标签面板及相邻标题，保留底层控件及结果契约。不完整配置回退旧界面；L2–L4 不接管。
- 无后端、数据库迁移、项目模板或标签值变更。

## 自动化

最终机器可读结果见 `l1-toolbar-acceptance.json`。新增测试覆盖配置识别与回退、类别/画法切换、跨形状保留标签、非法组合、只读、绘制保护、快捷键、区域编辑及序列化、Esc、绘制事件、提交后记忆和任务重置。

运行完整 Editor 测试，按失败测试名及错误正文与升级基线逐项比较。既有 ImageView 测试夹具缺少 `referenceSyncController` 的失败单独记录，不以失败总数相同放行。完整日志含运行目录与 Jest 执行框架造成的堆栈差异。

定制严格类型检查与既有兼容检查分别记录；兼容检查的既有诊断按完整输出比较。生产前端构建包含在 Docker 构建中。

最终结果：18 项 L1 测试全部通过；Editor 3799 通过、61 既有失败、5 跳过，新增失败为零。严格 TypeScript 检查通过，兼容检查 55 条既有诊断与升级基线完整输出逐字一致。

镜像：`hanning-label-studio:1.23.2-l1-d272ea9c`，平台 `linux/arm64`，镜像 ID `sha256:5ccc13c02ffed80aa1528634d0583f316627d8bfd647516ae6f7fe762b7e6382`。App、worker、gateway 已恢复此镜像且健康。可导入文件在运行目录 `images/hanning-label-studio-1.23.2-l1-d272ea9c-linux-arm64.tar`，校验和为同目录 `L1-SHA256SUMS`。

## Chrome 与数据

- 图片：`/Users/Bill_Admin/Downloads/深大分享/floorplan.png`，693×1000。
- 原任务 5、标注 4 的图片及完整结果保持不变。独立任务 6、标注 5 用于本次操作测试。
- 已通过 Chrome 创建、保存并回读：2 个 Rectangle 房间、1 个 Polygon 房间、Door 矩形、Open passage 矩形、Open passage Vector、Window Vector，共 7 个区域。
- 测试几何用于操作与契约验证，不代表人工审定的房间真值。
- 验证矩形/多边形类别保持、区域属性编辑、绘制中锁定、Esc、`g`/`1` 快捷键、比较模式禁用绘图及下方重复章节消失。
- 窗线首次偏离轮廓被原有后端校验拒绝，对齐后保存成功；未放宽几何规则。
- 新结果的 `from_name`、`to_name`、标签、ID、几何、来源字段保持原生格式。
- 布局截图及最终镜像重开检查在机器可读报告中记录。

已留存截图：[常用窗口](l1-toolbar-evidence/common-layout.jpg)、[滚动后固定区](l1-toolbar-evidence/sticky-scrolled.jpg)、[旧镜像读取七区域](l1-toolbar-evidence/rollback-seven-regions.jpg)。截图来自最终修复前的视觉相同候选版，不能替代最终提交的完整浏览器验收。

最终人工验收：2026-10-05，用户确认“我已经人工测试完成，没有问题。”。此前因 Mac 锁屏留下的最终界面复核按此确认关闭，不再要求重复测试。本次记录为用户人工验收通过；用户未提供逐项操作记录或新的截图，因此不将其表述为助手重新实测了特定视口、主题或 Chrome 当前停留状态。

历史观察保留：早期 1280×900、100% 响应式视口曾出现内容和底部裁切，[截图](l1-toolbar-evidence/dark-1280-pending.jpg)是当时的记录；90% 和原生半宽窗口可见提交按钮。该记录保留用于追溯，与后续用户整体人工验收结论分别记录。

## 保留数据的回退演练

在新增 7 个区域后，隔离环境切回 `hanning-label-studio:1.23.2-99540e67`，使用原有 `hanning-1232-qa_data` 数据卷。旧镜像的 Chrome 界面与 API 均能读取全部 7 个区域。回退前后结果 SHA-256 相同：

`50dca10b3f66266c5752ba47b8912caec68c4834f03636089130cee8eb2d19fa`

原任务 5 结果始终不变。SQLite 一致性备份及 `PRAGMA integrity_check` 通过（`ok`）。没有用旧数据库覆盖新标注。

## 启动与回退

运行配置与敏感信息保留在仓库外：`/Users/Bill_Admin/Research/label-studio-project/label-studio-upgrade-runtime`。最终镜像配置为 `l1-qa.env`，上一镜像配置为 `qa.env`，文件权限为 600。

在本仓库根目录启动最终版：

```sh
docker compose --env-file /Users/Bill_Admin/Research/label-studio-project/label-studio-upgrade-runtime/l1-qa.env \
  -f deploy/compose.hanning-1232.qa.yml -p hanning-1232-qa up -d --wait
```

回退镜像、保留最新数据：

```sh
docker compose --env-file /Users/Bill_Admin/Research/label-studio-project/label-studio-upgrade-runtime/qa.env \
  -f deploy/compose.hanning-1232.qa.yml -p hanning-1232-qa up -d --wait
```

不得执行 `down -v`，不得以旧数据库替换现有卷。恢复新版使用第一条命令。App、worker、gateway 使用同一配置镜像，健康检查均需通过。

访问原任务：<http://localhost:18085/projects/5/data/?task=5&tab=3>；本次验收任务：<http://localhost:18085/projects/5/data/?task=6&tab=3>。

完整日志、回读 JSON、数据库快照及全尺寸截图在仓库外运行目录；交付摘要与精选截图随代码保存。验收结论仅覆盖本次 L1 界面变更和本机隔离数据，不替代生产副本验收。
