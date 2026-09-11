# L4 家具类别与 IFC 4.3.2.0 对照

本表区分类别含义、界面分组和 IFC 映射；映射为研究对照，不写入标注结果，也不生成 IFC 文件。稳定英文值不可重命名。颜色表达界面分类，不表示家具 MainColour；不得从二维配色推断 IsBuiltIn。

| 稳定标识 | 中文名 | 定义与别称 | 易混淆类别 | IFC 候选实体 / 类型 | 映射条件 |
|---|---|---|---|---|---|
| `bed` | 床 | 用于睡眠的床体。 别称：床铺 | `sofa` | IfcFurniture / BED | 直接对应 |
| `bedside_table` | 床头柜 | 床旁放置日用品的独立小柜。 别称：床边柜 | `cabinet` | IfcFurniture / USERDEFINED | 项目约定；保留 bedside_table 语义 |
| `wardrobe` | 衣柜 | 用于悬挂或收纳衣物的柜体。 别称：衣橱 | `cabinet`、`dressing_table` | IfcFurniture / USERDEFINED | 项目约定；不把整个衣帽间作为单件衣柜 |
| `dressing_table` | 梳妆台 | 用于梳妆的家具台体；镜面与衣柜不能代替台体。 别称：梳妆桌、化妆台 | `desk`、`wardrobe` | IfcFurniture / DESK / USERDEFINED | 单人台面满足 DESK 定义时可映射；否则 USERDEFINED；始终保留研究类别 |
| `desk` | 书桌 | 用于书写、阅读或办公的工作台。 别称：写字台、办公桌 | `dressing_table`、`bar_counter` | IfcFurniture / DESK | 单人工作台符合定义；多人工作台需另核对 |
| `office_chair` | 办公椅 | 用于桌前办公或学习的单人座椅。 别称：工作椅 | `dining_chair`、`armchair` | IfcFurniture / CHAIR | 直接对应座椅；办公用途为研究细分 |
| `sofa` | 沙发 | 可供多人就座的软座家具。 别称：长沙发 | `armchair`、`bed` | IfcFurniture / SOFA | 多人座具；单人软椅归 armchair |
| `armchair` | 扶手椅 | 带扶手的单人休闲座椅。 别称：单人沙发、休闲椅 | `sofa`、`office_chair` | IfcFurniture / CHAIR | 单人座具；保留扶手椅细分 |
| `coffee_table` | 茶几 | 会客座位旁或前方放置饮品、杂物的矮桌。 别称：咖啡桌 | `dining_table`、`bedside_table` | IfcFurniture / TABLE / USERDEFINED | 多人使用桌面满足 TABLE；独立边几需核对 |
| `dining_table` | 餐桌 | 以就餐为主要用途的桌体。 别称：饭桌 | `bar_counter`、`desk` | IfcFurniture / TABLE | 多人餐桌符合定义 |
| `dining_chair` | 餐椅 | 配合餐桌使用的单人椅。 别称：饭椅 | `office_chair`、`armchair` | IfcFurniture / CHAIR | 直接对应；用途为研究细分 |
| `bar_counter` | 吧台/餐吧台 | 用于饮用、简餐或就座交流的台体；备餐橱柜另标。 别称：餐吧、吧桌 | `kitchen_cabinet`、`dining_table`、`desk` | IfcFurniture / TABLE / USERDEFINED | 多人台面满足 TABLE 时可映射；固定服务吧台需证据，不自动映射 WORKSURFACE |
| `cabinet` | 柜体 | 无法归入专用柜类的收纳柜体。 别称：储物柜、收纳柜 | `wardrobe`、`kitchen_cabinet`、`shoe_cabinet` | IfcFurniture / USERDEFINED | 项目约定；不默认 FILECABINET 或 TECHNICALCABINET |
| `bookshelf` | 书架 | 用于存放书籍或展示物品的层架。 别称：书柜、置物架 | `cabinet` | IfcFurniture / SHELF | 符合层架定义；保留研究细分 |
| `tv_stand` | 电视柜 | 承托电视及附属设备的柜体。 别称：地柜 | `television`、`cabinet` | IfcFurniture / USERDEFINED / TECHNICALCABINET | 默认项目约定；技术设备柜结构与用途有证据时才选 TECHNICALCABINET |
| `television` | 电视 | 用于显示视听内容的电视设备。 别称：电视机 | `tv_stand` | IfcAudioVisualAppliance / DISPLAY | 直接对应显示设备 |
| `refrigerator` | 冰箱 | 用于低温储存食物的冷藏设备。 别称：电冰箱 | `cabinet` | IfcElectricAppliance / REFRIGERATOR / FRIDGE_FREEZER | 需区分纯冷藏与冷冻冷藏组合；图中不足以判定时保留候选 |
| `stove` | 灶具 | 用于烹饪的灶面或炉灶设备。 别称：灶台、炉灶 | `kitchen_cabinet` | IfcElectricAppliance（条件性） / ELECTRICCOOKER | 仅有电烹饪证据时使用；燃气或能源未知时不强制映射电器 |
| `kitchen_cabinet` | 橱柜 | 厨房备餐或收纳柜体，可包含其工作台面轮廓。 别称：厨柜、备餐台 | `bar_counter`、`cabinet`、`sink` | IfcFurniture / USERDEFINED | 项目约定；不把任意厨房台面作为系统家具 WORKSURFACE |
| `sink` | 水槽 | 接收厨房等清洗用水的槽体。 别称：洗菜盆、洗涤槽 | `washbasin`、`kitchen_cabinet` | IfcSanitaryTerminal / SINK | 直接对应；与柜体分别标注，允许二维重叠 |
| `toilet` | 坐便器 | 用于排泄的坐便器主体。 别称：马桶 | `cabinet` | IfcSanitaryTerminal / TOILETPAN | 对应便器主体；不使用已弃用的 WCSEAT |
| `washbasin` | 洗手盆 | 用于洗手、洗脸等个人清洁的盆体。 别称：洗脸盆、面盆 | `sink`、`cabinet` | IfcSanitaryTerminal / WASHHANDBASIN | 直接对应；柜体可另标 |
| `bathtub` | 浴缸 | 可容纳人体浸浴的缸体。 别称：浴盆 | `shower` | IfcSanitaryTerminal / BATH | 直接对应 |
| `shower` | 淋浴设施 | 可识别的淋浴装置或其设施轮廓。 别称：淋浴、花洒设施 | `bathtub` | IfcSanitaryTerminal / SHOWER | 需要设施证据；仅淋浴空间或隔断不能直接当作卫生终端实体 |
| `washing_machine` | 洗衣机 | 用于洗涤衣物的设备。 别称：洗衣设备 | `dryer` | IfcElectricAppliance / WASHINGMACHINE | 直接对应；洗烘一体需补充设备能力证据 |
| `dryer` | 烘干机 | 用于干燥衣物的设备。 别称：干衣机 | `washing_machine` | IfcElectricAppliance / TUMBLEDRYER（条件性） | 仅滚筒式干衣设备直接对应；其他形式需核对 |
| `shoe_cabinet` | 鞋柜 | 用于收纳鞋类的柜体。 别称：鞋橱 | `cabinet`、`wardrobe` | IfcFurniture / USERDEFINED | 项目约定；保留专用类别 |
| `other` | 其他 | 已辨识为家具或设施但当前类别表无法覆盖的对象。 别称：其他家具 | `cabinet` | 待确定 / 待确定 | 需要人工说明与证据；不将未知对象自动伪造成 IFC 实体 |
| `potted_plant` | 绿植盆栽 | 带种植容器的独立绿植，沿图中可辨认的盆栽整体平面轮廓标注；不包括成片种植区、花坛或单独空花盆。别称：盆栽、盆栽绿植、室内绿植 | `other` | 暂不指定 | 本项目新增语义类别；IFC 映射待额外证据确认，本轮仅用于标注与聚合 |

