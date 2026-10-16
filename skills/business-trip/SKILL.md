---
name: business-trip
description: 使用 FargoWork 的 OpenYida 技能包为当前登录员工办理项目或非项目出差申请，核对排程、项目部门和附件，预览确认后提交。仅办理本包固定的出差流程。
---

# 出差申请

从本文件位置向上两级确定包根，在包根执行下列命令。首次使用按[入口 Skill](../../SKILL.md#首次安装)先安装官方 OpenYida CLI，再安装 FargoWork 附加包；后续复用官方登录态，无需注册 MCP。

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs login
node scripts/fargowork.cjs requirements business_trip
node scripts/fargowork.cjs prepare business_trip --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
node scripts/fargowork.cjs submit <draftId> --confirm <draftSha256>
node scripts/fargowork.cjs result <draftId>
```

先检查状态，只有需要时引导本人登录。用 `requirements business_trip` 读取当前输入要求：地点、目的、起止日期、港币预算、内容、是否项目出差。日期按状态返回的 Asia/Shanghai 业务日期解释，写成 `YYYY-MM-DD`；`is_project` 使用 JSON 布尔值。出差目的只能采用返回的选项。

一天出差可用员工提供的地点和内容生成一行排程；多日出差须收集 `itinerary`，每行包含 `date`、`item` 和可选 `remark`，不得编造缺失安排。项目出差提供 `project_name` 或 `project_query`；脚本要求选择项目或部门时，只从 `needsInput.choices` 中选择，不猜名称、部门或主管。默认使用本人主部门，需变更时通过 `department_id` 选择本人其他任职部门。

将业务输入保存为本地 UTF-8 JSON，再运行 `prepare`。如用户提供附件，使用顶层 `attachments` 数组列出真实文件的绝对路径；统一脚本负责原生附件上传与绑定，不复制其他申请的附件引用。缺信息时合并询问 `needsInput`，更新输入后重新准备；已有草稿修改内容或补附件时，在命令追加 `--draft <draftId>`，复用同一草稿及已知附件，不因修改内容新建一套上传。

准备成功后展示最终业务预览：日期、地点、目的、预算、排程、项目及部门、发起部门和附件。用户明确确认该预览后，使用该草稿的 `draftId` 和 `draftSha256` 提交一次。改动内容、跨日或切换账号后须重新准备并确认。成功后只报告结果与流程编号；不确定时先查 `result`，不能新建草稿重提或自动重传未知结果的文件。

日常只向用户输出待补充问题、最终预览、结果和必要错误说明，不播报命令、阶段日志、鉴权细节或测试报告。

本技能只执行包内固定出差流程和所声明的资料查询。禁止用 OpenYida 搜索其他表单、隐藏数据或测试流程，不自行写 HTTP、不调用任意连接器、不查询其他员工，也不修改固定流程目标。资料、权限或连接器不完整就报告脚本错误码并停止；排障见 [DEBUG](../../references/DEBUG.md)，不索取凭据。
