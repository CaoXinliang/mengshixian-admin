# 测试服部署与真实云验收记录

日期：2026-09-24。经无声的海授权（"测试服真实验证后台流程"），首次将本地整改成果部署到友方测试 CloudBase 环境 `cloud1-d8gp843lt5454ada7` 并做真实云验证。仓库工作区仍未提交（HEAD 仍为 bee9954，回退标签未动）；小程序前端与个人线未动。

## 部署内容与范围

- **api 云函数代码更新**（仅代码，配置原样保留）：运行时仍为 Nodejs16.13、超时 20s、环境变量（初始化令牌/PII 密钥/demoMode=true）未改动；函数 ModTime 变为 2026-09-24 08:10:51，代码体积 4957345→5001795 字节，CodeInfo 与工作区 `backend/cloudbase/functions/api/index.js` 完全一致。包含：SKU 上架完整核对门、工作人员账号体系、线下收款、表单易用性整改等本轮全部成果。
- **静态托管 `admin-test/` 前缀全量更新**：74 个文件（21 个 HTML＋全部 JS/CSS＋assets），含新增的 product-workflow/product-review/admin-staff-page 等模块；删除废弃的 simple.html/simple.js/session-policy.js/_test_full.js/_test_review.js。访问地址：`https://cloud1-d8gp843lt5454ada7-1483924869.tcloudbaseapp.com/admin-test/`（CDN 有数分钟缓存，调试可加随机查询参数）。
- **数据库**：补建缺失的 `order_receipts` 集合（收款流水写入路径必需，此前云端没有）；其余 49 个集合已存在，未动既有数据。

## 真实云验证结果（全部实际执行）

部署前后各跑一轮，全部通过：

1. **登录与会话**：demo_owner 真实登录成功；`admin.me` 正常；`admin.logout` 后旧令牌重放被拒（`ADMIN_SESSION_EXPIRED`）；未登录直调写接口被服务端拒绝。
2. **SKU 上架门在真云生效**（新代码行为鉴别）：创建明确标记的测试商品（CLOUDGATE-* 前缀，名称含"勿用"）→ 缺主图/库存/配送/包装单位的规格带有效公开价直改上架 → **被拒（PRODUCT_NOT_READY）且错误消息完整列出主图/库存/配送/包装单位四类缺项**，库中状态仍为 draft（无部分写入）；补真实主图后再试 → 仍因库存/配送被拒。共 17 项断言 ALL-PASS。测试数据已清理：商品归档、价格停用。
3. **真实云存储上传**：经 api 函数 `admin.media.upload` 上传 70 字节临时 PNG 成功，返回 `cloud://` 文件 ID 并登记为 temporary/demo 素材（该素材留在素材库，体积可忽略）。
4. **托管可达性**：login/index/products/product-review/product-workflow 等页面与关键 JS/CSS 全部 HTTP 200。

验证通道：MCP（部署/集合/托管）＋ 工作区自带 tcb CLI（借用冰品商城仓库 `.tools/cloudbase-cli`，只读借用未改动）直调云函数；演示账号由无声的海直接提供，密钥未写入仓库、未出现在任何持久化输出，含凭据的临时脚本已删除。

## 仍未验收的边界

- 以上是测试环境验证，不是正式上线：真实支付/退款渠道未接（capabilities 中 paymentPrepare=false）、短信真实验证未接、实际小程序端到端可见性未验（仅服务端接口验证）、长视频大文件上传未实测。
- 云函数运行时仍为 Nodejs16.13（cloudbaserc.json 写 20.19）；本次刻意不换运行时，如需升级另行验证。
- 云端数据库已有真实演示数据（51 商品/32 订单/4386 审计日志等），本轮验证只新增了明确标记的测试数据并已清理主要痕迹（归档商品、停用价格、一枚 70 字节临时素材、审计日志中的验证记录——审计记录按设计保留）。
- 仓库代码仍未提交未推送；云端部署内容=当前未提交工作区快照，若工作区后续变动需重新部署才能同步。
- 回退方式：重新部署 09-23 16:55 版本的函数代码与 admin-test/ 旧文件即可（git 标签 `friend-admin-before-next-change-2026-09-23` 对应时期快照可作参考基线）；order_receipts 集合为空集合，无需回退。
