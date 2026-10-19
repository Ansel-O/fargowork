---
name: business-trip-application
description: 使用 FargoWork 为当前登录员工办理正式出差申请，按已核验的行程与项目规则提交到固定正式表单和流程码。
---

# 正式出差申请

从本文件位置向上三级确定包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements business_trip_application
node scripts/fargowork.cjs prepare business_trip_application --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

本流程只使用固定正式目标 `FORM-674D4FE01A894121BB2FF2A851F5CF76H0AD`。出差Demo入口已移除，不接续其旧草稿，不搜索其他表单替代。

收集地点、出差目的、起止日期、港币预算、出差内容及是否项目出差。当天行程可用地点和内容生成一行；多日出差须逐日提供安排。项目出差根据 `needsInput.choices` 选择生效项目、项目部门；不猜测部门或主管。发起部门只能从本人任职部门中选择，默认主部门。

附件可选，放在业务 JSON 顶层 `attachments` 数组中，填写员工明确提供的本地绝对路径。不要扫描目录或复用其他申请的附件。

准备成功后读取并展示最终预览，然后停下等待员工对这份预览的新确认。确认后才用该草稿的摘要提交一次。变更内容、日期或账号后重新准备并展示预览；结果未知时先核对，不重提、不重传。审批由宜搭既有流程处理，本 Skill 只发起申请。

仅展示待补信息、业务预览、结果及必要阻塞说明。禁止检索其他流程、查询其他员工、调用任意连接器或改变表单和权限。
