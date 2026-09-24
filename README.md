# mengshixian-admin
梦食鲜小程序管理后台

统一后台按运营人员的工作方式组织为八个一级业务模块：工作台、商品中心、订单中心、库存配送、客户中心、内容运营、营销中心和系统管理。原有细分功能作为模块内页签保留，不再平铺成一级菜单；工作台待办卡可直接进入相应处理页面。

## 入口

- `index.html`：唯一后台入口，登录后显示今日经营待办。
- `product-workflow.html`：商品中心内的分步骤编辑页；原简单后台已移除。

## 页面架构

后台保留 21 个独立 HTML 页面，不以单页面切换模拟路由。页面身份与八个业务分组统一定义在 `admin-page-registry.js`；侧栏、页头和页面搜索由 `admin-shell.js` 挂载，视觉规则在 `admin-shell.css`。通用专业编辑表单集中在 `admin-forms.js`，配送区域页保留专用区域选择器变体；商品分步骤编辑单独成页。

`app.js` 只协调鉴权、按页加载、操作绑定和刷新；业务表格在 `admin-tables.js`，工作台数据在 `admin-overview.js`，业务页只读摘要在 `admin-page-summary.js`。商品编辑的数据写入、顾客视角模拟与页面交互分别在 `admin-product-data.js`、`admin-product-preview.js`、`admin-product-workflow.js`；订单和库存引导也各有独立模块。新增逻辑先归入对应模块，单个页面脚本达到 800 行前继续拆分，不把功能重新堆回总入口。

工作台与摘要仅展示当前已加载的后台数据；没有独立接口的财务、迁移等草稿概念不显示为可用功能。价格、库存、订单状态和权限仍由服务端裁决。前端契约测试运行 `node --test test/*.test.js`，CloudBase API 测试运行 `node --test backend/cloudbase/functions/api/test/*.test.js`。

本地修改前的回退点是 Git 标签 `friend-admin-before-next-change-2026-09-23`。当前改动未提交、未推送、未部署；回退时应先核对工作区未提交内容，避免覆盖之后的新修改。

本仓库包含管理后台前端和它依赖的 CloudBase 后端。页面通过 `config.js` 连接梦食鲜测试 CloudBase 环境的 `api` 云函数；管理员密码、云端密钥和本机凭据不保存在仓库中。

## 后端与测试

- `backend/`：CloudBase API、交易规则、数据库适配、部署脚本和后端测试。
- `test/`：管理后台前端契约测试。

仓库不包含云端环境变量值、管理员密码或本机 DPAPI 凭据。

2026-09-12 15:52 cxl 修改了readme.md
