# FR-MEDIA-DIRECT-01｜大视频受控直传本地验收（未开放）

日期：2026-09-24。范围仅友方后台与必要 API；不涉及小程序前端、个人线、云端业务数据或部署。

## 当前结果

- 日常素材库仍显示和执行 **24 MB** 上限。`config.js` 的 `largeVideoUploadEnabled` 默认为 `false`；本地测试显式打开后，视频可走 24–100 MB 新路径。真实友方云端从未用此新路径验收，因此不能对运营人员宣称 100 MB 已可用。
- 新路径分四步：管理员会话经服务端 `media.write` 校验 → 服务端生成唯一存储路径并为该路径申请临时上传凭据 → 浏览器向云存储上传（显示进度，失败有明确重试提示）→ 服务端从云存储流式核对大小、SHA-256 和视频文件头，成功后才返回文件 ID。凭据在真实云端是否严格限于该路径仍待验证。登记素材、关联商品、发布仍是后续独立步骤；未校验的直传文件不能通过素材登记或新建版本入口。
- 同一工作人员再次选择相同文件：已校验的复用；未完成的沿用同一任务，先尝试核对云端是否已经收齐，未收齐才从头重传。直传**不是分段断点续传**；4–24 MB 的旧分段路径维持原有续传行为。新文件使用随机独立路径，不覆盖历史素材。

## 本地证据

- `backend/cloudbase/functions/api/test/admin-media-direct.test.js`：登录限制、服务端生成路径、30 MB 任务重试/去重、未上传与未校验拒绝登记、大小/摘要不符与伪装视频拒绝、失败重试、HTTPS 凭据和取票失败提示。按测试先失败、再实施修复。
- `backend/cloudbase/functions/api/test/cloud-media-storage.test.js`：模拟 CloudBase 上传元数据及分块可读流，核对大小、SHA-256 与 MP4/MOV 容器头；不连接真实 COS。
- `test/media-chunk-client.test.js`：模拟浏览器到 COS 的表单 POST，验证 30 MB 直传进度、完成复用、重试时先核对云端；默认关闭时不会发起上传。
- `test/import-browser.test.cjs --actual-catalog --actual-catalog-media --actual-catalog-ready`：隔离 Edge 验证素材页默认 24 MB 提示、本地测试开关下 30 MB 视频可以走到登记确认并可取消；原商品整链复测通过。此测试的大视频上传由页面模拟接口承接，**没有实际上传 30 MB 到云端**。
- 全量自动化命令：`node --test test/*.test.js backend/cloudbase/functions/api/test/*.test.js`，48 项通过；受影响 JS 语法检查、`git diff --check` 与文件行数检查另行执行。

## 开放前必须另行验证

既有测试服记录显示云函数 Nodejs16.13、超时 20 秒；100 MB 下载校验能否在该时限内完成尚未知。需要得到无声的海的另行许可后，才可在友方测试环境核对：CloudBase 的上传元数据/临时凭据、静态托管域名的 CORS、30 MB 与接近 100 MB 真实视频、网络中断/完成后重试、格式错误、登出后旧会话和云存储孤儿文件清理。只有全部通过并明确允许更新测试服时，才能考虑把开关改为启用；不能仅以本地模拟放行。CloudBase 的[上传元数据说明](https://docs.cloudbase.net/api-reference/openapi/storage)、[Web 上传与安全域名说明](https://docs.cloudbase.net/api-reference/webv1/storage)为实现参考。

回退只需定向撤销本次直传模块、路由、浏览器客户端、配置开关与对应测试/文档；不触碰智谱已提交成果、旧回退标签或其他未提交修改。本次无提交、推送、部署和友方云业务写入。
