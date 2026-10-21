---
name: listing
description: 使用 FargoWork 发起挂牌申请，默认给自己挂牌，也可从员工目录选择他人；自动查询所选人员部门和合规资料。
---

# 挂牌申请

升级后建议新开会话；继续当前会话时重新加载新版入口和本流程说明。草稿按[24小时复用与刷新](../../../references/WORKFLOW-DIRECTORY.md#办理行为)：首个可核对草稿起24小时，编辑不续期、提交不全量重查；过期或用户要求用 `refresh <draftId>`，保留输入、材料和回执，展示并确认实际差异。

从本文件位置向上三级确定包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements listing
node scripts/fargowork.cjs prepare listing --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

收集牌照类型 `license_type` 的用户原话，表单自身负责必填校验。默认给本人挂牌；用户明确给他人时，以其姓名传 `owner_name`，由脚本读取原生员工目录。遇到多个候选，用姓名和部门让员工选择，将对应 `owner_selection` 原样传回；不要展示或要求员工提供内部 ID。选定后，脚本只读取该人员在本流程获准的姓名、中文名、电邮、主部门及部门 ID/名称，不查询银行、身份证等无关资料。

所选人员带出花名册主部门及挂牌资料；一个人有多个部门时无需额外询问。英文姓名、邮箱、中文姓名分别可用 `owner_english_name`、`owner_email`、`owner_chinese_name` 修改；不给他人套用登录人的邮箱。更换挂牌人时清除旧候选及不属于新人员的资料，再准备草稿。实际提交账号和发起部门仍绑定当前登录人。

脚本根据部门层级查询页面固定的父部门编码，并从固定合规表读取匹配人员。部门层级不足时编码按原页面清空；合规人员为空不阻止发起。隐藏且必填的“挂牌情况说明”不向员工收集或写入。

展示给谁挂牌、部门名称、牌照类型和其他业务内容后停下，等待员工对该预览的新确认。正常的父部门编码和合规人员映射无感处理。确认后只提交一次；结果未知时先核对，不重提。审批由宜搭流程处理，本 Skill 只发起挂牌申请。
