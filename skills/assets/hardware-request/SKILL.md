---
name: hardware-request
description: 使用 FargoWork 和官方 OpenYida 为当前员工发起硬件申请，计算硬件明细并上传原生附件，展示草稿且等待本人确认后提交。
---

# 硬件申请

从本文件向上三级确定完整包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements hardware_request
node scripts/fargowork.cjs prepare hardware_request --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

复用已安装的官方 OpenYida 和本人登录；仅 `status` 要求时登录，不注册 MCP。包的安装及统一办理约束见[入口](../../../SKILL.md)。

业务输入：`items` 是 1–50 行硬件明细，各行可填 `name` 名称、`model` 建议型号、`purpose` 用途说明、`quantity` 数量、`unit_price` 单价；顶层可填 `currency` 币种及 `remarks` 需求备注。根据员工表达填写，不编造空缺内容；保留原表可空规则，金额由脚本按数量与单价计算。币种按脚本给出的公司汇率表候选选择，不自行查询其他表。

员工指定的附件使用顶层 `attachments` 数组传本地绝对路径，**不放在硬件明细行里**。最多 9 件、单件 100 MiB，具体类型遵循[附件说明](../../../references/ATTACHMENTS.md)。不扫描员工目录、不编写上传脚本。补充资料时保留本次完整明细及附件清单，用 `--draft <原draftId>` 更新同一草稿。

本人资料、办公场所、执行 IT 和 IT 主管由脚本自动处理。主管只按包内固定部门规则取得，不能从员工文字输入替换，不能用这个步骤查询其他人的花名册；正常隐藏字段不展示、不确认。真正影响办理的错误按[资料检查](../../../references/CHECKS.md)处理。

展示预览中的硬件内容、数量、金额、币种、备注及附件名，**然后停止，等员工下一条明确确认**。不得把准备、预览和提交放进同一脚本执行。收到本次预览后的确认，才运行 `node scripts/fargowork.cjs submit <draftId> --confirm <本次preview返回的draftSha256>` 一次。修改后重新预览；提交结果未知时用 `result <draftId>` 核对，不能换草稿重提或重传。

只报告必要问题、最终业务预览、提交结果及编号。此 Skill 仅发起固定硬件流程；后续审批由宜搭处理，不执行审批或选择其他流程。
