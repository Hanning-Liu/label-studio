# macOS 从零部署 Hanning Label Studio 1.23.2

适用：一台尚未安装本项目的 Mac，在本机使用 L1–L4 定制标注工具。默认 Docker + SQLite，仅在 `localhost:18085` 提供访问，app、参考同步 worker 和 gateway 使用同一镜像。

当前完整定制代码在 **`feature/l1-sticky-toolbar` 分支**，不要直接克隆默认分支后套用本指南。它包含 L1 顶部工具区、几何问题定位和 Polygon 正交化。官方 `heartexlabs/label-studio:latest` 不包含这些功能。本指南不要求复制旧电脑源码目录、安装主机 Node/Python/Poetry，或取得旧的补丁镜像。

## 1. 安装 Git 和 Docker Desktop

1. 打开 macOS「终端」，运行 `xcode-select --install`，按系统提示安装 Command Line Tools；已安装时不用重复。运行 `git --version` 确认 Git 可用。
2. 从 [Docker 官方 Mac 安装页](https://docs.docker.com/desktop/setup/install/mac-install/)下载与芯片匹配的 Docker Desktop：Apple Silicon（M 系列）或 Intel。安装到「应用程序」并打开，完成首次设置，等待引擎启动。支持的 macOS 版本以官方页面为准。
3. 重新打开终端并检查：

```sh
git --version
docker version
docker compose version
docker buildx version
docker info --format '{{.OSType}}/{{.Architecture}}'
```

`docker version` 应同时显示 Client 和 Server。使用带 `--wait` 支持的 Compose v2；更新 Docker Desktop 可一并更新 Compose。Docker 是 Linux 容器引擎，Apple Silicon 常显示 `linux/aarch64`，Intel 为 `linux/x86_64`。

源码构建较占资源，建议给 Docker 8 GB 内存并预留约 30 GB 可用磁盘，这是本项目构建预算建议，不是 Docker 官方最低要求。首次构建需要下载基础镜像、系统包、npm 和 Python 依赖；网络应能访问 Docker Hub、Debian、npm/Yarn 和 PyPI。

## 2. 获取源码，建立独立运行目录

以下命令按顺序在同一个终端执行。示例统一放在个人目录，不含任何旧电脑用户名或 Research 路径。

```sh
mkdir -p "$HOME/label-studio-project"
cd "$HOME/label-studio-project"
git clone --branch feature/l1-sticky-toolbar --single-branch \
  https://github.com/Hanning-Liu/label-studio.git source
cd source
./deploy/macos.sh init
```

如果仓库要求登录，使用拥有仓库访问权限的 GitHub 账号完成 Git 认证。保留真正的 Git checkout 和 `.git`，不要用下载 ZIP 替代；构建过程需要读取版本信息。

目录结构：

```text
~/label-studio-project/
├── source/                 # Git 源码，可更新
└── runtime/                # 本机私有文件，不提交 Git
    ├── macos.env           # 镜像、端口和媒体配置
    ├── media/              # 可选：本地图片，只读挂载
    └── backups/            # 备份
```

`init` 自动以当前提交的短 SHA 设置镜像标签，配置文件权限为 600；重复执行不会覆盖已有配置。`macos.sh` 根据自身位置找源码，默认使用相邻的 `runtime`，不依赖终端的当前目录。

如需其他运行目录，在每个使用本工具的终端中先设置绝对路径，例如 `export HANNING_MAC_RUNTIME_DIR="$HOME/My Labels/runtime"`。空格路径受支持。已有本机 QA 的 `l1-qa.env` 不会被读取或改写。

## 3. 从源码构建定制镜像

```sh
cd "$HOME/label-studio-project/source"
case "$(docker info --format '{{.Architecture}}')" in
  arm64|aarch64) MAC_PLATFORM=linux/arm64 ;;
  amd64|x86_64) MAC_PLATFORM=linux/amd64 ;;
  *) echo '不支持的 Docker 架构'; exit 1 ;;
esac
MAC_IMAGE=$(./deploy/macos.sh config --images | sort -u)
MAC_SOURCE_SHA=$(git rev-parse HEAD)

docker buildx build --load --platform "$MAC_PLATFORM" \
  -f deploy/Dockerfile.l4-furniture-instances.qa \
  --build-arg VERSION_OVERRIDE=1.23.2 \
  --build-arg BRANCH_OVERRIDE=feature/l1-sticky-toolbar \
  --label "org.opencontainers.image.revision=$MAC_SOURCE_SHA" \
  -t "$MAC_IMAGE" .

docker image inspect "$MAC_IMAGE" \
  --format 'Image={{.Id}} Platform={{.Os}}/{{.Architecture}} Source={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

最后一个 `.` 是源码根目录的构建上下文，不能改成 `deploy/`。不要运行根目录通用 Dockerfile 或 `deploy/archive/legacy-patches/` 中的历史补丁构建文件。

该构建文件虽保留 `.qa` 历史命名，但会从源码完整构建前端和后端，包含 `hanning` 包，使用 Node 22、Python 3.13、Poetry 2.3.2 和已提交锁文件。无需 `poetry lock` 或另装主机依赖。已有本机 Apple Silicon 完整构建记录；Intel 平台命令已提供，尚无 Intel 实机验收记录。

构建成功后把上述镜像 ID、完整源码 SHA 和平台保存到 `runtime`，便于日后复现。提交 SHA 固定源码，但基础镜像标签和系统包仍可能更新；需要保存完全相同的产物时导出镜像，见第 7 节。

## 4. 启动并首次登录

```sh
./deploy/macos.sh config --quiet
./deploy/macos.sh up -d --wait --wait-timeout 180
./deploy/macos.sh ps
curl --noproxy localhost,127.0.0.1 --fail http://localhost:18085/health/
open http://localhost:18085
```

成功标准：`app`、`worker`、`gateway` 三项均为 `healthy`，健康地址返回 HTTP 200。首次启动会创建 SQLite 数据库并执行迁移；没有旧数据库也能启动。

在浏览器注册自己的邮箱和密码，然后登录。没有预设共享账号或默认密码。注册仅用于本地实例，不要求邮件服务。首次登录应是空项目列表，旧电脑的数据不会随 GitHub 源码自动带过来。

端口占用时，编辑 `../runtime/macos.env`，把 `HANNING_QA_PORT` 和 `HANNING_QA_HOST` 中的端口一起改为例如 `18086`，重新执行 `up -d --wait`，浏览器也使用新地址。

此入口复用 `compose.hanning-1232.qa.yml`，变量保留 `HANNING_QA_` 前缀；实际 Compose 项目名固定为 `hanning-macos`，数据卷为 **`hanning-macos_data`**。它与旧电脑的 `hanning-1232-qa` 环境隔离。容器只有 gateway 暴露回环端口，app/worker 的网络不允许对外连接；本指南面向本机图片标注，外部图片网址、Webhook、ML 服务不能直接按联网部署使用。SSRF 和本地 ML 地址防护保持开启。

## 5. 创建第一个房间与窗项目

1. 点击 **Create**，选择 **L1 房间、门与窗**，输入项目名，例如「L1 房间与窗」。
2. 点击 **创建 L1 项目**。系统自动配置房间、门通道与窗模板，不需要粘贴 XML。原来的自定义模板入口保留在 **普通项目 / 自定义模板** 中。
3. 使用 **Import** 上传自己的 `floorplan.png`，进入任务。默认读取数据字段 `image`。
4. 顶部选择「房间」及类型，右侧选择 Rectangle 或 Polygon，完成一个合法房间后提交，刷新并重新打开，检查形状和类型仍存在。
5. 门不能侵入房间净空间；窗需沿房间边界。若提交被几何规则阻止，根据定位提示修正后再提交。Polygon 需要正交化时，选中该区域，使用右侧区域属性中的「正交化（横平竖直）」按钮。

第一次部署优先用直接上传图片验证。上传图片与数据库都保存在命名卷中。可选的本地图片需要额外建立项目存储权限：

1. 把图片放入 `runtime/media/floorplans/` 子目录。
2. 进入项目 **Settings → Cloud Storage → Add Source Storage → Local Files**，绝对路径填写容器路径 `/label-studio/data/local-files/floorplans`，而非 Mac 的 `/Users/...`。路径必须是文档根目录的子目录。
3. 使用 Files 导入方式并 Sync 创建图片任务，或手动导入引用 `/data/local-files/?d=floorplans/文件名.png` 的任务 JSON；带子目录时保留相对路径，中文、空格等应 URL 编码。

1.23.2 会检查所属项目的 Local Files 存储权限，只有挂载和 URL、没有 Source Storage 时图片会返回 404。这是访问规则，不应通过关闭防护绕过。本机媒体是只读挂载，可作为 Source Storage，不可作为写出标注的 Target Storage。

### 从同一张图片继续创建 L2–L4

1. 在 L1 图片任务中点击 **Submit / Update**，确保修改已正式提交。
2. 回到项目列表，点击 **Create → L2 功能分区**。
3. 选择刚才的 L1 项目和图片，填写新项目名，点击 **创建 L2 项目**。只有一个可用项目及一张图片时会自动选中。
4. 系统引用原图片、导入只读参考并建立同步绑定；进入新项目后完成 L2 标注并提交。
5. 再通过 **Create → L3** 选择该 L2 图片；完成并提交 L3 后，通过 **Create → L4** 选择该 L3 图片。

每次创建只带入选中的一张图片。缺少唯一有效正式标注、来源过期或来源链校验失败时，界面显示原因并阻止创建；草稿不能替代正式标注。上游选择后再次修改时，点击“刷新来源”后重新选择。不会自动完成下游人工标注，也不会改动上游结果。图片仍引用上游文件，请保留上游项目及媒体。

L2 的参考更新沿用自动同步，L3/L4 沿用人工检查与应用。继续参考 [层级标注](../docs/l4-hierarchical-annotation.md)、[参考同步](README.l3-reference-sync.md)、[L4 创建](README.l4-furniture-instances.md#create-an-l4-project-explicitly)及[窗参考链](L1-L4-window-lineage.md)。管理命令仍可用于批量维护；旧指南中的固定容器名，在本入口下改用：

```sh
./deploy/macos.sh exec app python /label-studio/label_studio/manage.py COMMAND --help
```

其中 `COMMAND` 换成相应管理命令；不要直接复制旧 Windows 路径或历史容器名。

## 6. 日常启动、停止与排错

重启电脑后先打开 Docker Desktop，再运行：

```sh
cd "$HOME/label-studio-project/source"
./deploy/macos.sh up -d --wait
./deploy/macos.sh ps
./deploy/macos.sh logs --tail 100 app worker gateway
```

停止服务并保留数据：

```sh
./deploy/macos.sh stop worker gateway
./deploy/macos.sh stop app
```

| 现象 | 处理 |
| --- | --- |
| Cannot connect to the Docker daemon | 打开 Docker Desktop，等待引擎就绪，再检查 `docker version` 的 Server 部分 |
| docker: command not found | 完成 Docker Desktop 的 CLI 安装设置，重新打开终端 |
| 镜像不存在 / pull access denied | 先完成第 3 节构建，核对 `config --images` 的标签是否与本地镜像一致 |
| exec format error | 镜像平台不匹配；按 Docker 引擎架构重新构建，跨 Intel/Apple Silicon 不直接复用单架构镜像 |
| 构建下载超时 | 检查 Docker Desktop 代理及网络；恢复网络后重试，缓存会复用，不要删除锁文件或关闭安全防护 |
| 构建内存不足 / exit 137 | 增加 Docker 内存和磁盘配额，关闭其他重负载进程后重试 |
| Mounts denied / 图片文件找不到 | 核对 `runtime/media` 存在及 Docker Desktop 文件共享权限，再执行 `up -d --wait` |
| localhost 返回代理 502 | 给系统／浏览器代理配置 localhost 和 127.0.0.1 绕过；命令行用 `curl --noproxy localhost,127.0.0.1` 检查 |
| 启动超时 / worker unhealthy | 查看上述日志；确认 app 已完成迁移、三项服务镜像一致，再重试 `up -d --wait` |
| 页面出现的是普通官方版 | 核对源码分支、定制 Dockerfile、镜像标签和项目 XML；强制刷新浏览器 |
| 项目突然为空 | 先检查 Compose 项目名和卷名是否改变，不要导入旧数据库覆盖当前卷 |

命名卷不会因普通 `stop`、容器重建或源码更新而丢失。不要运行 `down -v`、删除 `hanning-macos_data`，或把清空 Docker Desktop 数据当作排错步骤。

## 7. 完整备份与搬到另一台 Mac

仅导出任务 JSON 不能完整保存账户、草稿、项目配置和上传图片。备份整个数据卷，加上 `runtime/media`、私有配置及镜像记录。以下命令使用默认目录和项目名；如改过 `HANNING_MAC_RUNTIME_DIR` / `HANNING_MAC_PROJECT`，同步使用实际路径和项目名。

先保存浏览器正在编辑的内容，停止服务，备份期间不要继续标注：

```sh
cd "$HOME/label-studio-project/source"
MAC_RUNTIME=${HANNING_MAC_RUNTIME_DIR:-"$HOME/label-studio-project/runtime"}
MAC_PROJECT=${HANNING_MAC_PROJECT:-hanning-macos}
MAC_IMAGE=$(./deploy/macos.sh config --images | sort -u)
MAC_BACKUP="$MAC_RUNTIME/backups/$(date +%Y%m%d-%H%M%S)"
set -o pipefail
umask 077
mkdir -p "$MAC_BACKUP"
./deploy/macos.sh stop worker gateway
./deploy/macos.sh stop app

docker run --rm --user 0 --entrypoint tar \
  --mount "type=volume,source=${MAC_PROJECT}_data,target=/data,readonly" \
  "$MAC_IMAGE" -C /data -czf - . > "$MAC_BACKUP/data.tar.gz"

tar -czf "$MAC_BACKUP/local-media.tar.gz" -C "$MAC_RUNTIME/media" .
cp "$MAC_RUNTIME/macos.env" "$MAC_BACKUP/macos.env"
git rev-parse HEAD > "$MAC_BACKUP/source-sha.txt"
docker image inspect "$MAC_IMAGE" > "$MAC_BACKUP/image-inspect.json"
docker image save "$MAC_IMAGE" | gzip > "$MAC_BACKUP/image.tar.gz"
(cd "$MAC_BACKUP" && shasum -a 256 data.tar.gz local-media.tar.gz image.tar.gz macos.env source-sha.txt image-inspect.json > SHA256SUMS)
tar -tzf "$MAC_BACKUP/data.tar.gz" > "$MAC_BACKUP/contents.txt"
head "$MAC_BACKUP/contents.txt"
./deploy/macos.sh up -d --wait
```

每条命令应成功后再执行下一条；失败时保留现有数据卷，不将不完整压缩包当作可恢复备份。备份含账户、数据库和密钥，应保存在私有存储中。

在另一台 Mac 安装 Docker 并获取源码后，先完成 `init`，**在首次启动 app 之前**恢复到空卷。将备份目录复制到新电脑；在下面 `MAC_BACKUP` 中填写其实际位置。下面完整命令适用于相同架构，可以导入镜像而不重建。跨架构时跳过 `gunzip ... docker image load`，复制 env 后先执行 `git checkout "$(cat "$MAC_BACKUP/source-sha.txt")"`，按第 3 节为本机架构构建镜像，再执行创建卷及恢复步骤。

```sh
cd "$HOME/label-studio-project/source"
MAC_BACKUP="$HOME/Downloads/label-studio-backup"  # 改成实际备份目录
MAC_RUNTIME=${HANNING_MAC_RUNTIME_DIR:-"$HOME/label-studio-project/runtime"}
MAC_PROJECT=${HANNING_MAC_PROJECT:-hanning-macos}
set -o pipefail
(cd "$MAC_BACKUP" && shasum -a 256 -c SHA256SUMS)
gunzip -c "$MAC_BACKUP/image.tar.gz" | docker image load
cp "$MAC_BACKUP/macos.env" "$MAC_RUNTIME/macos.env"
chmod 600 "$MAC_RUNTIME/macos.env"
MAC_IMAGE=$(./deploy/macos.sh config --images | sort -u)
docker volume create --label "com.docker.compose.project=$MAC_PROJECT" \
  --label com.docker.compose.volume=data "${MAC_PROJECT}_data"

docker run --rm -i --user 0 --entrypoint sh \
  --mount "type=volume,source=${MAC_PROJECT}_data,target=/restore" \
  "$MAC_IMAGE" -c 'test -z "$(ls -A /restore)" && tar -xzf - -C /restore' \
  < "$MAC_BACKUP/data.tar.gz"
tar -xzf "$MAC_BACKUP/local-media.tar.gz" -C "$MAC_RUNTIME/media"

docker run --rm --entrypoint python \
  --mount "type=volume,source=${MAC_PROJECT}_data,target=/label-studio/data" \
  "$MAC_IMAGE" -c 'import sqlite3; c=sqlite3.connect("file:/label-studio/data/label_studio.sqlite3?mode=ro", uri=True); r=c.execute("PRAGMA integrity_check").fetchone()[0]; print(r); assert r == "ok"'
./deploy/macos.sh up -d --wait
```

恢复命令遇到非空卷会失败，此时先辨认卷内是否已有新标注，不能清空后强行覆盖。若 env 中曾手动写入旧电脑媒体的绝对路径，改回新路径；默认的 `${HANNING_MAC_RUNTIME_DIR}/media` 会自动适配。登录使用原账号，核对项目数、任务、正式标注、草稿和图片，确认后再开始工作。

数据卷备份与恢复采用 Docker 的[命名卷备份方式](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes)。恢复旧备份是迁机/灾难恢复流程，**不是日常版本回滚**。

## 8. 后续升级和版本回滚

升级前执行第 7 节备份，保存旧镜像标签/ID。保持当前源码无未提交修改，再执行：

```sh
git switch feature/l1-sticky-toolbar
git pull --ff-only origin feature/l1-sticky-toolbar
git rev-parse HEAD
```

为新提交在 `runtime/macos.env` 设置新的 `HANNING_QA_IMAGE`（例如 `hanning-label-studio:1.23.2-新提交的12位SHA`），重新执行第 3 节构建；不要覆写旧镜像标签。先在独立运行目录、项目名和空闲端口中恢复备份并验收，确认兼容后再暂停正式标注、备份最新数据、更新本机服务：

```sh
./deploy/macos.sh stop worker gateway
./deploy/macos.sh stop app
./deploy/macos.sh up -d --wait app gateway
# 登录检查图片、已有标注、保存和重开均正常后，再启动 worker。
./deploy/macos.sh up -d --wait worker
```

可用 `HANNING_MAC_RUNTIME_DIR` 和 `HANNING_MAC_PROJECT` 设置隔离验收环境；复制 env 后修改端口及 HOST，始终使用对应的 `${HANNING_MAC_PROJECT}_data` 卷。默认项目名、端口和数据卷在日常使用中保持固定。

若新版本有问题且已验证旧镜像能读取升级后数据，将 env 中镜像标签改回记录的旧值，按同样顺序启动。保留当前数据卷，避免丢失升级后新增标注。如果旧镜像与新数据不兼容，应停止切换并排查，不能靠覆盖旧数据库回滚。

## 验证范围

验证结果记录在 [Mac 部署验收](MACOS-SETUP-VERIFICATION.md)。本指南针对本机离线图片标注；公网访问、多人服务器、PostgreSQL、外部 ML/Webhook 需要另行配置和验收。现有 Windows 生产迁移仍按 [运行与上线指南](Hanning-runtime.md)处理。
