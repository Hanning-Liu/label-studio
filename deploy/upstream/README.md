# 上游开发及可选部署文件

本目录收纳根目录原有的开发／测试 Dockerfile 和 Compose 扩展。当前 Hanning 定制版的 Mac 部署请使用 [从零部署指南](../MACOS-SETUP.md)。这些上游构建配方保留原语义，不作为定制版的已验收发布入口。

所有命令均从**仓库根目录**运行，Docker 构建上下文仍为 `.`。

| 文件 | 入口或用途 |
| --- | --- |
| `Dockerfile.development` | 原上游开发镜像：`docker build -f deploy/upstream/Dockerfile.development .` |
| `Dockerfile.testing` | 原上游测试镜像，`make build-testing-image` 已更新路径 |
| `Dockerfile.hgface` | 上游 Hugging Face 发布流程引用；工作流已更新路径 |
| `docker-compose.mysql.yml` | 根 Compose 的 MySQL 覆盖配置 |
| `docker-compose.minio.yml` | MinIO／Prometheus 示例；监控配置同目录 `prometheus/` |
| `docker-compose.override.example.yml` | `make docker-dev-override` 复制到根目录的本地覆盖配置 |

组合配置时，将根 `docker-compose.yml` 放在第一个 `-f`，保留相对于仓库根目录的构建和数据路径：

```sh
docker compose -f docker-compose.yml -f deploy/upstream/docker-compose.mysql.yml config
docker compose -f docker-compose.yml -f deploy/upstream/docker-compose.minio.yml config
```

单独运行 MinIO 示例时显式指定工作目录：

```sh
docker compose --project-directory . -f deploy/upstream/docker-compose.minio.yml config
```

示例中的数据库／MinIO 默认凭证是上游开发示例值，上线前需另行配置。根目录的 `Dockerfile` 和 `docker-compose.yml` 保留，以兼容现有 CI、Makefile 和 Dev Container。
