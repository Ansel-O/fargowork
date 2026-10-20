---
name: fargowork
description: 官方 OpenYida CLI 的 FargoWork 附加技能包。办理固定公司流程，预览确认后提交；正式假期、销假及已迁移 HR 流程转往 Moka，年假和付款 demo 仅供明确测试。
---

# FargoWork

只展示必要问题、用户业务预览和结果。隐藏字段由脚本自动查询、计算和提交；正常时不展示、不解释、不逐项确认。只在确实影响办理时按[资料检查](references/CHECKS.md)请员工协助。

可见进度和失败说明都用业务语言，例如“正在核对报销币种和金额”。遇阻只说明已确认的现象、影响和下一步，不把命令、错误码、表单／字段 ID、userid 或执行链贴给员工；技术信息仅在维护者主动排查或用户明确要求技术说明时按 [DEBUG](references/DEBUG.md)提供。查询没有匹配结果不等于资料未维护，不能据此要求新增记录。保留已整理材料；只有确认保存成功后才说“草稿已保存”。

按本流程 Skill 和 workflow 已定义的步骤、工具及固定来源直接办理，不在每次申请前重新搜索全仓、试探接口或重建已有规则。只有信息缺失、来源冲突或工具失败时，才围绕具体问题补问和排查。复用本次已读材料和已确认合法选择；集中补问必要缺项，只改说明等无关主表字段时向同一草稿传最小修改，不重复整理附件或核对未改行。保留目录核对、提交前公司维护来源复核及原确认步骤。提交成功先告知结果，回读仅用于必要核查；未知结果仍按既有恢复规则处理。

## 首次安装

