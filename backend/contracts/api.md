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
| 用户身份 | `auth.wechatLogin`、`auth.web.login`、`auth.web.me/logout/password.change`、`auth.me`、`auth.applyBusiness` | 小程序只信任 CloudBase `OPENID`；网页只信任服务端会话 token 哈希对应的用户；绝不信任 payload 中的 `userId/openid` |
| 商品/内容 | `catalog.categories`、`catalog.products`、`catalog.product`、`content.*` | 未登录响应无价格；只显示已启用/上架内容；SKU 可返回不含金额的起订量和购买倍数 |
| 地址 | `address.list`、`address.upsert`、`address.setDefault`、`address.delete` | 手机号 AES-256-GCM 加密保存，只返回脱敏号；`setDefault` 只接收本人地址 ID，在事务中保证每个用户至多一个默认地址，无需重传手机号；删除地址也在事务中重设或清除默认地址指针 |
| 配送选项 | `delivery.options` | 仅返回启用仓库、配送区域、配送时段和自提点事实；自提点不返回敏感电话，价格和运费仍由报价接口计算 |
| 购物车 | `cart.list`、`cart.upsert`、`cart.remove` | 用户只能访问自己的购物车；新行按 `userId+skuId` 生成稳定 ID 并事务写入，同 SKU 首次并发加购不会产生重复行 |
| B端采购 | `favorites.*`、`frequent.*`、`orders.repurchase.*`、`procurement.*`、`inquiries.*` | 收藏的列表/新增/删除向 B/C 用户开放；常购、复购、账期和询价仅限已审核且有关联企业的 B 端用户；价格、数量规则、库存、授信和询价版本均由服务端校验 |
| 营销/会员 | `bundles.*`、`groups.mine`、`coupons.*`、`points.*`、`membership.profile`、`reviews.*`、`invoiceTitles.*`、`invoices.*`、`storedValue.*` | 套餐与券金额服务端计算并写入订单快照；评价、发票、积分与储值严格归属隔离；AI/临时草案不可激活 |
| 报价/订单 | `checkout.quote`、`orders.create`、`orders.list`、`orders.get`、`orders.cancel`、`orders.complete` | 服务端价格/数量阶梯/起订量/购买倍数/履约方式/区域/仓库/库存校验；下单重新报价并保存价格、购买规则与配送或自提快照；下单和库存预占在事务中执行；订单幂等键必填；线下结算仅限已审核 B 端账号；已支付订单（`paymentStatus=paid`）不能直接取消，必须走退款售后流程 |
| 支付 | `payments.wechat.prepare`、`payments.wechat.notify` | 预下单和通知均必须经过服务端配置的支付适配器；支付适配器未配置时 `orders.create`/拼团建单与预下单一并拒绝 |
| 拼团 | `groups.campaigns`、`groups.create`、`groups.join`、`groups.get`、`groups.quote` | 名额建单时预占，支付验签后入团；同一用户和同一团不能重复占位；微信支付未配置时不能建团订单；活动封面如填写，必须引用启用的图片媒体 |
| 售后 | `refunds.request`、`refunds.list`、`refunds.get`、`refunds.media.upload`、`refunds.notify` | 用户只能访问本人售后；按订单项和数量申请，金额由订单快照计算；凭证上传固定用途并绑定用户；成功态只能来自退款渠道验签通知 |
| 后台认证 | `admin.bootstrap`、`admin.login`、`admin.logout`、`admin.me`、`admin.password.change`、`admin.readiness` | 首管初始化令牌仅服务器变量；密码使用 scrypt；自助改密必须验证当前密码并强制所有会话重新登录；`admin.readiness` 只向具备后台读取权限的管理员返回非敏感运营配置计数与阻塞项；自定义角色只能授予已定义权限点（不得包含通配符 `*`），超级管理员角色不可在后台创建或改写（按库中现有编码判定），非超级管理员不能授予超出自身权限范围的角色 |
| 后台网页账号 | `admin.webAccounts.list/upsert/setStatus/resetPassword` | `users.read/write` 权限；只能绑定既有 user，登录标识唯一，创建/重置密码由管理员提交且响应从不返回密码、盐或哈希；停用和重置密码立即使已有会话失效 |
| 后台商品/素材 | `admin.categories.*`、`admin.products.*`、`admin.skus.*`、`admin.imports.*`、`admin.media.*`、`admin.productMedia.*`、`admin.banners.*`、`admin.homeSections.*` | 角色权限与审计日志；导入先入草稿；`admin.imports.activateBatch` 仅允许同时具备导入写入和商品写入权限的管理员，单批最多 10 条且可重复执行；分类/商品引用的图片素材必须存在且启用；`admin.media.createVersion` 新建版本并保留旧记录，禁止覆盖旧文件；商品详情图片/视频必须先登记素材，再由后台显式创建 `product_media` 关联，服务端校验商品、SKU 归属和媒体类型；首页内容可带唯一 `contentKey`，重复创建会被拒绝，普通后台编辑不会清空已有业务键；内容投放端只支持小程序/网页，排期必须为合法且正序的时间范围 |
| 后台价格/履约 | `admin.prices.*`、`admin.warehouses.*`、`admin.inventory.*`、`admin.deliveryAreas.*`、`admin.freightRules.*`、`admin.deliverySlots.*`、`admin.pickupSites.*`、`admin.orders.*` | 自提点读写沿用 `delivery.read/write`；库存调整要求幂等键并写流水；支付成功状态仅留给验签回调；后台取消订单与用户侧口径一致——已支付订单拒绝直接取消（`ORDER_PAID_CANCEL_FORBIDDEN`），未支付订单取消时在同一事务内释放库存预占与拼团名额 |
| 后台售后 | `admin.refunds.list`、`admin.refunds.get`、`admin.refunds.review`、`admin.refunds.process` | `review` 审核，`process` 仅登记 `channel_pending`；两者均要求幂等键并写操作/审计日志，不能手工伪造退款成功 |
| 后台采购财务 | `admin.creditAccounts.*`、`admin.receivables.*`、`admin.statements.list`、`admin.inquiries.*` | 授信、应收核销与询价报价均受独立权限及审计约束；AI/临时授信不可启用，AI/临时报价保持草稿且不可确认 |
| 审计 | `admin.audit.list` | 需要 `audit.read` 或超级管理员权限 |

