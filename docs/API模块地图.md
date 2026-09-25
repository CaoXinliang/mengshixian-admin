# 友方 API 模块地图

核对时间：2026-09-24（本地提交 `185cbd3` 加当前未提交的企业审核等改动，含当日 SKU 上架旁路修复）。当前入口：`backend/cloudbase/functions/api/app.js`（云函数装配入口 `index.js` 初始化 CloudBase 适配后调用 `createApplication`）。保持 `createApplication(options)`、`dispatch(event)`、`runMaintenance(payload)` 与现有 action 名称不变。本地图只负责定位代码；测试环境部署记录见 `docs/FR-CLOUD-DEPLOY-01-测试服验收.md`，不代表正式上线，云端现状仍须单独核对。

| 文件（相对 API 目录） | 职责 | 依赖与约束 |
| --- | --- | --- |
| `app.js` | 组装依赖、鉴权、公开查询、登录管理、action 路由、响应包装；`admin.readiness` 返回开店基础资料计数 | 统一注入 store、clock、支付与存储适配；不由业务模块反向引用入口。`admin.readiness` 允许具备 `admin.read`、`catalog.read` 或 `delivery.read` 权限的已登录人员读取，只表明记录存在，不裁定真实可营业、收款或下单 |
| `index.js`、`lib/cloud-store.js` | 云函数装配入口与 CloudBase 数据库到统一 store 接口的适配 | `index.js` 初始化 SDK、注入存储/身份/媒体 URL 适配后调用 `createApplication`；缺失文档按 null 处理，不含业务规则 |
| `lib/admin-catalog-actions.js` | 分类、商品、规格、内容、素材、媒体关系及导入动作；含 SKU 上架核对门 | 注入 getAdmin、audit、存储上传、导入模块与 catalogReview；`admin.media.updateMetadata` 仅改名称/来源/临时标记/适用端/展示时间，拒绝文件/类型/版本字段，以后台自动携带的 `metadataRevision` 阻断旧页面覆盖，事务内更新资料并写操作日志；保留原文件与校验值，AI/演示来源不可标为非临时。`admin.media.upsert` 仅登记新素材，携带已有素材 ID 的旧更新请求被拒并引导到“改资料”；换文件仍走 `createVersion`。SKU 转入 `on_sale` 前经 `skuPreviewStore`＋`requireSkuReviewReady` 复用 `catalog-review.read` 核对，缺项返回 `PRODUCT_NOT_READY` 与中文缺项清单及核对页引导；条件齐备的 `off_sale` 重启用保留 |
| `lib/customer-order-actions.js` | 顾客地址、购物车、结算、订单、支付和退款动作 | 注入顾客身份与支付适配；`admin.refunds.reviewDetail` 经 `refunds.read` 读取原订单商品快照、可退余额和当前核对凭据，不暴露原订单内部 ID；`admin.refunds.review` 经 `refunds.write` 执行，运营仅有读取权。事务和金额规则继续复用 commerce、refunds、order-state |
| `lib/commerce.js`、`lib/order-state.js`、`lib/refunds.js` | 报价与下单、库存预约/占用/释放、运费与配送时段解析；订单状态机；退款申请、审核与确认 | `refundReviewToken` 关联申请与原订单关键字段，审核事务内复核状态、付款、金额、当前待审申请和凭据，并与审计同成同撤；批准仅进 `processing`，渠道通知成功后才进 `succeeded`。供入口拼团流、顾客订单与运营模块共用；金额与状态流转仍在服务端裁决，幂等依赖稳定文档 ID |
| `lib/admin-operations-actions.js` | 价格、客户企业审核、仓库库存、配送、营销和订单履约动作 | 注入 getAdmin、audit、mediaUrlResolver；企业申请列表返回关键资料的 `reviewToken`，`admin.businessApplications.reviewDetail` 经 `organizations.read` 授权返回详情与两张临时预览地址（不暴露云文件 ID），审核事务核对当前申请与页面所见凭据，过期返回 `BUSINESS_APPLICATION_CHANGED`；通过/驳回在文档事务内更新客户和申请并写审计，新企业用统一社会信用代码摘要的稳定文档 ID，旧企业仍复用原 ID。本地审计失败回滚、过期拒绝及模拟地址已测，真实 CloudBase 临时地址、浏览器取图和并发仍待验。库存调整在事务内用稳定操作凭据去重，相同凭据但仓库/规格/数量/原因/操作者不一致时返回 `IDEMPOTENCY_CONFLICT`；价格 `validFrom/validTo` 校验起止顺序；运费 `customerType` 限空/个人/企业，`priority` 须为整数，生效日期须合法且不倒置；时段有效日期须合法，编辑省略 `capacity`/`sort` 时保留已有记录，容量目前未用于订单限单。后台表单负责原值回填、中文范围选择和北京时间输入；`admin.demo.seedCommerce` 为演示专用直写（demoMode＋超管通配双门），绕过核对门，生产不开启 demoMode 时不可达 |
| `lib/api-values.js` | 字段读取、分页、时间及公开/脱敏字段投影 | 无运行期管理员或顾客会话；供入口和动作模块共享 |
| `lib/response.js`、`lib/collection-read.js`、`lib/transaction-ids.js` | 响应包装与统一错误、分页扫描加谓词过滤的列表读取、订单/库存/退款/拼团成员等稳定幂等文档 ID | 无业务状态，供入口和各模块共用 |
| `lib/catalog-import.js` | 商品/规格编码对应、导入草稿和冲突检查 | 导入不自动上架，保留来源行及错误 |
| `lib/catalog-review.js` | 汇总商品上架条件、生成核对结果和明确发布 | 调用库存、配送、个人端价格覆盖及依赖快照模块；发布时仍由服务端裁决；`read` 支持注入只读 store 覆盖，被商品核对发布与 SKU 上架门两处复用 |
| `lib/catalog-price-coverage.js`、`lib/catalog-stock-review.js`、`lib/catalog-delivery-review.js` | 分别核对个人端有效价格、可售库存及配送条件 | 供商品核对模块调用；不把本地检查等同真实云端可下单 |
| `lib/review-dependencies.js` | 记录核对所依赖的数据，用于发布时发现已变化的资料 | 新增依赖的并发变化和真实云事务仍待验证 |
| `lib/catalog-readiness.js` | 商品基础上架条件与有效价格的基础校验 | 商品级直改 `on_sale` 两条路径已被 `CATALOG_REVIEW_REQUIRED` 拦截到核对页，本模块现仅作兜底校验保留 |
| `lib/content-targets.js` | 内容跳转目标（商品/分类）的可用性校验与保存前拦截 | 公开内容流与内容保存动作共用，复用受众可见规则 |
| `lib/admin-media-chunks.js` | 4–24 MB 媒体分段上传 | 本地接口测试覆盖超过 100 条历史任务后的重复文件复用与中断续传；真实云端续传未验收 |
| `lib/admin-media-direct.js`、`lib/cloud-media-storage.js` | 24–100 MB 视频的工作人员凭据申请、浏览器直传后服务端流式核对；云存储适配 | `admin.media.beginDirectUpload/finishDirectUpload` 校验登录、单文件路径、文件大小/摘要/视频格式，未校验文件不得登记；`config.js` 默认关闭前端入口，真实云存储凭据、CORS、20 秒函数超时未验收；见 `docs/FR-MEDIA-DIRECT-01-本地验收.md` |
| `lib/pricing-targets.js` | 价格适用对象的可读选择与校验 | 最终价格仍由服务端决定 |
| `lib/offline-receipts.js` | 企业线下订单收款流水、已收/待收计算、幂等与审计 | 收款状态独立于履约状态；本地内存测试不证明真实到账或云事务 |
| `lib/staff-accounts.js`、`lib/staff-policy.js` | 两类工作人员账号、角色权限、密码和手机号验证状态 | 手机号无真实短信验证时保持未验证；旧账号资料保留 |
| `lib/staff-write-guard.js` | 账号写操作的会话/权限复核、最后可用超管保护及原子写入边界 | 云端并发与事务冲突尚未实测 |
| `lib/admin-audit-feed.js` | 为 `admin.audit.list` 的当前页补充操作人姓名、当前角色和可识别的操作对象名称 | `app.js` 先校验 `audit.read`，按 `createdAt` 倒序分页；只在已授权读取时按页查名称，不返回手机号明文。原始审计字段仍保留供折叠排查；旧记录缺对象时明确标记不可用，不伪造历史姓名或角色 |
| `lib/permissions.js`、`lib/security.js` | 共用权限判断、口令/令牌及敏感字段安全工具 | 服务端校验，不依赖页面隐藏按钮 |

