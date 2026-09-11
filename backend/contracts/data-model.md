# 梦食鲜数据契约（当前后端基线）

## 集合分层

| 分层 | 集合 | 作用 |
| --- | --- | --- |
| 身份 | `users`, `customer_organizations`, `admin_users`, `admin_roles` | 微信用户、B 端组织和后台权限 |
| 商品 | `categories`, `products`, `product_skus`, `product_media` | SPU、SKU、分类、媒体关联 |
| 价格 | `prices` | 按用户/组织/等级/端的生效价格 |
| 内容 | `media_assets`, `banners`, `home_sections` | 图片、视频、轮播和首页模块 |
| 履约 | `warehouses`, `inventory`, `inventory_ledger`, `inventory_reservations` | 仓库与库存流水/预占 |
| 配送 | `delivery_areas`, `delivery_slots`, `freight_rules` | 区域、时段、B/C 运费规则 |
| 交易 | `cart_items`, `orders`, `order_items`, `payments`, `refunds`, `shipments` | 购物车明细、订单、支付和履约 |
| 运营 | `group_campaigns`, `groups`, `group_members`, `import_jobs`, `audit_logs`, `system_configs` | 拼团、导入、审计和配置 |

## 不可违反的契约

- `products` 保存商品事实，`product_skus` 保存规格事实；不能用商品名称拼接规格作为正式字段。
- `prices` 没有可见权限时，接口响应不得出现价格、金额或可推导价格的字段。
- `orders` 和 `order_items` 保存商品、规格、价格、运费、地址和配送时段快照。
- `inventory.available = onHand - reserved` 由服务端维护，库存变化必须写 `inventory_ledger`。
- 下单、支付回调、退款和参团都必须接受幂等键，并可安全重试。
- 临时/AI 素材必须带 `temporary=true`，真实素材替换只改变媒体引用，不修改页面代码。

## 当前已落地字段与状态

| 集合 | 当前关键字段 | 约束 |
| --- | --- | --- |
| `users` | `openid`、`userType`、`organizationId`、`status` | 微信身份只由云函数上下文获取 |
| `addresses` | `userId`、`phoneCiphertext`、`phoneMasked`、`regionCode`、`detail`、`isDefault` | 不保存明文手机号；用户端只返回脱敏字段 |
| `products` / `product_skus` | SPU 商品事实 / SKU 规格、包装、条码、状态 | 商品上架前必须有启用分类和已上架 SKU |
| `prices` | `skuId`、`scopeType`、`scopeId`、`channel`、`amountCent`、有效期、状态 | 服务端优先级：用户 > 组织 > 等级 > 客户类型 > 公开价 |
| `warehouses` / `inventory` | 仓库状态、`onHand`、`reserved`、`available`、`version` | `available = onHand - reserved`，不可由客户端直接写入 |
| `delivery_areas` / `freight_rules` | `regionCodes`、可配送仓库、运费与免运门槛 | 地址不在启用区域或无生效规则时拒绝报价 |
| `orders` / `order_items` | 商品/规格/价格/运费/地址/时段快照、状态、幂等键 | 新订单仅由事务创建；状态流转受状态机约束 |
| `inventory_reservations` / `inventory_ledger` | 订单预占、增减流水、操作人、幂等键 | 取消订单必须释放预占并写相反流水 |
| `admin_*` / `audit_logs` | 管理员、角色、会话哈希、操作时间和对象 | 管理端所有写操作写审计日志 |

| `payments` | `orderId`、`outTradeNo`、`amountCent`、`status`、`transactionId` | 支付通知验签并核对金额后才更新 |
| `refunds` | `refundNo`、`orderId`、`amountCent`、`status`、`idempotencyKey` | 申请/审核/渠道确认分阶段，退款金额不能超过可退余额 |
| `group_campaigns` / `groups` / `group_members` | 活动规则、拼团名额、支付成员与状态 | 名额在建单时预占，支付通知后入团，成团更新所有成员订单 |

金额统一存为整数分（`amountCent`、`baseFeeCent` 等），不得以浮点元金额作为订单结算真值。