## 官方依据

- [家具枚举](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcFurnitureTypeEnum.htm)：DESK 为单人台面家具，TABLE 为多人台面家具。USERDEFINED 是项目映射约定，不表示 IFC 已定义同名研究类别。
- [系统家具构件](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcSystemFurnitureElementTypeEnum.htm)：WORKSURFACE 限工作站台面，不能套用于任意厨房台面。
- [卫生终端枚举](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcSanitaryTerminalTypeEnum.htm)
- [电器枚举](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcElectricApplianceTypeEnum.htm)
- [视听设备枚举](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcAudioVisualApplianceTypeEnum.htm)
- [家具属性集](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/Pset_FurnitureTypeCommon.htm)

## 类别升级与人工改类

新模板包含 29 类，绿植盆栽追加在现有“其他”分组末尾，沿用该组颜色。旧项目先执行 `manage.py upgrade_furniture_instance_choices --project-id ID --dry-run`，审查配置差异并备份；再加 `--apply --expected-title TITLE --expected-config-sha256 HASH`。命令仅追加缺少的梳妆台、吧台和绿植盆栽，不重建模板、不更改标注。原有 28 类项目只会增加绿植盆栽；已存在相同选项时无操作；冲突必须人工处理。

待绘制按钮只影响下一次创建。选中现有实例后使用“当前实例类别 → 应用类别”，统一修改所有分块和方向证据上下文，保留几何和来源，重新进行人工复核。绝不根据所在房间自动重分类 desk。

使用绿植盆栽后，回退镜像也必须支持 `potted_plant`（29 类），并保留新增选项及标注。仅含梳妆台、吧台等旧 28 类结果时，可以回退到支持对应类别的版本；不得恢复不支持已保存类别的镜像。
