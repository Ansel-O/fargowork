# 更新记录

## 3.3.0 — MD 明细版 / Markdown editing edition · 2026-10-23

- 费用报销、出差报销、正式对外付款、餐费交通补贴、体检报销默认提供独立 MD 模板；支持口述修改、保存原文件后回读和代码重算。
- 明细隐藏汇率，计算继续使用已取得的公司维护资料；费用与付款提供按类别分组的合法科目候选，出差按行成块保留行程、费用和差旅津贴。
- 餐费交通保留分钟级时间、18:30 默认开始时间及两类附件；体检固定人民币、自动封顶1500元，保留原确认规则。
- 银行卡变更简化为对话核对；经用户同意，只保存仍会使用的旧卡昵称、尾号和用途，不保存完整收款资料。
- Five formal finance workflows provide individual Markdown templates, supporting chat edits, original-file readback and shared-code recalculation.
- Company-maintained rates remain internal. Expense and payment drafts include grouped account candidates; travel details keep each itinerary row, costs and allowance together.
- Meal and transport retain minute-level times, the 18:30 default start and separate attachment roles. Medical claims remain CNY-only and capped at 1,500, with existing confirmation rules.
- Bank changes use conversation review. With consent, only nicknames, last four digits and purposes of old cards still in use are remembered.

独立 `md-editing` 分支版本，安装固定 `v3.3.0`；付款 Demo 保留原 HTML，业务规则版本和最低客户端门槛不变。

Independent `md-editing` edition: pin installation to `v3.3.0`. The payment Demo retains its HTML review. Rule versions and minimum client requirements are unchanged.

## 3.2.0 — 草稿复用与即时计算 / Draft reuse and live calculations · 2026-10-21

- 所有可办理流程从首版可核对草稿起，连续 24 小时复用已取得的公司资料；修改不顺延有效期，新增缺项按需补取，用户可主动刷新。
- 财务 HTML 和聊天修改共用计算代码；页面改数即时显示金额，每个流程保留自己的字段模板和确认步骤。
- 出差统一使用“差旅津贴”；按实际行程顺序计入尚未覆盖的日期，重叠日归前段，支持一单多次出差；用户修改的金额（包括 0）保留至最终申请。
- 新办理自动检查最新版，最多两次短请求，失败跳过；版本提示区分实际运行版、建议最新版、最低客户端和规则版本。最低客户端要求保持原值。
- All startable workflows reuse validated company data for 24 hours from the first reviewable draft. Edits do not extend expiry; missing new data is fetched as needed, and users can request a refresh.
- Financial HTML and chat edits share calculation code. Pages show updated amounts immediately and retain each workflow’s fields and confirmation steps.
- Travel allowances count only dates not covered by earlier itinerary rows, support multiple trips per claim, and preserve explicit user amounts, including zero, through the final application.
- New applications check for updates with at most two short requests and skip unavailable checks. Installed, recommended, minimum and rule versions are reported separately; existing minimum client versions remain unchanged.

客户端为 3.2.0，出差报销规则为 1.1.0；其他规则版本及所有最低客户端门槛保持原值。

## 3.1.1 — 财务默认 HTML 核对 / Automatic HTML financial reviews · 2026-10-20

- 七个财务入口在核对草稿时自动生成对应模板的 HTML；单笔也提供页面，不再等待用户提醒。
- 口述修改和手动导出回传都更新同一草稿，重算后提供最新页面；保留各流程原有确认步骤。
- HTML 不能内嵌时提供本地文件入口；生成失败明确提示，草稿仍保留。导出修改不等于确认或提交。
- 修复付款 Demo 局部修改丢失其他字段，以及最终 HTML 遗漏附件名称、结构化关联资料的问题。
- All seven finance workflows automatically provide their own HTML review, including single-item applications.
- Chat edits and returned page exports update the same draft, recalculate results and refresh the page before confirmation.
- Existing confirmation steps remain in place. Local file links support hosts without embedded HTML; exporting changes does not confirm or submit an application.
- Preserve unrelated fields when editing the payment Demo and retain final attachment names and structured association details in HTML.

