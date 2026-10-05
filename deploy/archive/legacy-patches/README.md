# 历史补丁镜像构建文件

这里归档 35 个基于 Label Studio 1.23.0 的阶段性补丁 Dockerfile；文件内容保持原样，用于历史追溯。它们依赖当时的基础镜像及预先构建的前端产物，不是当前 1.23.2 的构建入口。

当前定制版构建入口为仓库根目录下 `deploy/Dockerfile.l4-furniture-instances.qa`。根目录的官方 Dockerfile、开发和测试构建文件保留原位。

如需研究历史构建，从仓库根目录执行，仍以根目录作为构建上下文，例如：

```sh
docker build -f deploy/archive/legacy-patches/Dockerfile.room-v3 -t label-studio-legacy-review:local .
```

需要先取得匹配的历史基础镜像和前端产物；归档不代表这些旧镜像已经重新构建或验收。
