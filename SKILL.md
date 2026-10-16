---
name: fargowork
description: 安装和使用官方 OpenYida CLI 的 FargoWork 附加技能包，复用当前员工登录身份办理年假、出差、采购、对外付款四个固定流程，调用共用 JS 完成预览和确认提交。
---

# FargoWork

本文件所在目录是技能包根。FargoWork 是官方 OpenYida CLI 的附加技能包；先具备官方 CLI，再安装本包。首次安装读取下述安装部分；办理申请只加载对应流程的 Skill。只向员工展示必要问题、业务预览和结果，不输出阶段报告或边执行边播报日志。

## 首次安装

本次发布使用 [FargoWork `v2.0.0` 固定标签](https://github.com/Ansel-O/fargowork/tree/v2.0.0)作为安装源。用户只提供仓库地址时，获取该标签的完整目录，再按下面步骤安装；不要零碎下载单个 Skill，也不要把 `main` 上的可变脚本混入这个版本。

1. 确认当前电脑是 Windows，已具备 Node.js 22 或以上及 npm。缺少依赖时说明需要按公司 IT 规范从 Node.js 官网安装，等待员工处理；不要下载替代运行时、修改系统策略或自动提权。
2. 确认已安装[官方 OpenYida CLI](https://github.com/openyida/openyida)。首次安装使用官方命令：

   ```text
   npm install -g openyida
   ```

   本版已核验官方 CLI `2026.7.14-2` 和 `2026.10.16` 的接入合同。已安装时先让本包检查兼容性，不重复安装。若版本不受支持，按错误码反馈，不静默卸载、降级或修改版本限制。安装被公司策略阻止或要求管理员权限时，说明需要 IT 协助，不修改系统策略。
3. 在这个完整包的根目录运行一次：

   ```text
   node scripts/setup.cjs
   ```

   安装脚本检查官方 CLI，把 FargoWork 完整包放到用户级持久目录，并复用官方 OpenYida 登录态。需要登录时，由本人完成官方授权；不安装包内 OpenYida 副本、不另建 FargoWork 身份，不配置 MCP，也不读取或打印凭据。
4. 使用安装器返回的 `skillEntry` 和 `skills` 路径，让当前宿主读入入口及对应流程 Skill。安装器会保存官方工作目录关联，后续从持久包运行也能自动复用，不需要员工手工配置。支持本地 Skill 导入的宿主可按其实际能力登记这些路径；否则直接读取需要的文件。不得猜配置目录或把当前宿主当成另一客户端。只复制四个 `SKILL.md` 会丢失脚本；完整目录必须保留。

安装后的操作都在安装器返回的持久包根进行。不要继续从临时下载目录运行旧副本。若返回 `OPENYIDA_PROFILE_REQUIRED`，按 [DEBUG](references/DEBUG.md) 让本人选择已有官方账号，不猜账号或新建第二套登录。

## 流程路由

| 员工意图 | 加载的 Skill | 命令中的 workflow key | 唯一提交目标 |
| --- | --- | --- | --- |
| 年假申请 | [annual-leave](skills/annual-leave/SKILL.md) | `annual_leave` | `FORM-E0E2F1E273B7400F8CDEC9EF505B960EGPYE` |
| 出差申请 | [business-trip](skills/business-trip/SKILL.md) | `business_trip` | `FORM-188915A63185430D9A57AD9114129887TVCT` |
| 采购申请 | [procurement-request](skills/procurement-request/SKILL.md) | `procurement_request` | `FORM-4E378FADE81F40F8A520A47251D804E6MT1K` |
| 对外付款申请 | [external-expense-request](skills/external-expense-request/SKILL.md) | `external_expense_request` | `FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3` |

**只能向这四个目标发起申请。** 对未封装的流程，说明暂不支持并停止。不要通过 OpenYida 搜索应用导航、枚举表单、检索隐藏或测试流程来尝试替代目标，也不要凭名称选择其他同名流程。关联已存在的本人合同或用印记录，仅允许付款脚本定义的只读查询，不代表可以发起这些流程。

## 共同调用规则

从包根运行固定 JS 入口：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs login
node scripts/fargowork.cjs requirements <workflow-key>
node scripts/fargowork.cjs prepare <workflow-key> --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
node scripts/fargowork.cjs submit <draftId> --confirm <draftSha256>
node scripts/fargowork.cjs result <draftId>
```

- 先看状态，仅在需要时登录；本包登录命令使用官方 OpenYida 的当前身份，不重复建立第二套账号。相对日期以状态返回的 Asia/Shanghai 日期为准。
- 使用 `requirements` 声明的语义字段。身份、原始字段、目标表单、流程编码、连接器和请求地址不能由用户输入覆盖。缺项按 `needsInput` 合并询问；候选只能从脚本结果中选择。
- 出差、采购、付款可在业务 JSON 顶层加 `attachments`，值为本地文件绝对路径数组。付款至少一件；统一脚本处理原生上传和绑定。不要自行上传、拼附件地址、重用别人的引用或改用其他附件服务。
- `prepare` 返回需要补充的信息，或草稿编号、摘要和业务预览。已有草稿修改内容或补附件时，在原命令追加 `--draft <draftId>`，复用同一草稿和已知附件；若返回仍有待补信息，继续补充同一份输入。用户看过最终预览并明确确认后，才用该草稿最新的 `draftSha256` 提交一次。内容、账号或业务日期变化后须重新准备并确认；账号切换不能沿用他人的草稿。
- 提交或上传结果不确定时停止写操作，优先用现有草稿的 `result` 查询。不得创建新草稿重提或自动重传结果未知的附件。
- 不绕开脚本自行编写 HTTP、给 OpenYida 传入任意 API 参数、替换固定目标、查询其他员工，或把缺少的权威数据编造成输入。权限不足、字段变化或资料不完整时说明错误码并停止，见 [DEBUG](references/DEBUG.md)。

JS 模块按网页已确认的规则重新实现查询、计算和字段映射，不下载后直接执行网页 JS。固定只读基础资料是四流程正常办理所必需，范围见 [连接器说明](references/CONNECTORS.md)。本地约束不能替代平台授权；现有连接器跨人查询风险仍需平台侧治理。