本版修复默认展示与编辑衔接，业务规则版本不变；七项财务入口最低客户端更新为3.1.1。

## 3.1.0 — 财务编排与明细编辑 / Financial workflows and editable details · 2026-10-20

- 公司及支付／收款币种前置，项目归属未明确时补问；保留员工对合法类别、科目和可改金额的选择。
- 出差餐补按自然日去重、首尾保留、跨城日归到达段；逐行保留真实行程及关联出差单。
- 提供离线HTML明细模板，支持手动修改、导出及同草稿导入；旧页面不能覆盖新修订。简单单笔支持简短预览。
- 说明单字段局部更新、命令内查询复用、短时附件核验复用；提交前仍复核公司维护来源。修正明细回读的日期及关联值比较。
- 按既定 Skill 和 workflow 直接执行，信息缺失、冲突或执行失败时再排查，减少无关探索。
- Establish company, currency and project allocation before calculations; retain employee choices within maintained company data.
- Count travel allowance dates once, including first and last days, using the arrival segment on transfer days.
- Add local editable detail pages with validated import and stale-page protection; reduce repeated preparation and verification.
- Follow the defined Skill and workflow; investigate only missing information, conflicts or execution failures.

客户端为3.1.0；五项正式财务流程规则更新为1.0.1，最低客户端3.1.0。其他流程规则独立维护。实际账号权限仍按交付说明跟踪，不将离线测试等同于真人验收。

## 3.0.0 — 首个正式版 / First stable release · 2026-10-20

中英双语介绍与安装入口、企业适配指南随包提供。普通员工目录读取及本人历史收款检索的真实账号验证将在交付后继续跟踪。

The first stable release includes bilingual READMEs, company workflow version checks, personal preferences and an adaptation guide. Employee-account verification of directory access and historical bank-detail lookup remains a post-delivery follow-up.

- 整理统一流程目录与版本核对：流程规则版本逐流程维护，独立于Skill包版本；办理和提交前核对可用性、本地支持、规则主版本及最低客户端版本。无法核对时保留草稿、暂停提交，不能借旧缓存继续；普通员工稳定读取的真实验证单独跟踪，不以维护者可读代替。
- 提供四部分中英双语README，安装入口置顶，说明申请体验、企业适配、版本与personal维护、AI不替代人工及责任边界；需求、Bug和合作明确通过公司邮箱联系。
- 目录列表默认显示可用流程，Demo标明仅供测试；列表保留最低客户端版本，规则版本保留在完整JSON及底层校验。完整目录不受筛选影响。
- 新增独立personal入口，保存经用户确认的语言、详略、展示偏好及结构化业务习惯提示；本机按公司账号隔离、升级保留，允许查看、修改、删除和清空。敏感收款资料、凭据和业务全文不进入长期记忆，记忆不可用退回正常询问。
- 个人报销默认花名册，仅在用户明确换卡／账号时按需查本人已完成且同意的费用、出差、体检及餐费交通历史；候选返回前核对报销人和户名，选定后五项整组进入本次申请及最终确认。用户仍可自行提供，默认银行卡变更独立，外部付款历史保持独立功能。
- 涉及可选科目的正式及保留Demo流程采用每行一组推荐，合理备选在独立说明区提示；用户明确替换只更新指定行，不混入备选作为提交值，保留合法配对和最终完整确认。固定科目不因此开放选择，财务沿原流程审核；本版不建立采样或评价体系。
- 保留32入口、五分类及14正式可办理／2可办理Demo／16迁Moka指引。沿用原生附件、跨日和包版本草稿约束、单次提交及未知结果不自动重试。
- 目录和personal属于客户端约束，不能证明客户端完整或阻止第三方直连。2.9.1没有目录读取，远端最低版本不能自动停用它；接入本版需要一次明确升级。官方OpenYida身份和平台权限边界保持，不恢复自建Server或修改权限。

## 2.9.1 — 业务分类与全流程试用版