## 网页用户会话

- 后台 `admin.webAccounts.upsert({userId,loginId,password,status})` 为既有用户建立网页登录账号；`loginId` 可为用户名或手机号形式的登录标识。密码使用独立随机盐的 scrypt 哈希存储，列表和写入响应仅返回 `loginIdMasked`，不返回明文密码、盐或哈希。
- `auth.web.login({loginId|username|phone,password}) -> {sessionToken,expiresAt,user}`，兼容旧 action `auth.webLogin`。会话 token 使用密码学随机值，明文只在登录响应返回一次，服务端仅保存 SHA-256 哈希和 24 小时过期时间。
- `auth.web.me/logout/password.change` 分别读取会话、撤销当前会话、校验原密码后改密。改密或后台重置会通过 `passwordVersion/sessionsRevokedAt` 立即废止该账号全部旧会话；后台停用账号或用户停用也会在每次请求重新校验时立即拒绝。
- 网页业务 action 在 payload 传 `sessionToken`；兼容历史 `webSessionToken`，但两者同时出现且不相同时返回 `AUTH_TOKEN_CONFLICT`，因此不存在优先级歧义。CloudBase action 调用使用 payload，不依赖浏览器可伪造的 `userId/openid` 或 Authorization header。
- `dispatch` 使用请求级异步上下文解析身份：有 token 时只取会话绑定 user，无 token 时才取当次 CloudBase `OPENID`，不把当前用户写入全局或可变闭包。所有现有购物车、地址、报价、订单、营销、会员和 B 端接口共用该解析器，不另建可绕过归属校验的网页路由。
- 网页结算必须使用真实 `_id`：`address.upsert` 保存 `name/phone/detail/regionCode`，`delivery.options` 返回 `warehouses/areas/slots/pickupSites`。`checkout.quote/orders.create` 通用参数为 `{channel:'web',warehouseId,fulfillmentType,items}`；配送必须传本人 `addressId`、可选 `deliverySlotId`，自提必须传 `pickupSiteId`且不得传配送时段。套餐使用 `bundleId/bundleQuantity`，优惠券使用 `couponId`，询价使用 `acceptedQuoteToken`且 `items` 必须与报价一致。建单必须提供可重试的 `idempotencyKey`，客户端不提交价格、库存或运费结果。
- 15 分钟窗口内连续 5 次密码错误后锁定 30 分钟。稳定错误码包括 `AUTH_INVALID_CREDENTIALS`、`AUTH_ACCOUNT_LOCKED`、`AUTH_ACCOUNT_DISABLED`、`AUTH_SESSION_EXPIRED`和 `AUTH_TOKEN_CONFLICT`。

