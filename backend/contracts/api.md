# 统一 API 契约（阶段 1/4/5 基础能力已实现）

客户端调用 CloudBase 云函数 `api` 时提交：

```json
{
  "action": "catalog.products",
  "payload": { "categoryId": "", "keyword": "", "page": 1, "pageSize": 20 },
  "requestId": "client-generated-id"
}
```

响应统一为：

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "requestId": "client-generated-id"
}
```

失败响应使用稳定 `error.code`；客户端提交的价格、库存、运费和订单金额都不是可信输入。未登录商品接口只返回商品与规格事实，绝不返回价格、金额或成本字段。

## 已实现路由

| 模块 | action | 关键安全约束 |
| --- | --- | --- |
| 连通性 | `health` | 仅返回服务状态与时间 |
| 用户身份 | `auth.wechatLogin`、`auth.me`、`auth.applyBusiness` | 由 CloudBase `OPENID` 识别用户；返回 `userType/businessStatus`，企业申请加密保存并进入后台审核 |
| 商品/内容 | `catalog.categories`、`catalog.products`、`catalog.product`、`content.*` | 未登录响应无价格；只显示已启用/上架内容 |
| 地址 | `address.list`、`address.upsert`、`address.delete` | 手机号 AES-256-GCM 加密保存，只返回脱敏号 |
| 配送选项 | `delivery.options` | 仅返回启用仓库、配送区域和配送时段事实；价格和运费仍由报价接口计算 |
| 购物车 | `cart.list`、`cart.upsert`、`cart.remove` | 用户只能访问自己的购物车 |
| 报价/订单 | `checkout.quote`、`orders.create`、`orders.list`、`orders.get`、`orders.cancel`、`orders.complete` | 服务端价格/区域/库存校验；下单和库存预占在事务中执行；订单幂等键必填；线下结算仅限已审核 B 端账号；已支付订单（`paymentStatus=paid`）不能直接取消，必须走退款售后流程 |
| 支付 | `payments.wechat.prepare`、`payments.wechat.notify` | 预下单和通知均必须经过服务端配置的支付适配器；支付适配器未配置时 `orders.create`/拼团建单与预下单一并拒绝 |
| 拼团 | `groups.campaigns`、`groups.create`、`groups.join`、`groups.get`、`groups.quote` | 名额建单时预占，支付验签后入团；同一用户和同一团不能重复占位；微信支付未配置时不能建团订单；活动封面如填写，必须引用启用的图片媒体 |
| 售后 | `refunds.request`、`refunds.notify` | 用户申请、后台审核、退款渠道验签确认；金额与订单核对 |
| 后台认证 | `admin.bootstrap`、`admin.login`、`admin.logout`、`admin.me`、`admin.password.change`、`admin.readiness` | 首管初始化令牌仅服务器变量；密码使用 scrypt；自助改密必须验证当前密码并强制所有会话重新登录；`admin.readiness` 只向具备后台读取权限的管理员返回非敏感运营配置计数与阻塞项；自定义角色只能授予已定义权限点（不得包含通配符 `*`），超级管理员角色不可在后台创建或改写（按库中现有编码判定），非超级管理员不能授予超出自身权限范围的角色 |
| 后台商品/素材 | `admin.categories.*`、`admin.products.*`、`admin.skus.*`、`admin.imports.*`、`admin.media.*`、`admin.productMedia.*`、`admin.banners.*`、`admin.homeSections.*` | 角色权限与审计日志；导入先入草稿；`admin.imports.activateBatch` 仅允许同时具备导入写入和商品写入权限的管理员，单批最多 10 条且可重复执行；分类/商品引用的图片素材必须存在且启用；`admin.media.createVersion` 新建版本并保留旧记录，禁止覆盖旧文件；商品详情图片/视频必须先登记素材，再由后台显式创建 `product_media` 关联，服务端校验商品、SKU 归属和媒体类型；首页内容可带唯一 `contentKey`，重复创建会被拒绝，普通后台编辑不会清空已有业务键；内容投放端只支持小程序/网页，排期必须为合法且正序的时间范围 |
| 后台价格/履约 | `admin.prices.*`、`admin.warehouses.*`、`admin.inventory.*`、`admin.deliveryAreas.*`、`admin.freightRules.*`、`admin.orders.*` | 库存调整要求幂等键并写流水；支付成功状态仅留给验签回调；后台取消订单与用户侧口径一致——已支付订单拒绝直接取消（`ORDER_PAID_CANCEL_FORBIDDEN`），未支付订单取消时在同一事务内释放库存预占与拼团名额 |
| 后台售后 | `admin.refunds.list`、`admin.refunds.review` | 退款审核不能直接伪造渠道退款成功 |
| 审计 | `admin.audit.list` | 需要 `audit.read` 或超级管理员权限 |

## 尚未实现的生产接入

- 微信支付预下单、平台证书/APIv3 密钥接入、真实支付/退款渠道验签与调用、售后图片凭证和通知；
- CloudBase 定时触发器绑定、配送时段容量/配送单与司机调度；
- 失败拼团的退款编排、通知和高并发压力验证；
- 小程序和网页端从 mock provider 切换到已部署测试 API。

上述生产接入必须在商户资料、隐私角色、退款规则和拼团口径确认后实现，不能由前端或管理后台手工绕过。企业认证、组织审批、B/C 等级维护以及履约联系人最小权限读取基础能力已在服务端实现，仍需后台体验和测试环境联调。
