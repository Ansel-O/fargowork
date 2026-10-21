---
name: contract
description: 使用 FargoWork 为当前登录员工发起合同申请，按固定公司及汇率资料计算字段，上传合同正文并在本人确认后提交。
---

# 合同申请

升级后建议新开会话；继续当前会话时重新加载新版入口和本流程说明。草稿按[24小时复用与刷新](../../../references/WORKFLOW-DIRECTORY.md#办理行为)：首个可核对草稿起24小时，编辑不续期、提交不全量重查；过期或用户要求用 `refresh <draftId>`，保留输入、材料和回执，展示并确认实际差异。

从本文件位置向上三级确定包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements contract
node scripts/fargowork.cjs prepare contract --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

业务 JSON 可包含 `contract_name`、`contract_number`、`company`、`contract_type`、`content`、`counterparty`、`contract_amount`、`currency`、`payment_terms` 和 `remarks`。按 `needsInput.choices` 选择公司、合同类型和币种。公司候选来自固定公司目录；合同类型使用流程选项；币种和港币汇率来自固定汇率表。币种和金额的港币折算由脚本计算。各文字、金额字段遵循原表单可空规则，不编造合同内容。

合同正文为必需附件，使用 JSON 顶层 `attachments` 数组提供员工指定文件的绝对路径。盖章后的扫描件属于后续流程，不在此申请中上传。

展示最终预览中的合同信息、换算结果和正文文件名，然后停下等待员工对本次预览的新确认。确认后仅提交一次。若资料或汇率无法唯一核实，停止并请 Finance 核查；上传或提交结果未知时先核对，不重传、不重提。审批由宜搭流程处理，本 Skill 只发起合同申请。

只展示必要补充问题、业务预览、结果和确实影响办理的错误。不要收集隐藏审批人、查其他员工或替换固定表单目标。