## 数量阶梯与购买规则

- `product_skus.minOrderQuantity` 和 `product_skus.orderMultiple` 分别表示 SKU 默认起订量与购买倍数，缺省值都是 `1`。
- `prices.quantityTiers` 是最多 20 档的数组，每档包含 `minQuantity`、可选 `maxQuantity` 和 `amountCent`；区间不得重叠，未命中阶梯时继续使用原 `amountCent`，因此旧价格规则无需迁移即可继续工作。
- 价格规则可选的 `minOrderQuantity` / `orderMultiple` 允许对用户、企业、等级或客户类型覆盖 SKU 默认值；`0` 或缺省表示继承 SKU。
- `catalog.prices` 仅向已登录用户返回当前身份命中的价格规则及可选阶梯。`catalog.products` / `catalog.product` 仍不返回任何金额。
- `checkout.quote` 先合并重复 SKU 数量，再选择阶梯并校验起订/倍数；`orders.create` 不信任客户端价格，会重跑同一服务端报价逻辑。
- AI 生成的阶梯和起订数据必须保留 `source=ai_generated`、`temporary=true` 及明确的 `demoNote`，只能保存为 `draft`，不得激活为正式经营价格或起订政策。

## 配送与到店自提

- `pickup_sites` 字段统一为 `_id`、`name`、`address`、`regionCode`、`warehouseId`、`openingHours`、`status`、`sort`、`createdAt`、`updatedAt`。`admin.pickupSites.list/upsert` 分别要求 `delivery.read`、`delivery.write`。
- `delivery.options` 的 `pickupSites` 只投影启用自提点的 `_id/name/address/regionCode/warehouseId/openingHours/sort`，即使底层出现额外敏感字段也不得公开。
- 公开自提点还必须关联当前启用仓库；后台只能把关联启用仓库的自提点设为 `active`，但允许停用记录保留已经失效的历史仓库引用。
- `checkout.quote` 和 `orders.create` 的 `fulfillmentType` 只允许 `delivery` 或 `pickup`，缺省继续按 `delivery` 处理，以兼容旧客户端。
- 配送订单必须提交本人有效 `addressId` 和与其对应的区域，可选 `deliverySlotId` 仍需匹配配送区域及仓库。
- 自提订单必须提交有效 `pickupSiteId`，且其 `warehouseId` 必须等于订单仓库；不要求 `addressId`，禁止同时选择配送时段，服务端运费固定为 `0`。
- 报价返回 `fulfillmentType` 与可空的 `pickupSiteSnapshot`。订单保存同名字段；自提订单的 `addressSnapshot=null`、`fulfillmentContactCiphertext=''`，不得拿用户历史地址伪造收货联系人。自提点变更不影响历史订单快照。
- `orders.create` 在事务内按报价选中的 `priceRuleId` 重新读取价格规则并核对成交价、起订量和购买倍数；已选择配送时段时也在事务内复核状态、排期、区域与仓库。任一规则变化均要求重新结算。
- 已成功订单的同用户、同幂等键重试优先返回既有订单，不再受随后发生的地址、自提点、价格、库存或支付适配器状态变化影响；首次建单仍执行完整校验和事务预占。

## 订单详情与结构化售后

