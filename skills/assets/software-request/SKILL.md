---
name: software-request
description: 使用 FargoWork 和官方 OpenYida 为当前员工发起软件申请、更改或取消需求，上传原生附件并在最终预览得到本人确认后提交。
---

# 软件申请

升级后建议新开会话；继续当前会话时重新加载新版入口和本流程说明。草稿按[24小时复用与刷新](../../../references/WORKFLOW-DIRECTORY.md#办理行为)：首个可核对草稿起24小时，编辑不续期、提交不全量重查；过期或用户要求用 `refresh <draftId>`，保留输入、材料和回执，展示并确认实际差异。

从本文件向上三级确定完整包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements software_request
node scripts/fargowork.cjs prepare software_request --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

使用官方 OpenYida 当前本人登录，仅状态要求时登录，不注册 MCP。安装及统一规则见[入口](../../../SKILL.md)。

按员工表达填写业务 JSON：`request_type` 为“申请／更改／取消”，`system_name` 为系统名称，`involves_amount` 为“是／否”，`user_or_department` 为使用人或部门，`remarks` 为需求备注。两组选项均无预设答案，不替员工猜选；字段遵循原表的可空规则。

“是否涉及金额”不会生成额外金额、币种或采购明细问题，也不自动发起其他流程。“使用人或部门”只是文字，不是查询其他员工资料或更换发起人的授权。

可选附件使用 JSON 顶层 `attachments` 数组传员工指定文件的本地绝对路径，最多 9 件、单件 100 MiB，见[附件说明](../../../references/ATTACHMENTS.md)。补充时提供本次完整业务输入和附件清单，用 `--draft <原draftId>` 更新；不要另建重复申请。

办公场所、执行 IT 和 IT 主管由固定联动自动取得，不向员工展示或确认正常隐藏字段。只在问题确实影响办理时按[资料检查](../../../references/CHECKS.md)请员工协助。

展示最终业务预览及附件名后，**停下来等待员工下一条明确确认**。收到确认才执行 `node scripts/fargowork.cjs submit <draftId> --confirm <本次preview返回的draftSha256>` 一次。最初的“帮我提交”不替代预览后的确认；修改使旧确认失效。结果未知时用 `result <draftId>` 核对，不自动重传或重提。

正常只输出必要问题、业务预览、提交结果与编号，不输出调用日志或技术报告。本 Skill 只发起固定软件流程，不处理审批、任意人员查询或其他表单。
