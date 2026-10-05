# Hanning Label Studio

基于 **Label Studio 1.23.2** 的室内平面图标注定制版，支持 L1 房间、门通道与窗，L2 功能区，L3 家具占用区和 L4 家具实例，以及参考同步、几何校验和图导出。

当前完整定制代码位于 **`feature/l1-sticky-toolbar`** 分支。

## 安装与使用

**新电脑从这里开始：[macOS 从零部署指南](deploy/MACOS-SETUP.md)**

指南涵盖 Docker 安装、源码构建、首次登录、项目创建、图片导入、备份、迁移电脑和升级回滚。定制版构建入口为 `deploy/Dockerfile.l4-furniture-instances.qa`，启动入口为 `deploy/macos.sh`。官方 `heartexlabs/label-studio` 镜像不包含本项目的定制功能。

- [L1 房间与窗模板](examples/room-window-annotation/room-window-v1.xml)
- [层级标注说明](docs/l4-hierarchical-annotation.md)
- [参考同步](deploy/README.l3-reference-sync.md) · [窗参考链](deploy/L1-L4-window-lineage.md)
- [家具类别与项目升级](deploy/L4-furniture-catalog.md)
- [Windows 历史运行与上线说明](deploy/Hanning-runtime.md)

## 目录导航

| 目录 | 内容 |
| --- | --- |
| `hanning/` | 本项目 L1–L4 定制逻辑；[架构说明](hanning/README.md) |
| `label_studio/` | Label Studio 后端与模型 |
| `web/` | 前端编辑器、数据管理器及构建工具 |
| `deploy/` | 定制构建、启动、验收和维护指南 |
| `examples/` | 标注 XML 模板与示例 |
| `scripts/` | 数据导出、迁移和检查脚本 |
| `docs/` | 功能、设计与开发文档 |
| `tools/` | 开发工具 |
| `images/`、`licenses/` | 说明图片和第三方许可 |

数据库、用户图片、账号配置和备份放在仓库外的运行目录；它们不随 GitHub 源码分发。

根目录保留 Python 依赖、锁文件、打包配置、Makefile 和工具自动读取的配置。通用上游 `Dockerfile`、`docker-compose.yml` 保留，供原有开发及 CI 使用；定制部署按上面的 Mac 指南操作。

## 开发与验证

- [运行和测试入口](deploy/Hanning-runtime.md)
- [Mac 部署验收及验证边界](deploy/MACOS-SETUP-VERIFICATION.md)
- [Editor 测试修复记录](deploy/EDITOR-TEST-FIX.md)
- [开发 Dockerfile 与 Compose 扩展示例](deploy/upstream/README.md)
- [界面设计规范](docs/development/DESIGN.md)
- [贡献说明](.github/CONTRIBUTING.md) · [行为准则](.github/CODE_OF_CONDUCT.md)

早期 1.23.0 补丁 Dockerfile 位于 `deploy/archive/legacy-patches/`；仅供历史追溯。根目录整理清单见 [维护记录](docs/development/ROOT-CLEANUP.md)。

## 上游与许可

本项目基于 [HumanSignal/label-studio](https://github.com/HumanSignal/label-studio) 开发。上游通用功能和安装方式见 [上游说明](docs/upstream/README.md)。保留 [Apache-2.0 许可证](LICENSE)、[NOTICE](NOTICE) 和第三方许可声明。