- 流程Skill、业务模块和配置统一按五类二级目录组织：财务 `finance`、假勤 `leave`、资产 `assets`、业务 `business`、人事 `hr`。人事独立分类；正式、Demo和Moka办理状态继续由配置区分。
- 保留32个稳定流程key和原有命令。分类登记、安装发现、文档链接和发布清单同步调整；财务材料整理、明细与最终申请确认、币种和收款等业务规则保持。
- 汇入2.9.0候选的全流程编排与修补：14正式可办理、2可办理Demo、16迁Moka指引。出差和采购Demo已删除；年假和对外付款Demo明确用于测试。
- 费用报销、出差费用报销、正式对外付款、餐费交通先修改并确认本流程明细，再补主表并确认完整申请。体检报销固定人民币、自动封顶1500元；默认银行卡变更独立办理或作为报销成功后的可选后续。
- 收款资料按流程从花名册带入并保留明确手动修改；账号使用完整字符串。附件通过宜搭原生能力处理，未知上传或提交结果不自动重试。
- 支持官方OpenYida CLI 2026.10.16和2026.10.19；Windows与Node.js 22以上。此版继续作为试用交付，各正式表的实际权限和服务器业务校验按需抽查。

## 2.9.0 — 全流程整理本地候选

- 当前保留32个入口：14个正式可办理流程、2个独立Demo测试入口、16个迁Moka指引。移除出差与采购Demo；年假Demo恢复测试发起，对外付款Demo继续保留，正式假勤仍使用Moka。
- 出差费用报销保留已同意出差单筛选、按行币种和汇率、收款币种餐补及同日期不重复餐补；体检报销固定人民币并自动封顶1500元；默认银行卡变更作为独立流程或报销成功后的可选后续。
- 费用报销、出差费用报销、正式对外付款、餐费交通按材料→本流程明细推荐或计算→修改并确认明细→补主表→完整申请新确认→提交办理。保留各自明细结构；体检报销、默认银行卡变更采用单次完整确认。
- 餐费交通从花名册带入的账号采用严格字符串检查，数字型来源要求补充完整账号；同一草稿保留用户修正。
- 配置、模块和安装发现共用流程登记；正式出差使用独立配置及共用工厂，不依赖Demo。入口文档与正式/Demo分组同步更新。
- 支持已验证的官方OpenYida CLI 2026.10.16和2026.10.19。

此版本仅为本地候选，尚未公开发布。

## 2.8.0 — 费用报销本地候选

- 新增独立费用报销 Skill：本人支付公司与收款资料自动带入，保留手动修改和清空，账号按完整字符串处理。
- 支持普通及项目报销、逐行不同原币、公司配置汇率换算和合计；多个部门或业务线候选等待选择，类别与科目按实际用途和合法配对建议。
- 支持最多20件宜搭原生附件，单件100 MiB；最终业务预览后等待本人新确认，正常隐藏资料不展示，未知上传或提交结果不自动重试。
- 当前31个流程入口中14个可办理，17个迁Moka入口保持停用。出差费用报销另行接入，不以费用报销代替。

此版本仅为本地候选，尚未公开发布。

## 2.7.1 — 正式付款交互本地候选

- 可按收款名称或单号查本人历史付款，经员工选择后参考收款方、开户行和账号；不复制历史金额、附件或关联关系。本次手动修改优先，完整收款资料仍在提交前核对。
- 支持整理员工提供的整段付款资料；账号保留前导零和长数字，以字符串处理，并与所给原文核对，不补猜数字。
- 本人有多个任职部门、业务线有多个候选时明确选择；每行费用类别与会计科目按合法配对结合用途给出建议，理由纳入可修改预览。
- 合并收集多行待选项，保留已有输入；资料改变后重新预览并等待新确认。正常隐藏字段无感，附件与未知结果处理沿用现有规则。

此版本仅为本地候选，尚未公开发布。

## 2.7.0 — 正式对外费用本地候选

新增正式对外费用支出申请 Skill，按现有生产表单规则办理。现有30个流程入口中13个可办理、17个只引导至Moka。

