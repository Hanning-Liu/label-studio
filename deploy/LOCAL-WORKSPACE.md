# 本机项目目录整理

后续根目录整理见 [维护记录](../docs/development/ROOT-CLEANUP.md)：开发及测试 Dockerfile 已移至 `deploy/upstream/`，下面的 6 个根目录 Dockerfile 为首次整理时的历史数量。

2026-10-05，三个项目目录统一移入 `/Users/Bill_Admin/Research/label-studio-project/`：

- `label-studio-upgrade-1.23.2/`：当前开发仓库。
- `graph-label/`：1.23.0 历史开发仓库。
- `label-studio-upgrade-runtime/`：私有运行配置、媒体、备份、日志和工具。

两个开发仓库各有 35 个早期补丁 Dockerfile 移至 `deploy/archive/legacy-patches/`，逐文件 SHA-256 验证内容完全一致。根目录保留 6 个官方、开发及测试 Dockerfile；当前定制构建入口 `deploy/Dockerfile.l4-furniture-instances.qa` 不变。更新 `.dockerignore` 及历史构建说明中的引用。用于升级对比的 baseline 仓库未修改。

父目录 `README.md` 说明目录用途，`qa.sh` 根据自身位置解析路径，可执行 `./qa.sh up -d --wait` 和 `./qa.sh ps`。私有 env、辅助脚本及 Poetry 环境中的活动路径已更新，Poetry 2.3.2 可正常执行。历史验收日志保留原文。

## 验证

- 迁移前后均保存 SQLite 一致性快照，完整性检查为 `ok`。
- 5 个项目、7 个任务、6 条已提交标注、4 条草稿及参考同步绑定／映射的业务字段哈希完全一致。仅 worker 心跳时间正常推进，单独记录。
- 保留原 `hanning-1232-qa_data` 数据卷和 `hanning-label-studio:1.23.2-l1-9d2ac5b1` 镜像，未回退数据库。
- App、worker、gateway 按新路径重建后均健康，`http://localhost:18085/health/` 返回 200。
- 原任务 5 上传的 `floorplan.png` 及只读本地媒体挂载均可读取。
- `git diff --check`、Compose 配置校验和启动脚本语法检查通过。

本次仅整理目录和构建文件位置，无产品代码变化，未重跑前端回归或重新构建镜像。详细路径映射、归档文件校验和及数据比较见私有运行目录 `logs/directory-reorganization.json`。