使用从 [FargoWork 仓库](https://github.com/Ansel-O/fargowork) 取得的完整目录。不要混入其他版本文件或只复制单个 Skill。

1. 确认 Windows、Node.js 22+、npm。缺少运行环境按公司 IT 规范准备，不提权或修改系统策略。
2. 先安装[官方 OpenYida CLI](https://github.com/openyida/openyida)。本版支持已核对的 `2026.10.16`、`2026.10.19`：缺少时使用 `npm install -g openyida@2026.10.19`；已有支持版本直接复用，不重复安装或静默换版本。
3. 在完整包根运行 `node scripts/setup.cjs`。本包复制到用户持久目录，登录、账号选择和会话由官方 CLI 管理；本人只在官方要求时完成授权。不手动读取、复制或修改认证文件，不配置 MCP。
4. 使用返回的 `skillEntry`、`skills` 和持久目录让宿主读入入口及对应流程 Skill。保留完整目录；按宿主实际能力导入，不猜配置目录、不修改其他产品。多个官方账号时让本人选择，见 [DEBUG](references/DEBUG.md)。

## 流程分类

按用途分为以下五类；目录分类与正式、Demo测试、Moka迁移状态独立，不能据此改变办理范围。

| 类别 | 目录 | 入口数 |
| --- | --- | ---: |
| 财务 | `finance` | 7 |
| 假勤 | `leave` | 8 |
| 资产 | `assets` | 3 |
| 业务 | `business` | 5 |
| 人事 | `hr` | 9 |

逐流程文件位于 `skills/<类别>/<流程>/SKILL.md`，以下入口链接与安装返回的Skill路径均按此目录组织。办理命令的workflow key保持不变。

## 已迁移流程

先按请求识别流程。以下十六项只提示“该流程不可发起，请转至 HR 应用 Moka”，不登录、不收集资料、不准备或提交旧流程。餐費與交通補貼仍可按后文办理。

| 意图 | Skill | workflow key |
| --- | --- | --- |
| 员工证明材料 | [employee-certificate](skills/hr/employee-certificate/SKILL.md) | `employee_certificate` |
| 推荐候选人奖励 | [referral-reward](skills/hr/referral-reward/SKILL.md) | `referral_reward` |
| 试用期转正 | [probation-confirmation](skills/hr/probation-confirmation/SKILL.md) | `probation_confirmation` |
| 试用期计划 | [probation-plan](skills/hr/probation-plan/SKILL.md) | `probation_plan` |
| 雇主提供居所 | [employer-housing](skills/hr/employer-housing/SKILL.md) | `employer_housing` |
| 新员工入职 | [onboarding](skills/hr/onboarding/SKILL.md) | `onboarding` |
| 离职 | [resignation](skills/hr/resignation/SKILL.md) | `resignation` |
| 转岗 | [transfer](skills/hr/transfer/SKILL.md) | `transfer` |
| HR 操作离职 | [hr-offboarding](skills/hr/hr-offboarding/SKILL.md) | `hr_offboarding` |
| 年假 | [annual-leave-application](skills/leave/annual-leave-application/SKILL.md) | `annual_leave_application` |
| 年假销假 | [annual-leave-cancellation](skills/leave/annual-leave-cancellation/SKILL.md) | `annual_leave_cancellation` |
| 无薪病假 | [unpaid-sick-leave](skills/leave/unpaid-sick-leave/SKILL.md) | `unpaid_sick_leave` |
| 带薪病假 | [paid-sick-leave](skills/leave/paid-sick-leave/SKILL.md) | `paid_sick_leave` |
| 带薪病假销假 | [paid-sick-leave-cancellation](skills/leave/paid-sick-leave-cancellation/SKILL.md) | `paid_sick_leave_cancellation` |
| 其他假期（婚产等） | [other-leave](skills/leave/other-leave/SKILL.md) | `other_leave` |
| 事假 | [personal-leave](skills/leave/personal-leave/SKILL.md) | `personal_leave` |

普通假期及销假请求都转至 Moka，体检假也一样；无需先补问种类、日期、病情或证明文件。只有明确要求测试年假 demo 时进入后文 demo 分组，不能将其作为正式假期的替代入口。已停用正式流程的旧草稿不能继续提交。不能换表单、搜索同名或隐藏流程、修改状态或直接调用官方 CLI 继续旧流程。

入职、离职、转岗和 HR 操作离职属于重要人事流程，不建议由 Agent 发起。直接引导本人前往 Moka，不能搜索旧宜搭流程、修改状态或调用脚本绕过迁移提示。

## 正式流程

| 意图 | Skill | workflow key | 唯一目标 |
| --- | --- | --- | --- |
| 餐費與交通補貼 | [meal-transport](skills/finance/meal-transport/SKILL.md) | `meal_transport` | `FORM-37E345438F1344298217640B2437B76AJ2LU` |
| 正式出差 | [business-trip-application](skills/business/business-trip-application/SKILL.md) | `business_trip_application` | `FORM-674D4FE01A894121BB2FF2A851F5CF76H0AD` |
| 正式采购 | [procurement-application](skills/assets/procurement-application/SKILL.md) | `procurement_application` | `FORM-99C895A427654BE6AF298B7EF6BE5D7DC3ML` |
| 硬件申请 | [hardware-request](skills/assets/hardware-request/SKILL.md) | `hardware_request` | `FORM-A502753D2A4546258915AAC3C89EFEA68IZS` |
| 软件申请 | [software-request](skills/assets/software-request/SKILL.md) | `software_request` | `FORM-C06FA1CEE16B4EA4B1A8D9B5082A68DAV02L` |
| 正式对外费用 / 对外付款 | [external-expense-application](skills/finance/external-expense-application/SKILL.md) | `external_expense_application` | `FORM-0AE7D3E4C01D45AC97D8C68DF7FF6B6CH3LQ` |
| 费用报销 | [expense-reimbursement](skills/finance/expense-reimbursement/SKILL.md) | `expense_reimbursement` | `FORM-6EB2E57A94CF4445BB28508DC45262E3MDDX` |
| 出差费用报销 / 出差报销 | [trip-expense-reimbursement](skills/finance/trip-expense-reimbursement/SKILL.md) | `trip_expense_reimbursement` | `FORM-FF467D1C65F940C2A7A65C6EA234BB95QVO8` |
| 体检报销 | [medical-checkup-reimbursement](skills/finance/medical-checkup-reimbursement/SKILL.md) | `medical_checkup_reimbursement` | `FORM-FEA10FAA67204CCABD64295DE2A91857DH4G` |
| 补录 / 更换默认银行卡 | [default-bank-change](skills/finance/default-bank-change/SKILL.md) | `default_bank_change` | `FORM-119A5B3BC5034DFEB609977A41F2EBE576IB` |
| 合同 | [contract](skills/business/contract/SKILL.md) | `contract` | `FORM-3DB996CA240D4F3FAB0CC8C9E72A092BUJGU` |
| 用印 | [seal](skills/business/seal/SKILL.md) | `seal` | `FORM-ABF68B75000543F4A34EFCB284AC13FAZL8E` |
| 名片 | [business-card](skills/business/business-card/SKILL.md) | `business_card` | `FORM-F3B3659CD74D4260BDE5F2BEA4CEEB02TGYX` |
| 挂牌 | [listing](skills/business/listing/SKILL.md) | `listing` | `FORM-682B25DB197D42869C87AB548BB66C91YB25` |

普通出差、采购和付款请求分别使用 `business_trip_application`、`procurement_application`、`external_expense_application`。旧出差和采购 demo 已从本包移除，旧草稿不能继续或转换为正式申请。

## Demo 测试分组

| 测试意图 | Skill | workflow key | 唯一测试目标 |
| --- | --- | --- | --- |
| 年假 Demo 测试 | [annual-leave](skills/leave/annual-leave/SKILL.md) | `annual_leave` | `FORM-E0E2F1E273B7400F8CDEC9EF505B960EGPYE` |
| 对外付款 Demo 测试 | [external-expense-request](skills/finance/external-expense-request/SKILL.md) | `external_expense_request` | `FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3` |

只有用户明确要求测试对应 demo 时才进入。完整预览必须标明 Demo 测试；测试仍会向固定测试表发起真实流程，因此同样等待预览后的新确认，并保留未知结果不重提的规则。普通业务、正式流程受阻或迁移提示都不能自动转入 demo；正式与 demo 的字段、草稿、确认和目标不互换。

## 财务与资料规则

餐費與交通補貼属于财务组，继续使用原有 `meal_transport`。本包只办理表中已列出的固定流程，不检索隐藏或测试流程作为替代，不自行拼 API 或替换目标。

本人费用报销、出差费用报销、体检报销或餐补中缺少默认收款资料、或员工指定本次换卡时，按其已明确的资料继续当前申请，将实际收款资料纳入最终预览；不提前转去办变更，也不单独重复确认已明确的修改。当前申请提交成功后，仅在本次补录或修改了收款资料、且员工未说明是否长期使用时，简短询问一次是否另提[默认银行卡变更申请](skills/finance/default-bank-change/SKILL.md)；已说“就这一次／仅本次”的不再询问。这是可选后续，不自动创建或提交第二单，不改写花名册。代办出差报销不自动引出对方的默认资料变更。只有员工主动单独要求先改本人默认资料时才切换，并保留原草稿；独立变更需预览和新确认，提交成功不代表资料已经生效。

出差费用报销与出差申请分别办理：报销读取行程、实报费用及餐补，使用本流程的可编辑明细；不能用一般费用报销或出差申请替代。

体检报销面向大陆员工，仅办理本人人民币申请；超过1500元自动封顶并在完整预览说明原金额和调整结果。收款五项先从本人花名册带入，员工明确修改时才覆盖。支付公司沿体检表的合同公司初值和合法目录，不套用其他报销表的员工支付公司映射。没有费用子表，直接准备并展示完整申请，等一次新的提交确认。正式员工及一年一次由原表提交校验，不另查年度报销历史或新增本地资格门禁。

花名册默认只查本人。挂牌可读取已选员工的必要字段；出差费用报销仅允许配置获准的登录人员通过官方目录明确选择其他报销人，再读取本次办理所需资料；硬件和软件由固定部门配置自动选取第一位 IT 主管，仅补查其姓名。各用途受各自流程配置限制，不能扩为任意人员查询。平台权限仍由宜搭控制，本地脚本不构成服务端授权。

## 办理与确认

办理时先核对[在线目录与版本](references/WORKFLOW-DIRECTORY.md)。工具在办理及提交前重新读取固定自定义页；目录异常、流程停用、规则主版本不兼容或客户端太旧时，保留材料和草稿，暂停提交。不能改配置、改版本号、使用旧缓存或直接调用 OpenYida 绕过。新流程只提示更新，不能自动生成新执行入口。

公司维护的科目、币种、汇率和计算规则优先于用户建议及个人记忆。不得联网补造公司目录，也不能用用户指定汇率替代维护值。类别／科目允许员工在工具返回的合法范围内选择：草稿每行一组推荐，合理备选在独立说明区按行号列出；接受则继续，明确替换后只修改相应行并回显，固定科目不开放更换。参见[财务明细](references/FINANCE-DETAILS.md)。

七个财务入口默认按[HTML 明细与修改](references/FINANCE-DETAIL-EDITOR.md)展示本流程自己的模板，不等待用户要求。`review`、`prepare`、`preview` 和 `apply-edit` 返回 `detailEditor.path`，直接打开或链接展示；宿主不能内嵌时提供本地 HTML 链接供浏览器打开。单笔也提供 HTML，可附一句摘要。自然语言修改回写同一草稿后展示新版；手动编辑通过导出文件交给 `apply-edit` 校验重算，再展示新版并取得确认。导出、应用修改不等于确认，不新增体检、默认卡或 Demo 的确认轮次；详见各流程 Skill。

1. 从持久包根执行 `node scripts/fargowork.cjs status`；仅需要登录时使用官方登录。读取对应流程的 `requirements`，按语义字段收集输入，不编造事由、金额或内部事实。
2. 费用报销、出差费用报销、正式对外费用和餐费交通补贴按[财务明细](references/FINANCE-DETAILS.md)先解析本次材料、完成必要建议和计算，再用 `review <workflow-key>` 保存并展示对应流程的可修改明细。费用报销使用八列；其余分别使用行程实报餐补、正式单币种付款、分钟级加班和交通各自明细。餐补打卡证明与报销凭据分用途、分附件栏。收到员工对当前明细的新确认后执行 `confirm-details`，才在同一草稿补主表并 `prepare <workflow-key> --draft <draftId> --input <绝对路径UTF-8业务JSON>`。`details` 仍是只读查询入口，不能代替明细确认。体检报销等无明细子表的流程沿其 Skill 调用 `prepare <workflow-key> --input <文件>`，已有草稿加 `--draft <draftId>`。`needsInput` 中的 Agent 推荐项先由 Agent 处理，只合并询问员工能回答的业务问题。附件由[共用附件模块](references/ATTACHMENTS.md)处理。
3. 返回 `nextAction: preview` 后调用 `preview <draftId>`，只展示 `preview` 中的业务内容；财务流程打开本次 `detailEditor.path` 展示完整申请 HTML，必要说明附在页面外。**展示后结束当前操作，等待员工下一条明确确认；不得把 prepare、preview、submit 连成脚本一次执行。**
4. 起初“帮我申请名片”“帮我提交”不代替看完最终预览后的确认。只有收到这份预览之后的新确认，才执行 `submit <draftId> --confirm <本次preview返回的draftSha256>` 一次。摘要用于绑定草稿，不是人类同意的证据。不得自行生成员工确认或让其他Agent代为确认。
5. 用户修改、草稿过期或账号变化后重新准备并展示预览，财务流程使用工具新返回的 HTML，不能沿用旧页面或旧摘要；同一份已确认且未变化的草稿无需再次询问。允许为空的隐藏字段不额外提示或确认。
6. 取得成功回执后简短报告“已提交”及编号，不等于审批通过。`result <draftId>` 的提交状态与内容核验分开；部分回读未核对不能改说提交失败。结果未知时核查原草稿，禁止重提或重传。

以上命令均为 `node scripts/fargowork.cjs <命令>`。脚本固定的查询、计算和字段映射保留；不执行下载自网页的任意JS。遇阻塞按 [CHECKS](references/CHECKS.md) 和 [DEBUG](references/DEBUG.md) 处理，不向员工索取凭据。

## 个人偏好与修改边界

需要沿用个人偏好时读取[PERSONAL](references/PERSONAL.md)，使用 `personal view`。Agent 可根据使用情况建议记住出差用途倾向、费用场景倾向或展示偏好，用户明确同意后才保存；临时输入不自动变成长久偏好。偏好按当前公司和官方登录用户隔离、独立于安装目录，升级保留；不可读取时按正常流程询问，不阻止办理。

个人入口只修改允许的偏好键。员工及 Agent 办理时不编辑官方 Skill、脚本、公司配置、版本或校验规则；公司维护者通过完整版本更新规则。偏好不能覆盖本人范围、必要确认、公司数据源、固定科目或公式。用户本次事实和选择优先于习惯提示，提示不能代替本次真实用途。

四个正式个人报销默认仍取花名册，只有明确说换收款账号／卡才按[换卡检索](references/PERSONAL.md#本次换收款卡)进入本人已完成且同意的历史候选或自行提供。候选先核对本人和户名，展示遮掩账号，选中后五项整组带入本次申请。收款资料不得写入个人长期记忆；代办不查询他人的历史卡。外部收款方沿对应付款流程办理。
