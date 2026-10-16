---
name: annual-leave
description: 使用 FargoWork 的 OpenYida 技能包为当前登录员工办理年假申请，包括余额、工作日、草稿预览和确认提交。仅办理本包固定的年假流程。
---

# 年假申请

先从本文件位置向上两级确定包根，在包根运行下列命令。首次使用按[入口 Skill](../../SKILL.md#首次安装)先安装官方 OpenYida CLI，再安装 FargoWork 附加包；后续复用官方登录态，无需注册 MCP。

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements annual_leave
node scripts/fargowork.cjs prepare annual_leave --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

`login` 不属于常规办理序列。只有 `status` 明确要求登录时，才单独执行 `node scripts/fargowork.cjs login`，由员工完成官方授权。

**读取最终预览后必须停住，等待员工下一条明确确认。** 起初要求办理或提交，不代替看完预览后的确认。收到新确认后，才执行 `node scripts/fargowork.cjs submit <draftId> --confirm <本次preview返回的draftSha256>` 一次；需要回读时执行 `result <draftId>`。不要把准备、预览、提交合在一次命令里。

正常时仅展示脚本 `preview` 的用户业务内容，不展开隐藏字段、人员映射或可空提示。仅确实阻塞时按[资料检查](../../references/CHECKS.md)协助处理。

部门选择只向员工展示脚本提供的名称候选；`department_id` 等内部值由 Agent 从可信候选中对应填写，不要求员工提供或确认内部 ID。脚本没有候选时不猜值、不另查隐藏数据，按资料检查处理。

先检查状态，只有需要时引导本人登录。读取 `requirements annual_leave` 后收集开始日期、开始时段、结束日期、结束时段、请假事由。日期使用 `YYYY-MM-DD`，时段使用 `上午` 或 `下午`；以状态返回的 Asia/Shanghai 业务日期解释“明天”等相对日期，不猜事由。

把已确认的业务信息写入本地 JSON，再调用 `prepare`。只有需要选择其他任职部门时才添加 `department_id`。身份、公司、管理员、余额、年度、工作日和调休数据由脚本查询并计算，不向用户索取这些内部字段，不手填覆盖。缺信息时合并询问 `needsInput` 所列问题，修改同一份输入后重新准备；已有草稿则在命令追加 `--draft <draftId>`。

准备成功后，向用户展示业务预览：日期与时段、请假天数、事由、余额。显示完整预览后取得一次明确确认，再用该草稿的 `draftId` 和 `draftSha256` 提交。任何内容变更、跨日或账号切换都须重新准备和确认。提交后只报告成功与流程编号；结果不确定时先查 `result`，不能新建草稿重复提交。

日常只输出需要用户补充的问题、最终业务预览、结果和必要的错误说明。不边运行边播报命令、字段、日志、鉴权或测试报告。

只执行本包这条固定流程。禁止通过 OpenYida 搜索其他应用、表单、流程或隐藏数据来寻找“替代流程”，也不自行编写 HTTP 请求、调用任意连接器、查询其他员工或修改包内固定目标。依赖、权限或资料不足时，报告脚本的错误码并停止；需要排障时按 [DEBUG](../../references/DEBUG.md) 处理，不索取凭据。
