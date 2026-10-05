# macOS 部署指南验收

日期：2026-10-05。对应 [macOS 从零部署指南](MACOS-SETUP.md)。

## 已验证

- `macos.sh init` 创建仓库外配置、媒体和备份目录，env 权限为 600，镜像标签包含源码 SHA；重复执行保留已有配置。
- 运行目录名称含空格时，Compose 配置解析与媒体挂载正常。
- 指南的 shell 代码块通过 macOS zsh 语法检查；入口脚本通过 `sh -n`，`git diff --check` 通过。
- Docker Buildx `--check` 使用指南中的 Dockerfile、1.23.2 版本参数及功能分支参数完成检查，无警告。
- 使用新 Compose 项目 `hanning-macos-doccheck-20261005`、空数据卷、独立端口 18089，首次 SQLite 初始化成功，app/worker/gateway 全部健康。
- 通过 HTTP 完成首次账号注册、加载房间与窗 XML 模板、上传平面图、保存 1 条正式标注及 1 条草稿、回读结果。上传图片 SHA-256 与输入文件一致。
- 验证重启后会话和数据保留。创建 Local Files Source Storage 后，可读取媒体子目录图片；缺少来源存储时访问返回 404，已在指南中解释并给出配置步骤。
- 按指南停止测试服务、打包完整数据卷和本地媒体；恢复到第二个空卷 `hanning-macos-restorecheck-20261005_data`，SQLite `integrity_check` 返回 `ok`。
- 恢复实例使用独立端口 18090，三个服务均健康。原账号会话、正式标注、草稿、上传图片和本地媒体均通过 HTTP 回读。
- 恢复前后 project、task、task_completion、tasks_annotationdraft、io_storages_localfilesimportstorage 五张表完整内容一致，各 1 行；恢复命令会拒绝覆盖非空卷。

## 验证边界

本次在已有 Docker Desktop 的 Apple Silicon Mac 上验证空数据卷部署和迁机恢复，使用已完成源码构建及此前功能验收的 `hanning-label-studio:1.23.2-l1-9d2ac5b1` 镜像，ID 为 `sha256:c041c0d33d986eb318646bec571e9bcc94f8369cdaf3378b172164e8f6022da5`，平台 `linux/arm64`。本次文档与 shell 入口改动不改变应用运行代码。

本次没有在一台全新实体 Mac 上安装 Docker，没有重新执行无缓存完整镜像构建，也没有 Intel 实机验收；Buildx `--check` 不能替代实际构建。镜像 save/load 的通用命令列入指南，本次恢复演练使用已有本机镜像，没有再导出／导入完整镜像压缩包。

HTTP 验证覆盖后端与图片访问，不宣称本次新增了 Chrome 界面交互验收。现有 L1 操作与正交化的独立验收见相应功能报告。

测试未操作当前 `hanning-1232-qa` 的数据卷或部署配置。原始测试摘要、五表比较和恢复压缩包保存在仓库外运行目录，不向 Git 提交账号会话、用户图片或数据库。

验收结束后已移除本次临时容器、网络及两个测试卷，备份和比较记录保留在私有运行目录。原 `hanning-1232-qa` 三个服务仍健康。