- 普通对外费用或对外付款使用正式入口；原对外付款示例仅在明确要求测试时使用。正式与示例的字段、目标及草稿互不替换。
- 保留现有收款方名称、账号、开户行填写方式；申请部门默认本人主部门，可选本人其他任职部门，内部部门值与名称由脚本分别处理。
- 项目付款支持各行选择项目部门，复用业务归属、主管、公司币种和费用科目联动；按需关联本人合同、用印或已完成的对外费用申请。
- 正式对外费用支持1至50行明细，原生附件至少1件、最多30件、单件100 MiB；示例附件仍限9件、20 MiB。最终业务预览后等待本人新确认，隐藏资料正常时无感，未知上传或提交结果不自动重试。
- 餐費與交通補貼归入财务组，沿用现有入口与规则。所有假期、销假及已迁移 HR 流程继续只引导至 Moka。

此版本仅为本地候选，尚未公开发布。

## 2.6.0 — 假期迁移指引本地候选

新增正式年假、年假销假、无薪病假、带薪病假、带薪病假销假、其他假期（婚产等）和事假七个独立迁移指引 Skill。现有29个流程入口中12个可办理、17个只引导至Moka。

- 所有假期和销假均已迁移至 HR 应用 Moka，当前不可在本包发起；原年假示例也已停用，不能替代正式流程。体检假同样转至 Moka。
- 对这些请求直接给出迁移提示，不收集办理资料、不查询余额或原单、不上传附件；旧草稿也不能继续提交。
- 已迁移的九项 HR 流程继续保持停用，餐費與交通補貼仍可办理。
- 其余可办理流程继续复用官方 OpenYida 登录态，在最终业务预览后等待本人新确认；未知上传或提交结果不自动重试。

此版本仅为本地候选，尚未公开发布。

## 2.5.0 — HR 目录与迁移指引本地候选

补齐 HR 目录，现共二十二个独立 Skill：十三项可办理，九项已迁移至 HR 应用 Moka。

- 员工证明、推荐候选人奖励、试用期计划、试用期转正、雇主提供居所、入职、离职、转岗和 HR 操作离职均提示前往 Moka；本包不收集其办理资料、不上传、不发起旧流程。
- 入职、离职、转岗和 HR 操作离职涉及重要人事变更，明确提示本人按 HR 指引办理，不建议通过 Agent 发起。
- 餐費與交通補貼继续可用；报销支付公司及个人收款初值共用同一套规则，保留用户修改与明确清空。
- 继续使用官方 OpenYida 登录态；可办理流程仍在最终业务预览后等待本人确认。

此版本仅为本地候选，尚未公开发布。

## 2.4.0 — HR 流程本地候选

新增餐費與交通補貼 Skill。支付公司按登录人的稳定 userid 匹配，收款资料首次从花名册带入并保留用户修改；加班起止时间保存到分钟，餐补、交通费和港币折算自动计算。

- 打卡证明与报销附件分别上传、分别预览，每栏最多20件、单件100 MiB；已完成上传可复用，未知结果不自动重传。
- 员工证明材料、推荐候选人奖励申请明确转至 HR 应用 Moka；本包停止其准备、上传和提交，旧草稿也不能继续发起。
- 可选的隐藏资料保持无感；餐费最终预览后仍等待本人确认。回读能够区分单选内部码和展示文字。

此版本仅为本地候选，尚未公开发布。

## 2.3.0 — 资产流程本地候选

新增正式采购、硬件申请和软件申请三个独立 Skill，现共十二个固定流程，继续使用已安装的官方 OpenYida CLI。

- 普通采购请求默认进入正式采购；原采购示例保留为单独入口。正式采购沿用明细、币种、汇率和联系人规则，支持最多 9 个、单件 20 MiB 的原生附件。
- 硬件申请整理设备明细、数量、单价及合计，按公司目录选择币种；软件申请支持申请、更改和取消，记录系统名称、使用人或部门及需求说明。
- 硬件和软件均支持最多 9 个、单件 100 MiB 的原生附件，并自动查找办公场所 IT 和固定 IT 部门的第一位主管。主管花名册只查姓名，员工无需填写隐藏资料。
- 三个流程各自配置目标、字段和资料来源，共用采购计算、资产资料及部门详情工具。仍在最终业务预览后等待本人确认，未知上传或提交结果不会自动重试。

此版本为本地候选，尚未公开发布。

## 2.2.0 — 首批五个发起流程本地候选

