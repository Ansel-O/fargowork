---
name: annual-leave
description: 仅在员工明确要求年假Demo测试时使用固定年假示例入口；普通年假、其他正式假期及销假仍前往HR应用Moka。
---

# 年假申请（Demo测试）

升级后建议新开会话；继续当前会话时重新加载新版入口和本流程说明。草稿按[24小时复用与刷新](../../../references/WORKFLOW-DIRECTORY.md#办理行为)：首个可核对草稿起24小时，编辑不续期、提交不全量重查；过期或用户要求用 `refresh <draftId>`，保留输入、材料和回执，展示并确认实际差异。

**仅用于员工明确要求的年假Demo测试。** workflow key 为 `annual_leave`，分类为 demo，固定目标 `FORM-E0E2F1E273B7400F8CDEC9EF505B960EGPYE`。普通年假请求仍引导前往 HR 应用 Moka；不能因正式假期不可发起而切到本示例，也不能拿其他正式假期或销假资料改投本表。

从本文件向上三级确定完整包根。首次使用按[入口 Skill](../../../SKILL.md#首次安装)准备，之后复用官方 OpenYida 登录态，只在状态要求时引导本人登录：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements annual_leave
node scripts/fargowork.cjs prepare annual_leave --input <绝对路径UTF-8业务JSON>
```

由 Agent 整理员工明确提供的测试业务输入：`start_date`、`start_period`、`end_date`、`end_period`、`reason`；日期使用 `YYYY-MM-DD`，时段选择上午或下午。可选 `department_id` 只能从本人任职部门候选中对应，默认主部门；不让员工查内部编号，不传身份、年假余额、天数或原生字段。

仅查当前登录人的必要资料与该申请年份的年假余额，沿既有工作日、节假日调整及半天计算；目录、余额、日期范围或身份核验失败时按实际返回处理，不伪造资料或切到其他表。没有附件字段，不收集或上传证明文件；普通假期请求不进入这段资料收集。

同一草稿修订时使用 `prepare annual_leave --draft <draftId> --input <文件>`，按本流程提供完整业务输入。准备后执行 `preview <draftId>`，展示明确标为Demo测试的流程、申请人、日期和时段、事由、天数、年假余额与有效期。正常隐藏信息不要求员工确认。Demo是入口分类，不表示提交只停留在本地或已经获批。

**展示完整预览后停止，等待员工针对这份Demo申请的新提交确认。** 最初的测试意图、提供资料或保存不代替确认；修改后重新准备和预览。本流程采用一次完整申请确认，不套费用明细两轮确认。

收到新确认后，执行 `submit <draftId> --confirm <本次preview返回的draftSha256>` 一次，再用 `result <draftId>` 核对。结果未知只查原草稿，不另建重提；提交成功与审批通过分开报告。排障按[DEBUG](../../../references/DEBUG.md)，不索取凭据，不扩大查询范围。
