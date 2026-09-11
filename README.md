# mengshixian-admin
梦食鲜小程序管理后台

## 入口

- `index.html`：完整运营后台。
- `simple.html`：简单运营后台，与完整后台共用登录流程。

本仓库包含管理后台前端和它依赖的 CloudBase 后端。页面通过 `config.js` 连接梦食鲜测试 CloudBase 环境的 `api` 云函数；管理员密码、云端密钥和本机凭据不保存在仓库中。

## 后端与测试

- `backend/`：CloudBase API、交易规则、数据库适配、部署脚本和后端测试。
- `test/`：管理后台前端契约测试。

仓库不包含云端环境变量值、管理员密码或本机 DPAPI 凭据。
