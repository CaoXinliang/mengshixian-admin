# 友方 API 模块地图

核对时间：2026-09-24（本地未提交代码，含当日 SKU 上架旁路修复）。当前入口：`backend/cloudbase/functions/api/app.js`（云函数装配入口 `index.js` 初始化 CloudBase 适配后调用 `createApplication`）。保持 `createApplication(options)`、`dispatch(event)`、`runMaintenance(payload)` 与现有 action 名称不变。本地图只负责定位代码，不代表云端已部署；行为以当前源码和测试为准。

| 文件（相对 API 目录） | 职责 | 依赖与约束 |
| --- | --- | --- |
| `app.js` | 组装依赖、鉴权、公开查询、登录管理、action 路由、响应包装 | 统一注入 store、clock、支付与存储适配；不由业务模块反向引用入口 |
| `index.js`、`lib/cloud-store.js` | 云函数装配入口与 CloudBase 数据库到统一 store 接口的适配 | `index.js` 初始化 SDK、注入存储/身份/媒体 URL 适配后调用 `createApplication`；缺失文档按 null 处理，不含业务规则 |
| `lib/admin-catalog-actions.js` | 分类、商品、规格、内容、素材、媒体关系及导入动作；含 SKU 上架核对门 | 注入 getAdmin、audit、存储上传、导入模块与 catalogReview；SKU 转入 `on_sale`（`admin.skus.setStatus` 与已有 SKU upsert 两条路径）前经 `skuPreviewStore`＋`requireSkuReviewReady` 复用 `catalog-review.read` 完整核对，缺项返回 `PRODUCT_NOT_READY` 与中文缺项清单及核对页引导；条件齐备的 `off_sale` 重启用保留 |
| `lib/customer-order-actions.js` | 顾客地址、购物车、结算、订单、支付和退款动作 | 注入顾客身份与支付适配；事务和金额规则继续复用 commerce、refunds、order-state |
| `lib/commerce.js`、`lib/order-state.js`、`lib/refunds.js` | 报价与下单、库存预约/占用/释放、运费与配送时段解析；订单状态机；退款申请、审核与确认 | 供入口拼团流、顾客订单与运营模块共用；金额与状态流转仍在服务端裁决，幂等依赖稳定文档 ID |
| `lib/admin-operations-actions.js` | 价格、客户企业审核、仓库库存、配送、营销和订单履约动作 | 注入 getAdmin、audit、价格对象与媒体校验；继续执行原权限、事务、幂等和审计；`admin.demo.seedCommerce` 为演示专用直写（demoMode＋超管通配双门），绕过核对门，生产不开启 demoMode 时不可达 |
| `lib/api-values.js` | 字段读取、分页、时间及公开/脱敏字段投影 | 无运行期管理员或顾客会话；供入口和动作模块共享 |
| `lib/response.js`、`lib/collection-read.js`、`lib/transaction-ids.js` | 响应包装与统一错误、分页扫描加谓词过滤的列表读取、订单/库存/退款/拼团成员等稳定幂等文档 ID | 无业务状态，供入口和各模块共用 |
| `lib/catalog-import.js` | 商品/规格编码对应、导入草稿和冲突检查 | 导入不自动上架，保留来源行及错误 |
| `lib/catalog-review.js` | 汇总商品上架条件、生成核对结果和明确发布 | 调用库存、配送、个人端价格覆盖及依赖快照模块；发布时仍由服务端裁决；`read` 支持注入只读 store 覆盖，被商品核对发布与 SKU 上架门两处复用 |
| `lib/catalog-price-coverage.js`、`lib/catalog-stock-review.js`、`lib/catalog-delivery-review.js` | 分别核对个人端有效价格、可售库存及配送条件 | 供商品核对模块调用；不把本地检查等同真实云端可下单 |
| `lib/review-dependencies.js` | 记录核对所依赖的数据，用于发布时发现已变化的资料 | 新增依赖的并发变化和真实云事务仍待验证 |
| `lib/catalog-readiness.js` | 商品基础上架条件与有效价格的基础校验 | 商品级直改 `on_sale` 两条路径已被 `CATALOG_REVIEW_REQUIRED` 拦截到核对页，本模块现仅作兜底校验保留 |
| `lib/content-targets.js` | 内容跳转目标（商品/分类）的可用性校验与保存前拦截 | 公开内容流与内容保存动作共用，复用受众可见规则 |
| `lib/admin-media-chunks.js` | 媒体分段上传与存储适配 | 本地上传测试不等于真实云存储及长视频验收 |
| `lib/pricing-targets.js` | 价格适用对象的可读选择与校验 | 最终价格仍由服务端决定 |
| `lib/offline-receipts.js` | 企业线下订单收款流水、已收/待收计算、幂等与审计 | 收款状态独立于履约状态；本地内存测试不证明真实到账或云事务 |
| `lib/staff-accounts.js`、`lib/staff-policy.js` | 两类工作人员账号、角色权限、密码和手机号验证状态 | 手机号无真实短信验证时保持未验证；旧账号资料保留 |
| `lib/staff-write-guard.js` | 账号写操作的会话/权限复核、最后可用超管保护及原子写入边界 | 云端并发与事务冲突尚未实测 |
| `lib/permissions.js`、`lib/security.js` | 共用权限判断、口令/令牌及敏感字段安全工具 | 服务端校验，不依赖页面隐藏按钮 |

三个主要动作模块返回原动作函数；`offline-receipts`、`staff-accounts` 等独立模块也由 `app.js` 组装并接入路由。主要业务模块由入口注入 `getAdmin` 和审计能力；工作人员写入口另经 `staff-write-guard` 复核，不能仅凭页面隐藏按钮授权。商品模块仅向运营模块提供媒体引用校验，不建立循环依赖。工作人员相关入口包括 `admin.staff.*`、`admin.password.change`；线下收款入口包括 `admin.orders.receipts.list/record`。

此前迁移与后续功能的本地测试结果分别记录在对应验收文件，不能把旧测试描述为本次重新运行。原待核对点“页面仍有单独 SKU 上架入口，可能绕过完整上架核对”已于 2026-09-24 解决：`admin.skus.setStatus` 与已有 SKU 经 `admin.skus.upsert` 转入 `on_sale` 的两条路径，现在强制复用 `catalog-review.read` 完整核对（`skuPreviewStore` 以拟写入状态参与核对读取），缺项返回 `PRODUCT_NOT_READY` 与全部中文缺项清单并引导到商品核对发布页；条件齐备的 `off_sale` 重启用保留；`admin.demo.seedCommerce`（demoMode＋超管通配双门）仍为演示专用直写。修复范围与本地验收证据见 `docs/FR-SKU-GATE-01-本地验收.md`。

后续新增逻辑优先放入相应业务模块；模块接近 800 行时继续按具体业务拆分，不能通过压行规避限制。
