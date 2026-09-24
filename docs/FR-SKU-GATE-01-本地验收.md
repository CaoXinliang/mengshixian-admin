# SKU 上架旁路修复：本地验收记录

日期：2026-09-24。任务来源：`OPERATIONS-USABILITY-PLAN.md` 顶部恢复施工第一项——核对并修复页面单独"SKU 上架"入口绕过完整上架核对的问题。仅本地实现与验证，未提交、未推送、未部署、未写友方云业务数据，未修改小程序前端与个人线。

## 缺陷（修复前已执行证实）

- 商品级直改 `on_sale` 的两条路径（`admin.products.upsert` 带状态、`admin.products.setStatus`）均被 `CATALOG_REVIEW_REQUIRED` 拦截、强制走核对页；但 `admin.skus.setStatus` 与已有 SKU 的 `admin.skus.upsert` 改状态到 `on_sale` 仅检查规格编码与任意生效价格，绕过个人端价格覆盖、库存、配送、包装单位、主图与核对依赖指纹。
- 旧测试 `app.test.js` 原第 272-273 行断言"有价格即可直接上架成功"，把旁路固化为预期行为。
- 风险窗口：已核对发布的商品下，新规格或重启用规格可绕过全部门槛直接对顾客可见（顾客端目录与下单路径均要求"商品 on_sale 且 SKU on_sale"）。修复前用真实代码＋内存适配器执行证实：正规核对发布商品后，仅配 Web 渠道价格、无库存无配送无包装单位的规格一次 `setStatus` 即上架成功，匿名顾客目录立即可见，而同一时刻完整核对为不通过并列出四类缺项。

## 修复内容

- `backend/cloudbase/functions/api/lib/admin-catalog-actions.js`：新增 `skuPreviewStore`（以拟写入状态参与核对读取，只代理 `catalog-review.read` 实际触达的 findOne/list）与 `requireSkuReviewReady`（复用商品核对页同一套完整核对，不通过即 `PRODUCT_NOT_READY` 并返回全部中文缺项与核对页引导）；`adminSetSkuStatus` 与 `adminUpsertSku` 已有分支转入 `on_sale` 前强制过门；构造参数新增 `catalogReview`，由 `backend/cloudbase/functions/api/app.js` 注入。
- 合法通道保留：条件齐备的 `off_sale` 规格可重新启用，未一刀切禁止 SKU 状态修改；`admin.demo.seedCommerce` 演示种子（demoMode＋超管通配双门、无前端调用方）维持原状。
- 前端：`admin-tables.js` 规格行增加"核对发布"链接（`product-review.html?code=<商品编码>`，模式同导入表既有先例）；`admin-operations-confirm.js` 上架确认文案改为明确"服务端将重新执行完整上架核对，缺项时会被拒绝并提示补齐"。

## 测试证据（2026-09-24 实际运行）

- 新增 `backend/cloudbase/functions/api/test/sku-publish-gate.test.js`：修复前运行失败（旁路成功，先红），修复后通过（后绿）。覆盖：缺库存/配送/包装单位/个人端价格覆盖的规格经 `setStatus` 与 `upsert` 两条路径均拒绝且消息含四类缺项；拒绝后状态仍 draft（无部分写入）；顾客端不可见；缺主图场景拒绝原因含"主图"；补齐后上架成功且顾客可见；`off_sale → on_sale` 重启用成功。
- `app.test.js`：原 272-273 行改为拒绝断言＋无部分写入检查；商品级强制核对、发布并发篡改拒绝、正式核对发布提升等原有断言全部保留并通过。
- 定向 10 个测试文件通过；全量 `node --test test/*.test.js backend/cloudbase/functions/api/test/*.test.js` 46 个文件通过、0 失败；`git diff --check` 通过；全部改动 JS `node --check` 通过；改动文件行数最大 724（app.test.js），均低于 800 行上限。
- 隔离 Edge 浏览器：`node test/import-browser.test.cjs --actual-catalog --actual-catalog-media --actual-catalog-ready` 全链通过，含新增 `test/sku-gate-browser.cjs`（挂于发布链之后）：页面实点"上架"→ 缺项拒绝提示含库存/配送与商品核对发布页引导、规格状态不变；经实际 API 补齐包装单位、个人端价格与库存后再点 → "SKU 已上架。"；顾客接口可见新规格；页面下架→再上架成功。既有链路（交付 XLSX→草稿→素材→价格→库存→配送→核对发布→顾客报价）回归全部通过。

## 仍未验收的边界

- 以上均为本地内存 API 与隔离浏览器结果：友方云端事务/并发、真实云存储、长视频、短信真实验证、实际小程序可见性仍未验收；工作人员手机号仍如实显示"未验证"。
- `admin.demo.seedCommerce` 仍为绕过核对的演示专用直写入口（demoMode＋`'*'` 双门）；生产不开启 demoMode 时不可达。
- 营销与复杂企业采购仍暂缓；企业价与个人价关系未定，未合并、未编造价格。
- 本轮未提交、未推送、未部署。回退方式为定向撤销本节所列文件改动（`admin-catalog-actions.js`、`api/app.js` 注入参数、`admin-tables.js`、`admin-operations-confirm.js`、`app.test.js` 272 区块、`operations-confirm.test.js` 断言、`catalog-actual-api-browser.cjs` 挂载行，及三个新增文件 `sku-publish-gate.test.js`、`sku-gate-browser.cjs`、本记录），不影响其他未提交修改与既有回退标签。
