# DEBUG

正常办理不输出日志或阶段报告。只有失败需要协助时，提供这三项即可：

```text
时间：YYYY-MM-DD HH:mm（Asia/Shanghai）
阶段：安装 / 登录 / 准备草稿 / 附件 / 提交 / 查询结果
错误码：复制脚本实际返回的 code
```

不要发送完整终端日志、请求或响应、登录地址栏、二维码、员工资料、业务 JSON、附件内容、token、Cookie、授权码、签名或密钥。Agent 也不应打开凭据文件排查。

| 错误类别 | 处理方式 |
| --- | --- |
| `NODE_22_REQUIRED`、`NPM_REQUIRED` | 需要 Windows 上的 Node.js 22 或以上及 npm；按公司 IT 规范安装，不提权或修改系统策略。 |
| `OPENYIDA_CLI_REQUIRED` | 按[官方说明](https://github.com/openyida/openyida)使用 `npm install -g openyida` 安装官方 CLI，再运行本包安装器。 |
| `SETUP_REQUIRED` | 按[入口 Skill](../SKILL.md#首次安装)先准备官方 OpenYida CLI，再从完整包根运行 `node scripts/setup.cjs`。 |
| `OPENYIDA_VERSION_UNSUPPORTED` | 当前已核验 `2026.7.14-2` 和 `2026.10.16` 的接入合同。记录已装官方 CLI 版本，交由维护者核对兼容性；不要跳过检查、静默降级或在本包内安装副本。 |
| `OPENYIDA_PROVIDER_UNAVAILABLE` | 官方 CLI 不可用，请维护者检查安装；不要猜凭据位置或复制登录文件。 |
| `OPENYIDA_WORKSPACE_UNAVAILABLE` | 默认停止。仅确认原绑定目录已经丢失时，从完整包根执行 `node scripts/setup.cjs --rebind-workspace --no-login` 显式恢复，核对返回的 `officialWorkingDirectory`、`workspaceRebound` 和 `identityReviewRequired`；随后运行本包 `status`，必要时本人登录，并由本人核对当前公司和账号后再办理新申请。不迁移旧草稿、不复制凭据；普通安装不要添加此恢复参数。 |
| `OPENYIDA_PROFILE_REQUIRED` | 仅在支持多账号配置的新版官方 CLI 返回此错误时处理；旧版 `2026.7.14-2` 不执行这些命令。运行 `node scripts/setup.cjs --no-login` 获取 `officialWorkingDirectory`，在该目录用官方 `openyida auth profiles --json` 查看已有账号配置，让本人选择后执行 `openyida auth profile switch <auth_profile>`，再重新运行本包命令。不猜账号、不展示完整认证输出。 |
| `OPENYIDA_LOGIN_REQUIRED`、`LOGIN_NOT_COMPLETED`、`BROWSER_OPEN_FAILED` | 运行本包 `login`，由本人完成登录；失败时提供时间、阶段和错误码。不要复制登录链接中的参数。 |
| `COMPANY_MISMATCH`、`ROSTER_IDENTITY_MISMATCH` | 停止本次办理，确认使用了正确公司的账号。不要修改身份或继续使用旧草稿。 |
| `UPSTREAM_ACCESS_DENIED` | 让管理员核对当前账号及既有数据源权限。不要换账号试探、扩大权限或改用其他入口。 |
| `WORKFLOW_SCHEMA_CHANGED`、`WORKFLOW_OPTIONS_CHANGED`、`DEPARTMENT_DETAIL_MISMATCH` | 流程或资料与包内规则不一致，交由维护者更新；不要跳过校验。 |
| `ANNUAL_BALANCE_NOT_UNIQUE`、`CONTACTS_NOT_FOUND`、`DEPARTMENT_MANAGER_MISSING` | 请 HR 或管理员核对相关配置，不能由用户手填内部结果。 |
| `INSUFFICIENT_BALANCE`、`NONPOSITIVE_LEAVE` | 按实际业务情况调整请假日期或时段，再重新预览确认。 |
| `ATTACHMENT_EXTENSION_NOT_SUPPORTED`、`ATTACHMENT_LOCAL_ABSOLUTE_PATH_REQUIRED` | 检查文件格式和本地绝对路径。支持 PDF、PNG、JPEG、GIF、WebP、TXT、DOCX、XLSX、PPTX；最多 9 件，单件 20 MiB。 |
| 提交或附件上传结果不确定 | 停止写操作，用现有草稿运行 `node scripts/fargowork.cjs result <draftId>`。不要重新提交、另建草稿或自动重传。 |
| 其他错误码 | 保留实际错误码和上述三项信息交给维护者，不打印完整响应来猜原因。 |