- `orders.get({id}) -> {order,items}` 仅允许订单所属用户读取；`admin.orders.get({adminToken,id})` 要求 `orders.read`。两者返回下单时的商品、规格、价格规则、数量阶梯、购买规则、履约、运费与订单项快照，但不返回手机号密文、建单幂等键等内部字段。
- `refunds.request` 新契约为 `{orderId,items:[{orderItemId|skuId,quantity}],reasonCode,description,mediaIds,idempotencyKey}`。`items` 最多 20 条，同一订单项不能重复；原因枚举为 `quality_issue/damaged/wrong_item/missing_item/not_received/other`，说明最多 500 字，媒体最多 6 个。
- 退款商品金额只按服务端订单项快照计算，忽略客户端金额。套餐价和优惠券折扣后的净商品金额以原小计比例+最大余数法分摊为每项 `paidSubtotalCent/refundableAmountCent`；按数量部分退款用累计比例计算，最后剩余数量吸收分摊尾差，不得按折前单价超额退款。只有服务端确认选择全部剩余商品时才计入剩余运费/调整额，且总额不超过订单剩余可退总额。
- 已送达/已完成订单以完成、送达或更新时间为基准提供 7 天售后期。申请事务会校验订单状态、支付状态、期限、订单项归属、可售后剩余数量和当前活动申请，并原子预留售后数量，避免重复或并发超额；审核拒绝会释放数量，成功部分退款后其余数量仍可继续申请。
- `refunds.media.upload` 每次上传一个认证用户凭证，固定 `purpose=aftersale_evidence`、`businessEvidence=true`、`userId=当前用户`、`temporary=false`。仅支持 JPEG/PNG/WebP 图片（不超过 4 MB）与 MP4/WebM/QuickTime 视频（不超过 10 MB）；`refunds.request` 只接受当前用户拥有、启用且用途正确的媒体 ID。
- 用户 `refunds.list/get` 严格按 `userId` 隔离；后台 `admin.refunds.list/get` 要求 `refunds.read`。返回结构包含订单项、原因、说明、凭证 ID、金额、状态时间线、`channelStatus` 与 `manualRefundRequired`，详情额外返回经归属校验的凭证媒体与可选临时 URL，不返回退款幂等键。用户私有凭证不能通过公共 `content.media.resolve` 猜 ID 解析。
- 管理员 `admin.refunds.review({id,decision:'approved'|'rejected',reviewNote,idempotencyKey})` 审核通过后只进入 `awaiting_manual_refund`；`admin.refunds.process({id,action:'channel_pending',idempotencyKey,note})` 只登记已提交渠道，仍保持 `manualRefundRequired=true`。未配置真实退款渠道时不会写成已退款；只有 `refunds.notify` 经适配器验签并核对退款单号和金额后才能进入 `succeeded`。
- 为兼容旧客户端，未传结构化 `items` 的历史整单退款请求仍可使用 `amountCent/reason`，但只允许申请订单剩余全额；新客户端应统一使用结构化契约。

## B 端采购、账期与询价

- 所有本节用户接口均要求 `userType=b`、`businessStatus=approved` 且存在 `organizationId`。`procurement.account.get` 返回本人企业的安全摘要 `organization:{id,name,priceLevel,paymentTermDays}`，以及额度、占用、应收和服务端计算的可用额。
- 收藏与常购分别使用 `favorites.list/upsert/remove/batchAddToCart`、`frequent.list/upsert/remove/batchAddToCart`。保存和批量加入均复核当前上架、用户可见范围、实时价格规则、起订量和购买倍数；批量接口接收 `{items:[{id,quantity}],idempotencyKey}`，SKU 从本人保存记录读取，不信任客户端 SKU。购物车写入使用绝对目标数量，返回 `addedItems/invalidItems`，重试不会再次累加。
- `orders.repurchase.preview` 从原订单快照生成当前可复购结果；`orders.repurchase.commit` 接收原订单项子集 `{items:[{skuId,quantity}]}`，额外 SKU 返回 `REPURCHASE_ITEM_NOT_IN_ORDER`。两者重新校验当前商品、价格、库存、起订量和倍数，并明确返回 `addedItems/invalidItems`，不静默跳过。
- `admin.creditAccounts.upsert` 配置 `creditLimitCent/paymentTermDays/status/source/temporary`。AI 草案默认 `disabled/temporary=true`；`source=ai_generated` 或 `temporary=true` 不能启用，不会被当成真实授信。`paymentMethod=credit` 仅允许已审核 B 端，并在建单事务内锁定可用额度、写 `receivable_ledger`，并发超额会拒绝。
- 账期订单取消时释放额度；订单完成时把占用转成应收并生成 `statements`。`procurement.receivables.list/procurement.statements.list` 只返回当前企业数据。`admin.receivables.settle({statementId,amountCent,idempotencyKey,note})` 支持部分或全部核销，事务更新对账单与账户应收并写操作、应收流水和审计日志。
- 账期售后：未完成且仍占用额度的订单只允许整单售后释放；已转应收订单先冲减该订单尚未结清金额。超过未结清部分表示已有回款，返回 `creditAdjustmentCent/cashRefundRequiredCent` 并进入人工退款/渠道处理中；现金部分仍只能由真实验签回调确认，不能凭空冲销回款。退款成功本身不代表退货验收入库，因此已交付库存不会自动增加。
- 询价接口为 `inquiries.create/list/get/accept`。创建必须提供幂等键、拒绝重复 SKU；后台 `admin.inquiries.list/get/quote/transition` 使用 `submitted -> quoted -> accepted -> closed`，另支持 `cancelled/expired`。后台报价按版本保存服务端汇总金额和有效期；AI/临时报价数据库状态为 `draft`，不能被客户确认。
- 正式报价必须 `source=client,temporary=false`。`inquiries.accept({id,quoteId,version,idempotencyKey})` 在事务内复核归属、最新版本、状态和有效期，生成可追溯的单用户 `acceptedQuoteToken`；同参数重试回放结果，幂等键复用到其他报价会冲突。该 token 传给 `checkout.quote/orders.create` 后，服务端锁定 quoteId/version/商品数量/报价及归属，在建单事务内再次校验并单次消费；成功订单幂等重试仍返回原订单。