新增正式出差、合同、用印、名片和挂牌五个独立 Skill，保留原四个流程。公司、应用、表单、字段和资料来源统一配置，流程仅办理发起申请。

- 正式出差复用已有行程与预算规则，固定使用正式表单；合同支持正文原生附件、公司币种和汇率。
- 用印支持印章多选、公司对应执行人和可选的本人合同关联。文件按清单行分别绑定，同一文件可以用于不同行，已完成上传会复用。
- 名片按模板筛选办公场所，初次填入公司、地址及本人资料，之后保留员工手改和明确清空的内容。上环另一个房间号只问一次，改房号时保留其余地址。
- 挂牌默认本人，也可选择员工；仅读取所选人员必要资料，再按部门链联动原表单字段。同名会先请员工选择。
- 部门链、每流程最小花名册字段及可编辑初始值抽为共用工具。当前连接器请求与返回格式、用途和字段范围随包提供。
- 继续在最终预览后等待本人确认；修改内容使旧确认失效。提交成功与回读核对分别报告，未知上传或提交结果不自动重试。

此版本为本地候选，尚未公开发布。正式流程由 Owner 抽查提交，不逐个制造真实申请。云端服务和平台权限配置未变更。

## 2.1.0 — 精简官方接入与草稿确认修复

继续支持年假、出差、采购、对外付款四个独立 Skill，前置为官方 OpenYida CLI `2026.10.16`。

- 修复已登录本公司租户域名时仍被拒绝的问题，复用官方账号配置及登录状态。登录、查询、提交与回读改用官方公开命令，移除旧登录补丁和工作目录绑定。
- 准备草稿后先展示最终业务预览，随后等待员工新一条明确确认。读取预览前不能提交，修改草稿后原预览失效；最初说“提交”不能代替最终确认。此机制仍依赖客户端遵循 Skill，不能把脚本摘要当作本人授权证明。
- 正常隐藏字段在后台补齐；允许为空的数据继续按原业务规则处理。只在真正阻断时引导联系 HR、Finance 或 IT，不要求员工填写内部编号。
- 修复可空人员字段及单选编码/展示值造成的回读假阴性。已提交与回读核对分别报告，回读异常不会引导重提。
- 统一打包出差、采购、付款的原生附件说明，保留同草稿复用、最终清单确认、未知上传停止重传。空附件清单也纳入核对，避免漏报意外多出的附件。
- 员工只接收必要问题、草稿及结果；技术排查集中在 DEBUG 文档。

本版保持 Windows 试用状态；自动化与隔离安装不代替真实客户端确认和四流程办理验收。2.0 未提交草稿升级后需重新准备、预览；已提交及结果未知的申请先查原结果，不能重复发起。本次不更新云端服务或权限配置。

## 2.0.0 — OpenYida 附加技能包

FargoWork 改为官方 OpenYida CLI 的附加技能包。先安装官方 CLI，再由 AI 客户端安装 FargoWork；已有有效的官方登录状态可直接复用。

本版提供年假、出差、采购、对外付款四个独立 Skill，共用 JavaScript 完成资料查询、业务计算、草稿预览和确认提交。只办理包内指定的四个流程。

- 年假使用当前员工余额及工作日历，支持上午、下午和半天。
- 出差整理行程、项目和部门信息；采购查询币种及汇率，计算明细金额。
- 对外付款查询公司、供应商、费用类别、科目与申请部门，支持项目资料和本人已有流程关联。
- 出差、采购和付款采用宜搭原生附件，付款必须附文件。
- 提交前展示最终内容并等待一次确认；修改草稿后旧确认失效。提交或上传结果未知时停止自动重试，避免重复申请或文件。

本版无需注册 MCP，也不再安装独立 FargoWork 客户端或连接 FargoWork 附件服务。1.x 的客户端、会话和未完成草稿不会自动迁移；请先在原入口核对尚未确认结果的申请，避免重复发起。

适用 Windows，仍为试用版；不同账号的资料权限和四流程实际办理需要继续验收。Mac 尚未验收。OpenYida 的平台权限仍由管理员配置，本地 Skill 不能扩大或替代这些权限。
