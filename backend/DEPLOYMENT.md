# CloudBase 测试环境部署步骤

当前已确认并由小程序运行时使用的 CloudBase 环境为 `cloud1-d8gp843lt5454ada7`，仅按测试环境管理。本文件保留后续环境重建和剩余配置步骤。

## 1. 部署前准备

1. 按用途生成至少 32 位的随机密钥，仅保存到 CloudBase 函数环境变量：
   - `MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN`：只用于首次创建管理员。当前测试环境已经完成初始化，该变量应保持为空或移除；
   - `MENGSHIXIAN_PII_ENCRYPTION_KEY`：用于 AES-256-GCM 加密收货手机号，不能轮换后直接丢弃旧值。
   两者都不得写入仓库、网页配置、聊天记录或截图。
2. 复制 `cloudbaserc.example.json` 为本机私有配置文件，并通过环境管理界面或受控部署流程写入密钥。私有配置文件不要提交、不上传到静态托管，也不要放在小程序包内。
3. 发生密钥泄露时，先统计 `addresses`、`business_applications` 和未完成订单；确认没有需要旧密钥解密的数据后，清空旧环境变量并部署。存在历史密文时，必须先完成新旧密钥迁移，不能直接替换。
4. 按 `backend/cloudbase/SECURITY-RULES.md` 在 CloudBase 控制台检查数据库、云存储和函数访问规则。尤其禁止匿名网页直接写云存储。
5. 先运行本地测试：

```powershell
node backend/cloudbase/functions/api/test/app.test.js
```

当前测试环境的 PII 密钥已通过下列脚本配置。脚本默认只预演；`-Apply` 使用 Windows DPAPI 保存当前用户受保护副本，临时 JSON 在更新后立即删除，且不输出密钥：

```powershell
.\backend\scripts\configure-pii-encryption-key.ps1
.\backend\scripts\configure-pii-encryption-key.ps1 -Apply
.\backend\scripts\verify-cloud-readiness.ps1
```

若云端已存在密钥而本机受保护副本不存在或不一致，脚本会拒绝覆盖，防止历史密文永久失效。

## 2. 部署云函数

在 `backend/cloudbase` 目录，用已登录的项目本地 CloudBase CLI 部署：

```powershell
& 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  '..\..\.tools\cloudbase-cli\package\bin\tcb' fn deploy api --force --install-dependency true
```

部署是外部写操作。执行后必须记录云函数版本、环境 ID、部署时间、CLI 返回结果和回退方案到 `docs/变更记录.md`。

## 3. 创建首位管理员

当前测试环境已创建首位管理员，本节只用于新环境重建，不能在现有环境重复执行。

部署成功并确认函数环境变量生效后，在本地运行：

```powershell
$password = Read-Host '管理员密码（至少 12 位）' -AsSecureString
.\backend\scripts\initialize-admin.ps1 -BootstrapToken '<仅从安全渠道取得>' -Username '<账号>' -DisplayName '<显示名>' -Password $password
```

该动作只能执行一次。之后由现有超级管理员创建后续管理员；初始化令牌不能用于网页登录。若已保存收货地址，禁止在没有迁移方案的情况下直接更换或删除 `MENGSHIXIAN_PII_ENCRYPTION_KEY`，否则历史手机号将无法解密用于履约。

## 4. 导入商品草稿

当前 200 条草稿已审核启用，形成 14 个分类、200 个商品和 200 个 SKU；价格和媒体仍为空。新批次数据仍须先在后台网页登录并进入草稿层，或由有权限的运维人员使用 `stage-product-drafts.ps1` 分批导入，不得绕过审核直接覆盖正式商品。

## 5. 初始化履约与价格配置

首次允许用户结算前，至少通过后台完成以下配置：

1. 启用分类、上架 SKU 和商品；
2. 为每个可销售 SKU 设置生效的价格规则；
3. 新建启用仓库并录入库存；
4. 新建配送区域、关联仓库、设置生效运费规则；
5. 使用两个不同测试地址验证：配送范围内可报价，范围外返回拒绝。

未完成以上配置时，系统会拒绝报价/下单，而不会用零元、假库存或默认运费兜底。

## 6. 发布后台网页

`admin-web` 已作为独立静态站发布在 `/admin-test/`。后续发布时，`config.js` 可以保留环境 ID 与函数名，但不得写任何令牌、密码、API Key 或支付密钥。素材文件先由有环境权限的管理员经 CloudBase 控制台上传到 `public/` 路径，再在后台登记文件 ID；当前后台禁止匿名浏览器直传。

## 7. 原生小程序关联与数据源切换

1. 本项目是原生代码小程序，不使用“微搭低代码 → 小程序认证 → 扫码授权”的第三方代开发发布模式；该模式会改变版本管理路径，不作为本项目默认方案；
2. 由腾讯云主账号在账号中心发起微信公众平台绑定，并由目标小程序管理员微信扫码确认。普通“开发者”成员不能代替管理员完成该授权；
3. 绑定后在微信开发者工具/云开发流程中选择并关联或转换已有环境 `cloud1-d8gp843lt5454ada7`，保留现有云函数和数据；
4. 确认 AppID 已获该环境访问权后，将 `wechat-miniprogram/miniapp/services/config.js` 的 `cloudEnvId` 填为已关联环境并把数据提供方切换为 CloudBase；
5. 在微信开发者工具中编译并验证分类、商品、未登录隐藏价格、登录态和接口失败状态；
6. 验证通过后再上传体验版。未完成账号绑定和环境关联时不得提前切换，否则 `wx.cloud.init`/`wx.cloud.callFunction` 会出现环境权限错误。

切换前先运行只读预检；它会核对 AppID、本地仍保持 mock 的回退状态、远端 API 健康状态、分类/商品数据，以及小程序和网页两端首页轮播/模块和轮播素材解析是否可查询。该脚本**不能**替代微信管理员关联的人工确认，因此永远不会自动修改 `provider` 或 `cloudEnvId`：

```powershell
.\backend\scripts\verify-miniapp-cloudbase-cutover.ps1
```

输出中的 `miniProgramAssociation=manual-verification-required` 和 `cutoverAllowed=false` 是预期的安全状态。只有甲方管理员在微信侧完成关联、并在微信开发者工具真机/模拟器确认 `wx.cloud.init` 成功后，才可由受控变更将小程序切至 CloudBase。

在管理员关联前后，都可运行以下**只读**经营数据就绪报告。它只输出商品、媒体、价格、仓库、库存、配送和拼团的数量与阻塞项，不输出管理员密码、会话令牌或密钥：

```powershell
$credentialPath = Join-Path $env:LOCALAPPDATA 'MengshixianTest\test-admin.txt'
.\backend\scripts\verify-commerce-readiness.ps1 -CredentialFile $credentialPath
```

## 8. 回退

- 云函数：保留每次部署的版本记录；发生故障时回滚到上一已验证的云函数版本。
- 数据：商品、媒体、分类和内容使用状态/版本管理，避免删除历史记录。
- 静态后台：保留上次部署的静态文件版本，不用 `--prune` 清理未知文件。