## 营销、积分会员与经营服务

- 套餐：`bundles.list/get/quote`；建单传 `{bundleId,bundleQuantity}`，不信任客户端的套餐商品和金额。报价展开套餐 SKU 数量、校验库存/起订/倍数，建单事务内复核套餐版本、排期、价格和明细，保存 `bundleSnapshot`。`admin.bundles.upsert/setStatus`管理草稿和启停；AI/临时套餐不能启用。
- 拼团：原 `groups.campaigns/create/join/get/quote` 继续保持并发名额与幂等保护；`groups.mine`/`groups.my.list` 返回我的参团记录。超时团更新为 `failed`，已付款订单只生成需退款待办，`admin.groups.refundTasks` 不伪造已退款。
- 优惠券：`coupons.templates/claim/list`。领取要求幂等键，总量和每人限领在事务内竞争；`checkout.quote/orders.create` 只接收 `couponId`，服务端按范围内商品金额、门槛、折扣/封顶计算，建单事务内核销并保存 `couponSnapshot`。事务失败自动回滚，未支付取消、支付超时或拼团未付款超时会释放券。
- 积分/会员：`points.account`/`points.account.get`、`points.signIn`/`points.checkin`、`points.ledger`、`membership.profile`。签到、订单完成奖励和退款扣回均写确定性幂等流水，扣回不使余额为负。订单奖励只读取已正式启用的 `points_rules/order_reward`；后台提供 `admin.points.adjust`、`admin.points.rules.*`、`admin.membershipLevels.*`，AI/临时规则不能激活。
- 收藏/评价：`favorites.list/upsert/remove` 对 B/C 认证用户开放。`reviews.eligible/create/mine/list`；评价以 `userId+orderItemId` 唯一，仅完成订单可评。`reviews.media.upload` 复用安全上传并固定 `purpose=review_evidence`；未审核媒体不得公开解析，`admin.reviews.review` 通过后才允许 `content.media.resolve` 返回可访问 URL。
- 发票：`invoiceTitles.*`与兼容别名 `invoice.headers.*`，`invoices.request/list/get`。抬头、订单和申请全部按当前用户归属校验；税号和银行账号使用 PII 密钥加密保存，申请快照及 `admin.invoices.list/get` 只返回脱敏值，后台详情读取要求 `invoices.read` 并审计。未配置开票服务商时只返回 `provider_unconfigured/pending_manual`，不能手工伪造 `issued`。
- 储值：`storedValue.account/ledger/topupIntent`及兼容别名 `wallet.account.get/wallet.recharge.prepare`。当前只创建 `status=unavailable,reason=payment_not_configured,balanceChanged=false` 的充值意向，不调用真实渠道、不增加余额。

## 后台批量运营、查询与版本契约

