---
name: fargowork
description: 官方 OpenYida CLI 的 FargoWork 附加技能包。复用员工官方登录，按固定业务规则办理年假、出差、采购和对外付款，展示用户业务预览并等待确认后提交。
---

# FargoWork

只展示必要问题、用户业务预览和结果。隐藏字段由脚本自动查询、计算和提交；正常时不展示、不解释、不逐项确认。只在确实影响办理时按[资料检查](references/CHECKS.md)请员工协助。

## 首次安装

使用 [v2.1.0 固定标签](https://github.com/Ansel-O/fargowork/tree/v2.1.0)的完整目录。不要混入其他版本文件或只复制单个 Skill。

1. 确认 Windows、Node.js 22+、npm。缺少运行环境按公司 IT 规范准备，不提权或修改系统策略。
2. 先安装[官方 OpenYida CLI](https://github.com/openyida/openyida)。本版验证基线为 `2026.10.16`：缺少时使用 `npm install -g openyida@2026.10.16`；已有安装先检查，不重复安装或静默换版本。
3. 在完整包根运行 `node scripts/setup.cjs`。本包复制到用户持久目录，登录、账号选择和会话由官方 CLI 管理；本人只在官方要求时完成授权。不手动读取、复制或修改认证文件，不配置 MCP。
4. 使用返回的 `skillEntry`、`skills` 和持久目录让宿主读入入口及对应流程 Skill。保留完整目录；按宿主实际能力导入，不猜配置目录、不修改其他产品。多个官方账号时让本人选择，见 [DEBUG](references/DEBUG.md)。

## 四流程

| 意图 | Skill | workflow key | 唯一目标 |
| --- | --- | --- | --- |
| 年假 | [annual-leave](skills/annual-leave/SKILL.md) | `annual_leave` | `FORM-E0E2F1E273B7400F8CDEC9EF505B960EGPYE` |
| 出差 | [business-trip](skills/business-trip/SKILL.md) | `business_trip` | `FORM-188915A63185430D9A57AD9114129887TVCT` |
| 采购 | [procurement-request](skills/procurement-request/SKILL.md) | `procurement_request` | `FORM-4E378FADE81F40F8A520A47251D804E6MT1K` |
| 对外付款 | [external-expense-request](skills/external-expense-request/SKILL.md) | `external_expense_request` | `FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3` |

不能检索隐藏或测试流程作为替代，也不能自行拼 API、替换目标或查询其他员工。付款脚本允许的本人合同/用印关联是只读引用，不授权发起这些流程。平台权限仍由宜搭控制，本地脚本不构成服务端授权。

## 办理与确认

1. 从持久包根执行 `node scripts/fargowork.cjs status`；仅需要登录时使用官方登录。读取对应流程的 `requirements`，按语义字段收集输入，不编造事由、金额或内部事实。
2. 调用 `prepare <workflow-key> --input <绝对路径UTF-8业务JSON>`。已有草稿修改时加 `--draft <draftId>`；合并询问 `needsInput` 中员工能回答的问题。附件由[共用附件模块](references/ATTACHMENTS.md)处理。
3. 返回 `nextAction: preview` 后调用 `preview <draftId>`，只展示 `preview` 中的业务内容。**展示后结束当前操作，等待员工下一条明确确认；不得把 prepare、preview、submit 连成脚本一次执行。**
4. 起初“帮我请假”“帮我提交”不代替看完最终预览后的确认。只有收到这份预览之后的新确认，才执行 `submit <draftId> --confirm <本次preview返回的draftSha256>` 一次。摘要用于绑定草稿，不是人类同意的证据。不得自行生成员工确认或让其他Agent代为确认。
5. 用户修改、草稿过期或账号变化后重新准备并展示预览；同一份已确认且未变化的草稿无需再次询问。允许为空的隐藏字段不额外提示或确认。
6. 取得成功回执后简短报告“已提交”及编号，不等于审批通过。`result <draftId>` 的提交状态与内容核验分开；部分回读未核对不能改说提交失败。结果未知时核查原草稿，禁止重提或重传。

以上命令均为 `node scripts/fargowork.cjs <命令>`。脚本固定的查询、计算和字段映射保留；不执行下载自网页的任意JS。遇阻塞按 [CHECKS](references/CHECKS.md) 和 [DEBUG](references/DEBUG.md) 处理，不向员工索取凭据。
