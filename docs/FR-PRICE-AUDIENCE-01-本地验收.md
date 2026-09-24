# FR-PRICE-AUDIENCE-01 价格列表适用对象名称

状态：LOCAL_DONE（2026-09-23）。仅友方后台本地修改；未提交、推送、部署或写入线上业务数据。

问题：价格编辑框已经能按名称选择适用对象，但价格列表仍直接显示`客户类型 c`、`企业 org-a`等内部编号，普通运维难以核对面向谁生效。

改动：`admin-pricing-targets.js`复用既有`admin.pricingTargets.list`读取当前价格规则涉及的客户类型、企业、会员等级或指定顾客的可读名称；`app.js`在价格页加载后交给`admin-tables.js`展示。查不到或读取失败时显示明确待核对提示，不回退展示内部ID。金额仍以元显示；服务端金额规则未改。

验证：在隔离Edge用模拟资料先复现列表显示内部编号的失败断言，修复后`node test/import-browser.test.cjs`通过，列表显示“个人顾客（C 端）”和“甲方门店”，不再出现`org-a`。完整`node test/import-browser.test.cjs --actual-catalog --actual-catalog-media --actual-catalog-ready`复测通过；业务API为本地实际`app.dispatch`配内存存储，不是云端。`node --test test/*.test.js backend/cloudbase/functions/api/test/*.test.js`为45项通过、0失败；`git diff --check`及受影响JS语法检查通过。最大改动文件`app.js` 678行，小于800行。

边界：云端性能、真实数据中的旧失效对象和小程序可见性未验收；营销仍按用户决定暂缓。保留所有其他未提交修改与既有回退点。