- `admin.products.batchUpsert({adminToken,idempotencyKey,items[]})` 与 `admin.prices.batchUpsert(...)`：每批 1-50 项，分别要求 `catalog.write` / `pricing.write`。返回 `{operationId,idempotent,rows:[{index,ok,id,revision}|{index,ok:false,error}],succeeded,failed}`；同管理员、同业务类型、同幂等键和相同 items 回放原结果，不同 items 返回 `IDEMPOTENCY_CONFLICT`。单项失败不伪装整批成功，批次摘要和每项写入均有审计记录。
- `admin.inventory.ledger({warehouseId?,skuId?,reason?,referenceId?,dateFrom?,dateTo?,page?,pageSize?})`：要求 `inventory.read`，筛选和分页在服务端完成；日期必须是合法时间。返回库存变化、前后可售量、原因、引用和操作人等流水事实。
- `admin.orders.list` 支持 `status/paymentStatus/paymentMethod/fulfillmentType/warehouseId/organizationId/userId/orderNo/createdFrom/createdTo` 服务端筛选，仍只返回 `safeOrder` 脱敏投影。`admin.orders.get({id}) -> {order,items}` 返回完整业务快照但不含手机号密文、幂等键或支付验签原文。
- `admin.orders.notes.add({id,note,idempotencyKey})` 添加不可变内部备注，`admin.orders.notes.list({id,page,pageSize})` 查询备注；同键不同订单或内容冲突。`admin.orders.batchTransition({idempotencyKey,items:[{id,status,carrier?,trackingNo?}]})` 返回逐项结果，仍逐单执行原订单状态机、库存、券、积分和账期事务规则。
- 订单搜索统一使用增强后的 `admin.orders.list`，不另设重复路由。`admin.orders.export({上述筛选,limit<=2000})` 返回脱敏结构化数据 `{rows,total,generatedAt,truncated}`；`admin.orders.pickingList({ids[]})` 最多 100 单，返回仓库、履约、已脱敏收件信息、时段和商品快照，不返回手机号明文。导出和拣货读取均写审计，审计详情绝不保存 `adminToken/sessionToken/password`。
- `admin.permissions.catalog()` 返回 `{permissions:[{code,module,operation}],builtInRoles:[{code,permissions}]}`。`admin.roles.setStatus({id,status:'active'|'disabled'})` 只做软停用/启用；`super_admin` 不能修改或停用，角色创建/编辑仍由 `admin.roles.upsert` 校验已知权限和提权边界。
- 运营读取：`admin.couponGrants.list` 支持 `status/templateId/userId`；`admin.points.accounts.list` 支持 `userId/levelCode`；`admin.points.ledger` 支持 `userId/action/orderId`；`admin.storedValue.ledger` 支持 `userId/action/orderId`；`admin.groups.members` 支持 `groupId/campaignId/userId/status`。`admin.reviews.list` 支持 `status/userId/productId/orderId/rating`，`admin.invoices.list` 支持 `status/userId/orderId/titleType`，`admin.receivables.list` 支持 `organizationId/accountId/orderId/statementId/action`，`admin.statements.list` 支持 `organizationId/accountId/orderId/status`。以上均支持 `dateFrom/dateTo/page/pageSize`，由服务端先筛选再分页，并移除密文、令牌哈希、密码和幂等键字段。
- 通用版本实体：`product/price/banner/homeSection/media/groupCampaign/bundle/couponTemplate/membershipLevel/pointsRule`。相应后台 upsert 会写不可变 `entity_versions` 快照并增加独立 `revision`，不改变素材或营销对象已有的业务 `version` 语义；同一已有实体的并发编辑使用 60 秒事务租约串行化，竞争请求返回 `VERSION_WRITE_IN_PROGRESS`，防止历史快照丢失中间版本。
- `admin.versions.list({entityType,entityId,page,pageSize}) -> {rows,total,page,pageSize}`；`admin.versions.rollback({entityType,entityId,version,idempotencyKey}) -> {entity,history,idempotent}`。回滚在文档事务中读取当前对象和目标快照，生成新的 `revision` 与新的历史记录，绝不覆盖旧版本；相同键回放，参数变化冲突。任何回滚结果均强制保持 `draft/disabled`，由管理员复核后再走原启用接口，不能借回滚绕过商品就绪、排期或 AI/temporary 激活规则。
- 商品、SKU、价格、Banner、首页模块、媒体和营销配置均执行正式态边界：AI、demo 或 temporary 数据只能保存为草稿/停用态；商品和价格更新未提交来源字段时保留已有 `source/temporary/demoNote`，不能静默改成正式数据。

## 尚未实现的生产接入

- 微信支付预下单、平台证书/APIv3 密钥接入、真实支付/退款渠道验签与调用、售后结果通知；
- CloudBase 定时触发器绑定、配送时段容量/配送单与司机调度；
- 失败拼团的退款编排、通知和高并发压力验证；
- 小程序和网页端从 mock provider 切换到已部署测试 API。

上述生产接入必须在商户资料、隐私角色、退款规则和拼团口径确认后实现，不能由前端或管理后台手工绕过。企业认证、组织审批、B/C 等级维护以及履约联系人最小权限读取基础能力已在服务端实现，仍需后台体验和测试环境联调。
