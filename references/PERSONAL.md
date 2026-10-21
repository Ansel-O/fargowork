# 本机 personal 偏好

personal 只保存经用户确认的非敏感偏好和结构化业务习惯提示。它独立于版本安装目录，按官方当前公司账号隔离；升级沿用同一数据根，跨设备同步不属首版。个人数据不随包分发。

Agent 可以主动提出记忆建议，只有用户明确确认后才保存。临时选择不自动学习，不按出现次数自动保存。用户明确要求删除或清空即授权操作，不追加一次确认。

## 工具与参数

runner 接入 `personal view|set|delete|clear`。业务输入只允许 `values` 或 `keys`，不允许目标用户、公司、路径或身份参数：

| 操作 | 模块调用 | 含义 |
| --- | --- | --- |
| 查看 | `store.view()` | 返回当前账号偏好及使用边界 |
| 设置 | `store.set({values:{trip_purpose_hint:'customer_visit'},confirmed:true})` | 用户明确确认后按键合并，不清掉其他偏好 |
| 删除 | `store.delete({keys:['trip_purpose_hint']})` | 删除指定偏好，无额外确认 |
| 清空 | `store.clear()` | 清空当前账号偏好，无额外确认 |

`set` 的 `confirmed:true` 只可在收到用户明确保存／修改记忆的确认后由runner传入；它是本地工具约束，不是可信的人类授权凭证。

从包根运行（文件必须是绝对路径 UTF-8 JSON）：

```text
node scripts/fargowork.cjs personal view
node scripts/fargowork.cjs personal set --input <文件> --confirm yes
node scripts/fargowork.cjs personal delete --input <文件>
node scripts/fargowork.cjs personal clear
```

保存文件例如 `{"values":{"trip_purpose_hint":"customer_visit"}}`，删除文件例如 `{"keys":["trip_purpose_hint"]}`。不能把账号、公司或存储路径放入文件。`--confirm yes` 只能在用户同意保存这项偏好后使用。

```js
const {createPersonalStore} = require('./scripts/lib/personal.cjs');
const personal = createPersonalStore(); // 默认通过官方 auth.actor() 取得当前身份
const result = personal.view();
// result.status: ready | empty | unavailable
// result.values: 只含下表白名单；result.warnings: 安全错误码
```

`createPersonalStore({root,actorResolver})` 的两个选项仅供受信任调用方依赖注入及离线测试，不能从CLI业务输入取值。`actorResolver` 为同步函数，返回官方适配器的 `{corp_id,userid}`；公司必须匹配当前公司配置。业务请求不能指定任意目标，也不借代办读取对方personal。

## 首版字段

字段平铺在 `values`，只接受枚举字符串；未知键、嵌套对象、自由文本指令及不符类型均拒绝。

| key | 允许值 | 用途 |
| --- | --- | --- |
| `language` | `zh-CN`、`zh-TW`、`en` | 表达语言 |
| `verbosity` | `brief`、`normal`、`detailed` | 说明详略 |
| `display_mode` | `table`、`list` | 展示偏好 |
| `date_format` | `YYYY-MM-DD`、`DD/MM/YYYY`、`MM/DD/YYYY` | 日期展示；不改业务日期语义 |
| `amount_format` | `plain`、`grouped` | 金额展示；不改精度、币种或计算 |
| `trip_purpose_hint` | `internal_collaboration`、`customer_visit` | 常见内部协作／拜访客户提示 |
| `expense_context_hint` | `normal`、`project` | 常见普通／项目费用提示 |

业务习惯只帮助Agent组织建议与提问，必须核对本次事实和当前合法目录，不能直接赋为申请事实或公司规则。本次明确输入优先；默认收款仍取花名册，记忆不能触发换卡检索。personal不保存银行账号、户名等完整敏感收款资料、凭据、原始单据／业务全文或任意override指令。

## 存储与异常

默认位置为 `dataRoot()/personal/<公司哈希>/<公司账号哈希>.json`，与 `dataRoot()/packages/<版本>/` 分开；默认Windows数据根是 `%LOCALAPPDATA%/FargoWorkOpenYida`，沿现有 `FARGOWORK_OPENYIDA_HOME` 数据根设置。路径及文件不使用账号原文，记录仅有schema版本、账号归属哈希、枚举偏好和更新时间，不含业务原文。schema版本与Skill包版本独立。

空结构说明如下，不随包生成账号文件；未保存偏好时直接返回空 `values`：

```json
{"schemaVersion":1,"ownerKey":"<公司账号哈希>","values":{},"updatedAt":"<UTC时间>"}
```

模块原子替换JSON，使用账号级写锁避免并发写丢失；读取不会等待写锁。损坏、不兼容schema、归属不符、身份不可用或存储故障时返回 `unavailable`、空 `values` 和安全错误码；Agent退回正常询问／取数，不能让personal故障阻止正常办理，也不能把未读到偏好当业务事实。写入失败不宣称已保存。

不兼容或损坏资料不会被一次set／部分delete静默覆盖；用户明确clear可删除当前账号文件，再重新确认保存。并发写繁忙时可稍后重试；中断遗留锁由维护者／IT核实后排查，不自动删除其他进程的锁。不手工改官方Skill、脚本或config解决偏好问题。

这些都是客户端约束，不能防止拥有本机写权限者篡改文件。关键业务规则仍由原工具和平台校验，personal不覆盖固定来源、公式、授权范围或必要确认。原生业务草稿及本次提交必要数据不属于personal，不宣称业务全程零落盘。

## 本次换收款卡

默认从本次报销人的花名册取得收款资料；偏好或“以前用过两张卡”本身不触发查询。只有用户明确要求换账号／卡，才在同一草稿主表补答中使用 `bank_history_action:"search"`。可选 `bank_history_query` 仅在已获准的本人候选中按银行名称、尾号等筛选，不扩大范围。

四个正式个人报销（费用、出差、体检、餐费交通）共用固定历史来源，按本公司、本人报销人、已完成且审批同意筛选。不能查询代办对象的历史收款，也不混入外部付款、Demo 或默认卡变更申请。字段由原流程配置固定；平台可能返回整条记录，工具仅投影必要字段供匹配使用，不承诺平台只传这五项。

候选返回前先核对本人和花名册收款户名；户名缺少、冲突或未能确定的别名先核实，不以同名、昵称或发起人身份证明卡归属。personal 首版不存户名；本次已确认的补充只留在该草稿。没有记录、无权限或缺少必要资料时，可用 `bank_history_action:"manual"` 并由用户自行提供，不能扩大查询。

向用户展示工具的遮掩候选。用户选中后，仅补答工具返回的 `bank_history_choice`；账号、户名、开户行、城市、支行整组切换，原流程允许空的字段仍可空，不能混入旧卡字段。需要再修改时，用同一草稿明确补答相应收款字段。自行提供同样允许本次修改，最终预览核对实际整组资料；不代表银行卡当前有效或花名册默认卡已变更。

历史候选及完整收款资料不写入 personal。取得的合法历史来源随草稿在24小时内复用，提交不重复联网查询；用户主动刷新或过期重取后如有变化，展示并确认。本人历史读取失败不自动换用另一张卡，已明确的本次手工资料仍保留。
