# L3 未完成 Polygon 返回页面后续画修复

日期：2026-10-06。功能提交：`dd77dd59090e7b10d99e4c037bbc24bd1328950a`、`dcdea8fa5dcd29699035451921ba63f35966cf58`。

## 问题与修复

用户在主卧学习办公组团绘制中通过触控板返回上一页，重新进入后 Focus、创建组团和保存草稿均不可用。任务 9 的草稿 18 实际保存了未闭合 Polygon `NvU-OmYwt-` 的三个顶点，以及完整的组团和父级信息，没有丢失。

有两个相互关联的原因：L3 原生画布过滤掉未选中的组团组成块，未闭合 Polygon 因此无法挂载并触发续画；通用续画逻辑也没有恢复 L3 的 Focus、待绘制组团和占用类型，而未完成状态又禁止通过工具栏重新选择。

现在让可编辑的未闭合 Polygon 显示其原生视图，并从保存的 `occupancy_context` 恢复 UI 绘制状态。恢复使用原父级、组团 ID、类型与备注，选回 Polygon 工具；不改写顶点、标签或来源字段。缺失父级时不以当前 Focus 代替；只读状态不恢复为可绘制。该修复没有改变 macOS/Chrome 的后退手势设置。

## 验证

- 6 个相关套件、189 项测试全部通过，覆盖 L1/L2/L3/L4、DrawingTool 和 L3 原生区域显示规则。新增检查重新载入后继续添加顶点、闭合、身份保留，以及缺失父级、只读拒绝；定制严格 TypeScript 检查通过。
- 完整前端生产构建通过。初版模型修复经过浏览器验证后发现未闭合轮廓没有挂载，追加原生显示规则修复并重新测试、构建；不完整版本没有部署到用户服务。
- Chrome 使用隔离端口 18086、独立 Docker 数据卷加载实际中断草稿的一致性副本。界面自动恢复“学习办公 a573da”、原父分区、Polygon 工具和三个顶点。
- 在副本中实际补点、点击首点闭合、保存草稿。数据库回读证明三个原顶点完全一致，第四点为 `[36.36363636363637, 34.8]`，`closed=true`，组团／逻辑区域／父级／source_version 均保持，其他所有结果逐项不变。
- 测试续画仅发生在副本；实际草稿保留三个点，等待用户继续决定轮廓。没有正式提交该测试标注。

日志、截图、原轮廓记录及续画比较位于仓库外 runtime 的 `logs/l3-resume-20261006/`。最初数据备份为 `snapshots/l3-interrupted-20261006.sqlite3`，测试回读为 `snapshots/l3-resume-qa-after-20261006.sqlite3`。

## 镜像与恢复

镜像 `hanning-label-studio:1.23.2-resume-dcdea8fa`，ID `sha256:7ea0427f08cb56021357f7b0fbab56b5445df50d8b3c3899f2e459d1b90e65bf`，平台 `linux/arm64`，revision 等于最终功能提交。继续使用 QA Dockerfile 临时副本与 `mirror.gcr.io/library`；仓库 Dockerfile 不变。

上一镜像已离线保存为 runtime 的 `images/hanning-label-studio-1.23.2-ortho-ec22fd5a-linux-arm64.tar.gz`，gzip 完整性检查通过。回退时导入并修改 `l1-qa.env` 镜像，再执行父目录 `./qa.sh up -d --wait`，沿用当前数据卷；本轮未执行回退演练。回退到旧版本会重新遇到未完成 Polygon 的恢复缺陷。

## 本机部署结果

本机 `localhost:18085` 已更新，三个服务健康。部署前后四张业务表逐行一致：3 个项目、3 个任务、2 份正式标注、1 份草稿；SQLite 完整性通过。确认实际草稿 `NvU-OmYwt-` 仍保留原三个点且 `closed=false`。对应快照为 runtime 的 `snapshots/before-l3-resume-deploy-20261006.sqlite3` 与 `after-l3-resume-deploy-20261006.sqlite3`。

确认用户原页面显示已保存后，重新加载实际任务，Chrome 已显示“待绘制组团：学习办公 a573da”和“已恢复未完成的多边形，请从现有顶点继续绘制并闭合轮廓”。实际页面没有添加顶点、闭合或提交。

临时 QA 服务、数据卷和密钥副本已清理；仅保留当前使用的镜像、三个容器和原数据卷。测试中间镜像不作为可用发布版本保留。
