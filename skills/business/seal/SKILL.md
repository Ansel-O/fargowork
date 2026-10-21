---
name: seal
description: 使用 FargoWork 为当前登录员工发起用印申请，逐行收集印章、份数和可选附件，可选关联本人合同。
---

# 用印申请

升级后建议新开会话；继续当前会话时重新加载新版入口和本流程说明。草稿按[24小时复用与刷新](../../../references/WORKFLOW-DIRECTORY.md#办理行为)：首个可核对草稿起24小时，编辑不续期、提交不全量重查；过期或用户要求用 `refresh <draftId>`，保留输入、材料和回执，展示并确认实际差异。

从本文件位置向上三级确定包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements seal
node scripts/fargowork.cjs prepare seal --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

先从公司目录选择 `company`，并提供 1–50 行 `items`。每行选择 `seals`（公章、法人章、合同章、其他章，可多选），`copies` 为可选整数，`remark` 和 `attachments` 本地绝对路径数组也可选。每行文件最多9个，单件不超过100 MiB；不要把一个文件列表串到其他行。

关联合同是可选项。仅在员工明确要求关联时设置 `include_contract: true`，随后从脚本 `needsInput.choices` 中选择本人发起且仍处于进行中或已完成的合同；候选展示合同完整流水号和申请人姓名。不关联时留空或设置 `include_contract: false`。不能选择他人合同。关联内容及用于检索的隐藏文本由脚本同步保存，不要求员工填写或确认技术字段。

申请人固定为当前登录人。用印公司从公司名称目录选择，再按该公司带入公司关系管理员表里的印章管理人。未使用的“用印对应审批人”保持空，不询问或猜测人员；本阶段不填写“用印后文件上传”。

展示逐行预览及各行附件名称后停下，等待员工对这份预览的新确认。确认后只提交一次。结果未知时先核对，不重提、不重传；审批由宜搭既有流程处理。
