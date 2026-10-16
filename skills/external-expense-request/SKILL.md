---
name: external-expense-request
description: 使用 FargoWork 的 OpenYida 技能包为当前登录员工办理对外付款申请，核对公司、供应商、科目和项目，上传原生附件并在完整预览确认后提交。仅办理本包固定的对外付款流程。
---

# 对外付款申请

从本文件位置向上两级确定包根。首次使用按[入口 Skill](../../SKILL.md#首次安装)先安装官方 OpenYida CLI，再安装 FargoWork 附加包；后续复用官方登录态，无需注册 MCP。

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs login
node scripts/fargowork.cjs requirements external_expense_request
node scripts/fargowork.cjs prepare external_expense_request --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
node scripts/fargowork.cjs submit <draftId> --confirm <draftSha256>
node scripts/fargowork.cjs result <draftId>
```

先检查状态，仅在需要时引导本人登录。读取 `requirements`，收集是否项目付款、最晚付款日期、供应商、支付币种、付款明细和用户提供的附件。日期使用 `YYYY-MM-DD`，以状态中的 Asia/Shanghai 业务日期解释相对日期。每行明细包含 `description`、`amount`，可提供 `expense_category`、`account`、`remarks`；说明使用顶层 `description`。不编造付款事由、金额或附件。

将业务输入写入本地 JSON。附件使用顶层 `attachments: [绝对文件路径]`，本流程必须有附件；常用的 PDF、PNG、JPG、DOCX、XLSX 等格式以脚本核对原表单后的结果为准，每个文件不超过 20 MiB，最多 9 个。附件由脚本直接上传到当前固定宜搭表的原生附件控件，不安装或登录另一套附件服务，不粘贴下载链接充当附件。

调用 `prepare` 后合并询问 `needsInput` 中的选择。支付公司、供应商银行、币种、费用类别、会计科目、项目部门、部门主管和业务架构均以脚本查询结果为准。合同公司和主部门可能成为默认建议，须在最终预览中让用户核对；员工已经明确的公司、币种或科目冲突时不能静默替换。银行账号和开户行只有用户明确要求改用其他值时才填写 `bank_account`、`bank_name`。

项目付款按候选选择 `project_name`、`project_department_id`、`project_expense_category`，再核对明细科目。仅当用户要求关联已有合同或用印时，设置 `include_contract` 或 `include_seal`，从脚本返回的本人候选中选择对应 `contract_instance_id` 或 `seal_instance_id`；不能搜索其他流程、他人实例或任意输入关联 ID。

已有草稿补充资料、调整候选或附件时，使用 `prepare external_expense_request --input <文件> --draft <draftId>` 复用同一草稿。上传结果未知时停止，不自动重传。账号切换、跨日或业务内容改变后，必须重新核对预览；已提交或结果未知的草稿不能重新起草来重复提交。

准备成功后展示完整业务预览：付款公司、供应商、银行、币种、明细及合计、汇率、最晚付款日期、项目和部门、关联流程、附件文件名，以及脚本提示。取得一次明确确认后，使用该草稿的 `draftId` 和 `draftSha256` 提交。成功时只报告结果与流程编号；结果未知时先查 `result`，不要再次提交。

日常只向用户输出必要提问、最终业务预览、结果和必要错误说明，不输出执行日志、鉴权过程或分阶段测试报告。只使用本包脚本及固定对外付款流程；禁止通过 OpenYida 通用发现命令检索其他应用、隐藏表或测试流程，禁止自行编写 HTTP 调用、任意连接器或修改固定目标。权限和来源不足时停止，按 [DEBUG](../../references/DEBUG.md) 提供简短支持信息，不索取凭据。
