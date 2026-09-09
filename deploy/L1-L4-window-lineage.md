# L1—L4 窗参考一致性

每套户型的窗集合以明确绑定的 L1 正式标注为准。L1 有窗时，L2、L3、L4 必须完整继承其 ID、几何及权威上下文；L1 正式标注确实无窗时允许空集合，不要求每个房间都有窗。缺失、取消、多候选、替换来源、图片变化或任一上游版本过期，均不能解释为无窗。

创建和提交 L2/L3/L4 只要求其上游各层正式标注就绪；当前层使用待提交结果校验，无须预先存在正式标注。完整研究数据包则要求四层有效正式标注。草稿可以保存和备份，但不代表完成。

## 界面与恢复

现有参考状态接口增加只读 `lineage`，包括根来源、每层身份、窗数量、问题任务和窗 ID、内容版本。版本包含整条来源链；直接 L3 版本未变化时，L1 变化仍会暂停 L4 复核。暂停不会批量改写实例复核状态，也不会自动提交或替换当前窗口。

按提示中的明确任务链接，从最早出错的层级开始处理。L2 保留原同步方式；L3、L4 仍需保存、备份、手动应用参考，再完成原有复核和正式提交。修复期间的草稿不会被计为完整数据。

旧正式标注可能窗线齐全但投影过期。此时需在该层按现有流程重新提交以更新派生投影，再逐级应用；校验不会伪造投影或自动修复运行中的标注。

## 只读审计和快照

在运行新代码的隔离容器执行，输出目录必须尚不存在：

```powershell
docker exec label-studio-window-lineage-qa-app python /label-studio/label_studio/manage.py audit_floorplan_lineage --task-id 23 --output /audit/accepted-evidence
```

不传 `--output` 时仅打印报告。退出码非零表示未通过完整验收，诊断报告不能用于发布。明确关联的四层标注、配置、绑定和已应用参考在同一读取事务中采集。SQLite 使用读取快照，PostgreSQL 使用可重复读取的只读事务。

导出包含 `L1.json`—`L4.json`、`lineage-manifest.json`、报告、标准任务导出和配置（`raw/`）。已有草稿单独保存在 `drafts-backup.json` 及其 SHA-256 文件中。草稿不参与正式验收。快照只保存在本地，不提交研究数据、凭证或数据库到 Git。

## 条件配置升级

有窗来源必须有兼容的 `window_vector` 控件。无窗来源继续允许旧配置。混合项目的配置须能承接有窗任务；每项任务仍按自己的 L1 判断。

```powershell
docker exec label-studio-window-lineage-qa-app python /label-studio/label_studio/manage.py upgrade_window_reference_controls --project-id 13 --l1-task-id 19 --dry-run
docker exec label-studio-window-lineage-qa-app python /label-studio/label_studio/manage.py upgrade_window_reference_controls --project-id 13 --l1-task-id 19 --apply --expected-title "实际项目标题" --expected-config-sha256 "预览中的原配置SHA256" --expected-source-version "预览中的来源版本"
```

先审查差异并备份，再显式应用。命令只插入缺少的窗控件，保留原 XML 字节、布局、属性和控件顺序；已存在时无修改。重名控件、标签别名冲突、类型不匹配以及配置/来源并发变化均拒绝写入，不自动建立来源绑定。

## 完整 L4 聚合

CLI 现在必须提供来源清单；旧的纯转换 Python 函数和历史文件读取/重新导入接口保留，但不替代完整发布验收。下面的 `base-v4.json` 必须来自同一快照的 L1—L3 标准任务导出。可以继续使用现有构建管线，独立 Viewer 无需修改。

```powershell
python scripts/furniture_instances_to_unified.py --base base-v4.json --annotation accepted-evidence/L4.json --project-id 13 --task-id 23 --annotation-id 13 --lineage-manifest accepted-evidence/lineage-manifest.json --output complete-v4.json
```

命令重新校验文件 SHA-256、四层身份/内容、正式标注状态、来源绑定/版本，以及基础包的 `sources`、`raw_inputs` 和窗集合。窗投影从对应正式 L2/L3 几何重新计算比较，不能只修改报告中的通过标志。失败不会生成或替换输出文件。

基础包的图节点可以使用自己的 ID；聚合器通过明确的 `result_id` 或家具组团 `context.group_id` 核对来源，不猜测前缀，也不改写标注中的父级 ID。只为投影区间与测量长度接受绝对误差不超过 `1e-9` 的浮点舍入；身份、指纹、原始几何和策略仍精确比较。父组团边界检查使用既有几何面积 epsilon，避免把约 `1e-13` 的浮点碎片当作越界。

继续使用 `floorplan-unified/4`；无窗户型使用空窗集合。没有数据库迁移、新 HTTP 路径或持久化状态枚举，也没有 L4 家具窗投影算法。旧客户端可读取数据，但无法显示新来源提示；后端仍会拒绝不完整的正式提交。

## 发布与运行环境

本轮从 `dd40a0dc3838610639d5b168d1fbd488e003689b` 开发，在独立 QA 副本验证后更新修复分支和稳定集成分支，并新增附注稳定标签。原 `l1-l4-stable-20260909` 保留。

本轮不升级 18086，也不改变 18082/18085 等现有服务。18086 保留 `label-studio-window-l4:parent-86fd30146`。后续部署需独立交接和备份；代码撤销使用新的 revert 提交，不改写发布历史、不用旧数据库覆盖后续标注。