三个主要动作模块返回原动作函数；`offline-receipts`、`staff-accounts` 等独立模块也由 `app.js` 组装并接入路由。主要业务模块由入口注入 `getAdmin` 和审计能力；工作人员写入口另经 `staff-write-guard` 复核，不能仅凭页面隐藏按钮授权。商品模块仅向运营模块提供媒体引用校验，不建立循环依赖。工作人员相关入口包括 `admin.staff.*`、`admin.password.change`；线下收款入口包括 `admin.orders.receipts.list/record`。

此前迁移与后续功能的本地测试结果分别记录在对应验收文件，不能把旧测试描述为本次重新运行。原待核对点“页面仍有单独 SKU 上架入口，可能绕过完整上架核对”已于 2026-09-24 解决：`admin.skus.setStatus` 与已有 SKU 经 `admin.skus.upsert` 转入 `on_sale` 的两条路径，现在强制复用 `catalog-review.read` 完整核对（`skuPreviewStore` 以拟写入状态参与核对读取），缺项返回 `PRODUCT_NOT_READY` 与全部中文缺项清单并引导到商品核对发布页；条件齐备的 `off_sale` 重启用保留；`admin.demo.seedCommerce`（demoMode＋超管通配双门）仍为演示专用直写。修复范围与本地验收证据见 `docs/FR-SKU-GATE-01-本地验收.md`。

后续新增逻辑优先放入相应业务模块；模块接近 800 行时继续按具体业务拆分，不能通过压行规避限制。
