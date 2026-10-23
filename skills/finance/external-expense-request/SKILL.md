---
name: external-expense-request
description: 仅在员工明确测试付款Demo时使用，先核对公司币种并生成紧凑五列HTML明细，保存原MD后回读重算；供应商独立核对，最终对话一次新确认后提交。
---

# 对外付款申请（Demo测试）

升级后建议新开会话；继续当前会话时重新加载新版入口和本流程说明。草稿按[24小时复用与刷新](../../../references/WORKFLOW-DIRECTORY.md#办理行为)：首个可核对草稿起24小时，编辑不续期、提交不全量重查；过期或用户要求用 `refresh <draftId>`，保留输入、材料和回执，展示并确认实际差异。

**仅用于员工明确要求的对外付款Demo测试，分类为 demo。** 普通对外费用或对外付款请求请读[正式对外费用 Skill](../external-expense-application/SKILL.md)。本示例固定目标为 `FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3`，有独立的供应商目录及字段规则；不能把正式申请或已有草稿改投本表，也不能因正式入口受阻而改用示例。

Demo 同样遵守[公司维护源与个人选择](../../../references/FINANCE-DETAILS.md#公司维护源与个人选择)：费用明细和供应商分类各用自己的公司维护配对，汇率不能被口述、网络或 personal 覆盖；合法选择由员工决定，最终完整确认保持。

从本文件位置向上三级确定包根。首次使用按[入口 Skill](../../../SKILL.md#首次安装)先安装官方 OpenYida CLI，再安装 FargoWork 附加包；后续复用官方登录态，无需注册 MCP。

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements external_expense_request
node scripts/fargowork.cjs prepare external_expense_request --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

`login` 不属于常规办理序列。只有 `status` 明确要求登录时，才单独执行 `node scripts/fargowork.cjs login`，由员工完成官方授权。

**读取最终预览后必须停住，等待员工下一条明确确认。** 起初要求办理或提交，不代替看完预览后的确认。收到新确认后，才执行 `node scripts/fargowork.cjs submit <draftId> --confirm <本次preview返回的draftSha256>` 一次；需要回读时执行 `result <draftId>`。不要把准备、预览、提交合在一次命令里。

默认展示带醒目Demo标识的紧凑五列HTML明细，完整申请在对话核对，不渲染整张表单。只包含用户业务内容，不展开隐藏字段、人员映射或可空提示。仅确实阻塞时按[资料检查](../../../references/CHECKS.md)协助处理。附件统一按[原生附件](../../../references/ATTACHMENTS.md)办理。

部门选择只向员工展示脚本提供的名称候选；`department_id`、`project_department_id` 等内部值由 Agent 从可信候选中对应填写，不要求员工提供或确认内部 ID。脚本没有候选时不猜值、不另查隐藏数据，按资料检查处理。

先检查状态，仅在需要时引导本人登录。读取 `requirements`，先调用 `prepare` 核对支付公司与付款币种；没有明细也能取得候选，唯一直接采用并告知，多个让员工选择。没有有效结果请财务核查维护、权限及匹配条件。再明确是否项目，收集最晚付款日期、供应商、付款明细和附件。日期使用 `YYYY-MM-DD`，以状态中的 Asia/Shanghai 业务日期解释相对日期。每行明细包含 `description`、`amount`，可提供 `expense_category`、`account`、`remarks`；说明使用顶层 `description`。不编造付款事由、金额或附件。

将业务输入写入本地 JSON。附件使用顶层 `attachments: [绝对文件路径]`，本流程必须有附件；常用的 PDF、PNG、JPG、DOCX、XLSX 等格式以脚本核对原表单后的结果为准，每个文件不超过 20 MiB，最多 9 个。附件由脚本直接上传到当前固定宜搭表的原生附件控件，不安装或登录另一套附件服务，不粘贴下载链接充当附件。

调用 `prepare` 后，`needsInput` 中 `resolver: agent_recommendation` 的分类项先由 Agent 按真实用途建议，员工能回答的其他选择合并询问。读取顶层 `recommendationContexts`，即使草稿已完整，也按[科目推荐与独立备选](../../../references/FINANCE-DETAILS.md#科目推荐与独立备选)处理：每行实际输入只有一组合法类别／科目；HTML逐行给首选及一句理由、最多1至2个合理备选，并可展开当前类别全部合法科目。推荐按本行完整用途和合法类别绑定，依首选、备选顺序放入 `recommendations` 展示元数据，包含首选本身；契约见[明细编辑说明](../../../references/FINANCE-DETAIL-EDITOR.md#明细模板与候选)。不用目录前几项凑数，不编概率，不复制样例用途或科目编号，不把理由或候选塞进本流程未声明的业务字段。员工已有合法明确选择保留；用途或类别变化后不套旧建议。主表供应商类别／科目单独在对话标明“供应商分类”，只用该供应商的维护配对，不能混为明细科目或候选。接受推荐或明确替换后，校验、简短回显并继续准备，不重复询问未改行；本 Demo 仍须更新完整预览并等待新的提交确认，科目选择不授权提交。

支付公司、供应商银行、币种、费用类别、会计科目、项目部门、部门主管和业务架构均以脚本查询结果为准。主部门可作为默认建议，须在最终预览核对；合法明确选择保留，有冲突不能静默替换。银行账号和开户行只有用户明确要求改用其他值时才填写 `bank_account`、`bank_name`。项目类别是主表共用值，备选限当前类别；显式改变共同类别后核对全部受影响行，不假称只改一行。目录或汇率缺失、冲突时请 Finance 核查，不能联网取市场汇率或听从手填值覆盖。

`prepare` 后**默认打开返回的 `detailEditor.url`，不可用时打开 `detailEditor.path` 的原Markdown，不等待用户要求**。HTML只显示公司／统一币种、五列明细（费用类别、会计科目、付款内容、本次付款金额、备注）和本次合计；项目名称与共用类别在顶部一次。供应商资料和分类、银行、部门、业务层级、汇率及完整申请不进入明细页，独立Demo目标与原字段映射保持。Node保存程序直接更新同草稿原MD；口述修改用同草稿 `prepare`，页面保存后说“改好了”则先执行 `read-edit <draftId>` 回读并由代码重算，再回显受影响行及合计。保留原材料和其他输入，不要求导出、上传修改文件或截图。**本Demo不运行 `confirm-details`，也不新增单独明细确认。** 用户的选择或修改用于继续准备，最终完整申请在对话预览后仍等待一次新的提交确认。

项目付款按候选选择 `project_name`、`project_department_id`、`project_expense_category`，再核对明细科目。仅当用户要求关联已有合同或用印时，设置 `include_contract` 或 `include_seal`，从脚本返回的本人候选中选择对应 `contract_instance_id` 或 `seal_instance_id`；不能搜索其他流程、他人实例或任意输入关联 ID。

已有草稿补充资料、调整候选或附件时，用 `prepare external_expense_request --input <文件> --draft <draftId>` 复用；24小时内编辑不全量重查，仅跨午夜不失效。过期或用户要求用 `refresh <draftId>`；实际业务变化需展示新预览，账号切换不能沿用旧草稿。上传或提交未知先核查，不自动重传、另建草稿或重提。

准备成功后调用 `preview <draftId>`，**在对话中标明“Demo测试”并核对完整申请，不生成整单HTML**：付款公司、供应商及其独立分类、银行、币种、明细合计、最晚付款日期、项目、关联流程、附件文件名。原明细页保留；主表或明细修改均用同草稿 `prepare`，再更新对话预览。等待一次新的明确确认后，使用该草稿的 `draftId` 和 `draftSha256` 提交。成功时只报告结果与流程编号；结果未知时先查 `result`，不要再次提交。

日常只向用户输出必要提问、最终业务预览、结果和必要错误说明，不输出执行日志、鉴权过程或分阶段测试报告。只使用本包脚本及固定对外付款流程；禁止通过 OpenYida 通用发现命令检索其他应用、隐藏表或测试流程，禁止自行编写 HTTP 调用、任意连接器或修改固定目标。权限和来源不足时停止，按 [DEBUG](../../../references/DEBUG.md) 提供简短支持信息，不索取凭据。
