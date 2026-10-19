---
name: procurement-application
description: 使用 FargoWork 和官方 OpenYida 为当前登录员工办理正式采购申请，查询公司币种、汇率和联系人，上传采购附件，生成预览并在本人确认后提交。仅办理本包固定的采购流程。
---

# 采购申请

从本文件位置向上三级确定包根，在包根运行以下命令。首次使用按[入口 Skill](../../../SKILL.md#首次安装)先安装官方 OpenYida CLI，再安装 FargoWork 附加包；后续复用官方登录态，无需注册 MCP 或启动 FargoWork Server。

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements procurement_application
node scripts/fargowork.cjs prepare procurement_application --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

`login` 不属于常规办理序列。只有 `status` 明确要求登录时，才单独执行 `node scripts/fargowork.cjs login`，由员工完成官方授权。

**读取最终预览后必须停住，等待员工下一条明确确认。** 起初要求办理或提交，不代替看完预览后的确认。收到新确认后，才执行 `node scripts/fargowork.cjs submit <draftId> --confirm <本次preview返回的draftSha256>` 一次；需要回读时执行 `result <draftId>`。不要把准备、预览、提交合在一次命令里。

正常时仅展示脚本 `preview` 的用户业务内容，不展开隐藏字段、人员映射或可空提示。仅确实阻塞时按[资料检查](../../../references/CHECKS.md)协助处理。附件统一按[原生附件](../../../references/ATTACHMENTS.md)办理。

部门选择只向员工展示脚本提供的名称候选；`department_id` 等内部值由 Agent 从可信候选中对应填写，不要求员工提供或确认内部 ID。脚本没有候选时不猜值、不另查隐藏数据，按资料检查处理。

先检查状态，只有需要时引导用户本人登录公司账号。读取 `requirements procurement_application` 后，收集以下业务信息：

- `reason`：申请事由；不替用户编造。
- `purchase_method`：采购后报销或公司采购。
- `purchase_type`：行政采购、商务事务、IT采购或其他。
- `currency`：付款币种；按脚本返回的公司目录确认。
- `items`：每项包含 `name`、`quantity`、`unit_price`，可附 `specification`。
- 按需填写 `other_description`、`remarks`、`expected_delivery_date`；日期使用 `YYYY-MM-DD`。仅在用户要选择其他本人任职部门时填写 `department_id`。
- 用户明确要上传的本地附件，在 JSON 顶层使用 `attachments` 数组填写文件绝对路径。附件可选，不扫描用户目录来寻找附件。

将用户提供的信息写入本地 JSON，再运行 `prepare`。申请人、申请日期、办公地点、行政与 IT 联系人、汇率、小计、合计和港币金额由脚本核实及计算，不猜测或在输入中覆盖内部字段。缺信息时合并询问 `needsInput` 中的问题；补充后使用同一输入文件和 `--draft <原draftId>` 更新草稿，不另开一份重复草稿。尚未返回 `draftId` 时不传该参数。

准备成功后运行 `preview`，向用户展示最终业务内容：事由、方式和类型、采购明细、币种及合计、港币换算、部门、交付日期、备注和附件名称。只有脚本因必需资料问题阻断办理时，才按[资料检查](../../../references/CHECKS.md)请员工协助，不混入成功草稿预览。**完整预览之后取得一次明确的提交确认**，随后只提交该 `draftId` 及其 `draftSha256`。内容变更、跨日或账号切换须重新准备并确认。

提交成功只报告结果和流程编号。用户不需要安装阶段报告、调用日志、鉴权细节或工具测试报告；日常只展示补充信息的问题、最终业务预览、结果及必要错误说明。结果未知、超时、草稿锁定或上游拒绝时，按错误码停止；可运行 `result` 检查已有状态，不能删状态、换草稿或重传附件来重试同一笔申请。

本 Skill 只办理固定正式采购申请；不得自动换成采购示例。即使 OpenYida 能检索到其他表，也禁止搜索、枚举或替换目标，禁止自行编写 HTTP 请求、调用任意连接器、查询其他员工或修改流程配置。隐藏表、旧流程和未交付流程都不属于可选入口。权限或资料不足时停止并说明，诊断按 [DEBUG](../../../references/DEBUG.md) 处理，不要求用户提供 token、Cookie 或密钥。
