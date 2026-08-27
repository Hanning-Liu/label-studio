# 整室功能分区自动继承 v1

## 启用与使用

仅 FunctionZone 项目启用；普通项目默认关闭。参考 `function-zone-v3.xml`：

```xml
<Image name="image" value="$image"
  functionZoneV3Validate="true" wholeRoomZoneInheritance="true"
  functionZoneControls="zone_rectangle,zone_polygon" />
```

同时保留现有 Room v3 约束配置、Rectangle/Polygon 几何控件及配对的 `function_zone` Labels；增加 `Sanitary/general` 标签。它表示卫浴综合，不替换 Bathing/washing、Toilet 等细分类别。

画布上方的操作栏提供：

1. **为空房间生成整室分区**：预览本任务全部房间、建议类别、跳过原因。仅无任何分区的房间可选。先保存草稿、下载操作前恢复 JSON，再重新核对候选并一次性追加，最后保存草稿。可一次撤销；重复执行不会重复生成。
2. **待确认分区**：定位、修改功能类别、逐项或批量确认。生成本身不构成确认。修改几何/类别后重新待确认；父房间变化只提示复核，不静默重写。旧人工分区不追加确认要求。
3. **开始细分**：选择 Focus room；仅允许移除该房间内唯一、仍与房间轮廓一致且没有 Relations 的自动整室分区。先保存、下载备份，再明确确认。移除可撤销；保留 Focus room，手绘完成前也可保存草稿。不自动补余。
4. **保存草稿**：不运行正式提交校验。显示保存中、未保存、已保存或错误；失败后保留窗口并重试。
5. **导出恢复 JSON**：即使网络或保存失败也可下载当前全部结果。文件是 Label Studio task JSON，包含配对类别、只读参考、Vector、Relations 及额外恢复上下文。它是恢复材料，不会自动提交当前任务。导入到另一个项目时 annotations 会创建导入标注，继承的待确认元数据仍保留。

提交仍要求原有覆盖、互斥、父房间约束和 Vector 复核全部通过。批量确认功能分区不会确认 Vector，也不会提交任务。

## 数据约定

- Rectangle 原样复制百分比坐标、尺寸、旋转；Polygon 原样复制顶点。几何与类别共享新 ID，不复用房间 ID。
- `meta.partition_context` 使用当前 Room v3 参考重算父房间、开口和相邻房间。
- `meta.zone_inheritance` 仅存于几何结果：`schema_version`、`generation_method`、`source_room_id`、`source_room_type`、`source_reference_fingerprint`、`mapping_version`、`review_status`。
- 显式确认后记录 `reviewed_zone_fingerprint` 和 `reviewed_source_fingerprint`。界面及提交校验同时检查有效指纹；不只相信 status 字符串。
- 指纹组合几何和类别，比较时消除 1e-9 百分比单位以下的浮点噪声；实际保存坐标不量化、不做包围盒转换。
- 不改变 Label Studio 的 `origin` 语义，不扩展 GraphML。
- 类别映射集中在 `web/libs/editor/src/utils/wholeRoomInheritance.js`，版本为 1；映射外类别建议 Unclear/other，用户可改选任一配置内类别。

## 草稿版本保护

`PATCH/PUT /api/drafts/{id}/` 可选携带 `expected_updated_at`，值为加载或上次保存响应的 `updated_at`。不匹配返回 409、`code=draft_version_conflict` 和服务器版本；不更新结果。

新版客户端串行保存请求、保存成功后推进版本，提交前等待保存中的请求结束。提交被校验拒绝、取消、请求失败后均释放提交状态；正式成功前不丢弃草稿。

SQLite 通过事务内条件更新取得写锁；支持行锁的数据库沿用 ProjectSummary → AnnotationDraft 的锁顺序。未传版本的旧调用仍兼容，因此部署前必须保全旧窗口，再统一刷新。不要把 409 当作“直接覆盖服务器”的授权：先导出本地恢复 JSON，再比对两份结果。

## 测试与部署

编辑器测试覆盖纯映射、精确几何、导入恢复、跳过/防重、Portal 关联、确认失效、观察中的 UI 状态、撤销、Relations 保护，以及保存/提交失败。

测试入口：

- `utils/__tests__/wholeRoomInheritance.test.js`
- `tags/object/Image/__tests__/Image.wholeRoomInheritance.test.js`
- `components/ImageView/__tests__/WholeRoomInheritanceControls.test.jsx`
- `stores/__tests__/AppStore.test.js`
- 后端 `label_studio/tests/test_draft_revision.py`

构建前端后使用 `Dockerfile.room-v3` 打包；镜像同时包含前端及 `tasks/api.py`、`tasks/serializers.py`，不需要数据库迁移。先使用独立数据库副本验收，再启用生产项目。此版本不提供房间参考的实时跨窗口同步。

自定义镜像还包含前端缓存保护：入口资源版本由实际构建文件内容计算，生产异步 JS/CSS 文件名带内容哈希。避免沿用基础镜像的后端版本号，导致普通刷新仍混用新旧前端文件。更换构建后需重启服务以更新入口版本缓存。

生产 Task20 只执行生成、保存、刷新、防重及完整结果比对；不做删除/细分测试，也不代用户确认语义。
