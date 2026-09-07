"""L4 furniture-instance validation and manual L3 reference synchronization."""

FURNITURE_TYPE_CHOICES = (
    ('bed', '床'),
    ('bedside_table', '床头柜'),
    ('wardrobe', '衣柜'),
    ('desk', '书桌'),
    ('office_chair', '办公椅'),
    ('sofa', '沙发'),
    ('armchair', '扶手椅'),
    ('coffee_table', '茶几'),
    ('dining_table', '餐桌'),
    ('dining_chair', '餐椅'),
    ('cabinet', '柜体'),
    ('bookshelf', '书架'),
    ('tv_stand', '电视柜'),
    ('television', '电视'),
    ('refrigerator', '冰箱'),
    ('stove', '灶具'),
    ('kitchen_cabinet', '橱柜'),
    ('sink', '水槽'),
    ('toilet', '坐便器'),
    ('washbasin', '洗手盆'),
    ('bathtub', '浴缸'),
    ('shower', '淋浴设施'),
    ('washing_machine', '洗衣机'),
    ('dryer', '烘干机'),
    ('shoe_cabinet', '鞋柜'),
    ('other', '其他'),
)

FURNITURE_TYPES = frozenset(value for value, _label in FURNITURE_TYPE_CHOICES)
