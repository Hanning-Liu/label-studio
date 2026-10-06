# L1 正交化像素吸附验收

日期：2026-10-06。功能源码：`37d4d3576360da6be336c25b48d224ed499f7762`，分支 `feature/l1-sticky-toolbar`。

## 修改

原算法对共享水平／垂直坐标取平均，平均值可能落在像素之间。现在按原图自然宽高将每组平均坐标取整，再转换回 Label Studio 的百分比坐标。整组使用同一坐标，保持凹多边形、中间共线顶点和闭合边正交；已正交但未对齐像素的形状也会处理。画布缩放不参与计算。

沿用现有按钮、单次撤销／重做、区域及顶点 ID、标签、来源信息和保存格式。吸附导致短边塌缩、反向或自交时拒绝修改并保留原形状。提示文字明确显示吸附结果。未修改后端、数据库或其他层级工具。

## 验证

- 相关 2 个 Editor 测试套件共 39 项通过；覆盖不同原图尺寸、非方形像素比例换算、凹多边形、共线点、图像边界、亚像素短边拒绝、幂等性，以及 ID／元数据保持、撤销重做和序列化回读。
- 定制严格 TypeScript 检查通过；完整前端生产构建通过，仍有 44 条构建警告。本次未重新运行全量 Editor 测试。
- Chrome 在独立端口 18086、独立 Docker 数据卷中验证。测试副本将 L1 第一个 Polygon 卧室的全部顶点在 x/y 各偏移 0.25 原图像素。点击按钮后成功提示像素吸附，保存、刷新后再次点击提示“无需调整”。
- 回读副本数据库确认该房间 8 个顶点全部为原图整数像素位置、每条边正交，其余 24 个区域逐项未变。百分比坐标反算存在约 1e-13 的正常浮点误差，验证阈值为 1e-7 像素。没有对正式标注运行此测试操作。
- 日志、回读数据和 Chrome 截图位于仓库外 runtime 的 `logs/pixel-snap-20261006/`。

## 镜像与恢复

- 镜像：`hanning-label-studio:1.23.2-pixel-37d4d357`
- ID：`sha256:e062c352c2c6f45211e40182a1f9a860caf6b03b8abae94b691a5108113cfce3`
- 平台：`linux/arm64`；revision 标签等于上述功能源码 SHA。
- 构建使用现有 QA Dockerfile 的临时副本，去掉远程 syntax 首行并设置 `BASE_IMAGE_REGISTRY=mirror.gcr.io/library`；仓库 Dockerfile 不变。
- 上一镜像离线保存于 runtime 的 `images/hanning-label-studio-1.23.2-l2-50ca15be-linux-arm64.tar.gz`，gzip 完整性检查通过。需要回退时导入该镜像，把 `l1-qa.env` 中镜像改回 `hanning-label-studio:1.23.2-l2-50ca15be`，执行父目录 `./qa.sh up -d --wait`，继续使用当前数据卷；本次未执行回退演练。

## 本机部署结果

`localhost:18085` 已更新至上述镜像，app、worker、gateway 均健康。更新前后逐行比较 `project`、`task`、`task_completion`、`tasks_annotationdraft`：2 个项目、2 个任务、2 份正式标注、0 份草稿全部一致，SQLite 完整性检查为 ok。该比较在打开更新后的实际项目之前完成。Chrome 已留在实际 L1 项目并选中 Polygon，未点击其正交化按钮或提交。

部署前后快照分别为 runtime 的 `snapshots/before-pixel-deploy-20261006.sqlite3` 与 `after-pixel-deploy-20261006.sqlite3`。临时 QA 容器／卷已删除，测试用密钥副本及目录已移除；原数据卷沿用。
