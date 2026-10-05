# 根目录整理记录

2026-10-05，基于 `7c51c70c71b35d40edd45c1344bb0e38f10e2c43` 整理当前功能分支。根目录受 Git 管理的文件由 34 个减至 18 个。

## 删除

- `Dockerfile.cloudrun`、`Dockerfile.heroku`、`app.json`、`heroku.yml`：使用上游镜像的一键云部署模板，不构建本项目的定制代码；仓库内没有仍在使用这些文件的 CI、脚本或当前部署入口。
- `azuredeploy.json`、`azuredeploy.parameters.json`：未被当前部署或 CI 使用的 Azure 模板。
- `.black`：重复的旧格式配置，仓库内无调用引用，现有格式化使用 pre-commit 的 Ruff／Blue 和 `pyproject.toml` 配置。
- 本机根目录 `.DS_Store`：Finder 缓存，不属于 Git 文件。

删除的受管文件仍可从上述 Git 提交找回。没有删除产品源码、依赖锁文件、测试、数据库或许可证。

## 归类与引用更新

- 3 个开发／测试／Hugging Face Dockerfile、3 个 Compose 扩展示例及 `prometheus/` 移至 `deploy/upstream/`。同步更新 Makefile、发布工作流和 MinIO 文档，根 Compose 的相对路径语义保持不变。
- `DESIGN.md` 移至 `docs/development/`，更新 Cursor 设计规则引用。
- 贡献说明和行为准则移至 `.github/`，根 README 提供直接链接。
- 原上游 README 移至 `docs/upstream/README.md` 作为通用参考，修正本地链接。根 README 改为定制项目简介、部署入口和目录导航。

根目录保留 `pyproject.toml`、`poetry.lock`、`MANIFEST.in`、Makefile、上游默认 Docker/Compose、LICENSE、NOTICE，以及 Git、CI、格式化／静态检查自动发现的配置。工具文件不能仅因平时不打开就判为无用。

## 验证

- `poetry check --lock` 通过，仅保留既有许可证分类弃用提示。
- MySQL、MinIO、开发覆盖配置及当前 Mac Compose 均通过配置校验；移动前后解析结果逐项一致，仅 Prometheus 配置文件的预期路径改变。MySQL 和覆盖示例保留原有 Compose `version` 弃用提示。
- Makefile 构建／复制目标 dry-run 指向新位置；Hugging Face 工作流路径已更新。
- 根 README、上游参考和新增部署说明的本地链接全部存在；3 个移动的 Dockerfile 内容逐字不变。
- 当前 Mac Dockerfile、Compose、入口脚本、Python 依赖及锁文件保持不变。未重建镜像或重跑产品回归；本次没有改动产品代码。
- `git diff --check` 通过。当前本机标注环境无需重建或重启。
