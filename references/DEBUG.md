# DEBUG

员工可见的进度和失败说明遵循[入口沟通规则](../SKILL.md)：只讲业务现象、影响和下一步，失败不自动开启技术报告。以下命令和错误码供 Agent 与维护者排查，不直接转贴给员工。

仅在维护者主动排查或用户明确要求技术说明时，提供时间（Asia/Shanghai）、阶段、版本、实际错误码及必要的表单／实例编号。不发送完整日志、业务 JSON、附件内容、员工资料、登录地址栏、二维码、凭据、Cookie、授权码或签名。

只有用户主动提供实例用于排查且官方能力可用时，才核验该实例；所属表单按官方回读的 `formUuid`／`modelUuid` 确认，不凭 ID 前缀或对话猜成报销单等其他记录。员工账号无法读取时，只说明“暂时未能核实”。普通办理不为此额外查询实例。

| 情况 | 处理 |
| --- | --- |
| `NODE_22_REQUIRED`、`OPENYIDA_CLI_REQUIRED`、`SETUP_REQUIRED` | 按[入口 Skill](../SKILL.md)安装 Node.js 和官方 OpenYida，再从完整包根运行安装器。遵循公司 IT 规范，不提权或修改系统策略。 |
| `OPENYIDA_VERSION_UNSUPPORTED` | 本版适配官方 `2026.10.16` 和 `2026.10.19`。记录现有版本，请维护者判断升级或兼容；不跳过检查或静默降级。 |
| `OPENYIDA_PROFILE_REQUIRED` | 用官方 `openyida auth profiles --json` 查看已有账号配置，由本人选择并执行 `openyida auth profile switch <auth_profile>`。不猜选账号、不复制凭据。 |
| `OPENYIDA_LOGIN_REQUIRED`、`LOGIN_NOT_COMPLETED` | 通过本包 `login` 调用官方登录，由本人授权；已有有效登录时直接复用。不要循环重试扫码。 |
| `OPENYIDA_ENVIRONMENT_UNSUPPORTED`、`COMPANY_MISMATCH`、`IDENTITY_CHANGED` | 停止当前操作，核对官方选定的公司和账号。本包接受官方根域名或本公司的已知租户域名，不允许任意配置目标地址。切换账号后不能沿用原账号草稿。 |
| `OPENYIDA_COMMAND_FAILED`、`OPENYIDA_PROVIDER_UNAVAILABLE`、权限或格式错误 | 联系 IT，附阶段、版本和错误码。不打印完整响应、翻凭据文件、换身份试探或扩大权限。 |
| `PROCESS_PREVIEW_REQUIRED`、确认摘要不符 | 读取并展示当前草稿预览，停止操作，等本人下一条明确确认。旧授权、旧草稿和脚本读过预览都不代表本人已同意。 |
| `DRAFT_VERSION_CHANGED`、`DRAFT_REVISION_INCOMPLETE`、`PROCESS_DRAFT_EXPIRED`、`BUSINESS_FACTS_CHANGED_REPREPARE` | 对尚未提交的草稿重新准备并展示预览。升级前已经提交或结果未知的申请先查询原结果，不能另建申请重提。 |
| `OPENYIDA_TARGET_UNVERIFIED` | 官方写前校验未通过，本次未发送业务提交。请 IT 核对固定目标；不得搜索其他表单代替。 |
| `PAYMENT_COMPANY_NOT_FOUND`、`PAYMENT_SOURCE_MISSING` | 当前查询尚未取得可用的支付公司或财务资料，不代表记录未维护。由维护者核对读取权限、匹配条件和返回格式，确认实际原因后再分工；不要求员工新增记录或提供内部编码。保留材料、暂停提交；只读查询成功不代表草稿已保存。 |
| 组织或财务资料阻断 | 按[检查与求助](CHECKS.md)联系 HR、Finance 或 IT。正常可空字段不向员工提示。 |
| 附件失败 | 按[原生附件说明](ATTACHMENTS.md)处理；结果未知时禁止自动重传。 |
| 提交结果未知 | 保留草稿，执行 `node scripts/fargowork.cjs result <draftId>` 并核对宜搭已有申请。禁止自动重提或另建草稿规避。 |

`status: submitted` 表示已经取得明确的成功回执。`verificationStatus` 单独说明回读：`verified` 已核对、`partial` 部分字段未能判断、`unavailable` 暂时无法核对、`mismatch` 存在实际差异。后三者不撤销提交成功，也不允许重提。`attachmentVerification` 单独表示附件引用的核对结果，不代表当前下载及各端预览都已验收。

状态保存在当前用户的 `%LOCALAPPDATA%/FargoWorkOpenYida`。其中草稿包含个人业务信息，不属于可公开诊断日志；不要整目录上传或清空来重试。登录凭据仍由官方 OpenYida 管理，本包不另存凭据。旧版工作目录关联不再使用，不要复制或修改它来恢复身份。
