# FargoWork 排障（给支持 Agent）

员工正常使用只需要安装、钉钉登录、申请预览及一次提交确认。这里的技术步骤仅在排障时使用；不要求员工操作配置文件或提供凭据。

## 官方 CLI

使用安装输出的绝对路径，通常为 `$env:APPDATA\FargoWork\employee\bin\fargowork.exe`。通过 `--help` 核对当前命令，不猜其他目录或服务地址。

```powershell
& "$env:APPDATA\FargoWork\employee\bin\fargowork.exe" tools list --output jsonl
& "$env:APPDATA\FargoWork\employee\bin\fargowork.exe" tools call get_current_user --input-file './fargowork-arguments.json' --output jsonl
```

`tools call NAME` 的参数是 UTF-8 JSON 对象，可从 stdin 或 `--input-file` 输入。上例的身份查询参数为 `{}`，由 Agent 创建本次临时输入文件，调用后仅清理该文件。不要把业务内容拼接到 shell 命令，不自行写 Node/Python 客户端或传 Bearer header。工具目录及参数以当前服务返回的契约为准。

安装默认走官方 CLI：一次入口完成程序安装、员工登录和 Skill 加载；只读身份与流程目录可核验可用性，不能为验收提交流程。若 Skill 尚未加载，按安装输出路径读取员工 Skill，或采用宿主已核实的 Skill 加载入口，不把手写 MCP 配置转交给员工。

## 登录和错误

身份失效时运行官方 `login` 一次，引导本人完成钉钉授权。回调页不能单独证明已成功，最终以 CLI 身份核验为准。固定本地回调端口占用时报告明确错误，不杀其他进程、不随机换端口或连续重登。

实际命令权限被宿主或公司策略拒绝时，只说明必要的被阻止操作；不从已有成功推断 FullAccess，不修改系统策略或要求全面授权。对业务工具错误显示服务返回的安全提示和支持码，停止该事务；未知提交结果不自动重发，不改服务端或钉钉配置来绕过阻断。

## 诊断导出

仅在用户要求提供排障材料时运行：

```powershell
& "$env:APPDATA\FargoWork\employee\bin\fargowork.exe" diagnostics export --days 1 --destination './fargowork-support.zip' --output jsonl
```

目标必须是尚不存在的文件。`--days` 选择 1–7 天窗口，当前不按单个操作编号筛选。日志位于 `%APPDATA%\FargoWork\diagnostics`，保留 7 天、目录总量 20 MiB、单文件 2 MiB、单事件 2 KiB。导出只包含批准的事件字段，排除凭据、完整 URL、身份、画像及业务正文，不自动上传；导出副本由提供者自行管理。

不要读取 vault、OAuth 状态、原始 headers/query 或草稿正文来补日志。不要要求员工发 token、AppSecret、cookie、私钥或完整登录 URL。随机 attempt/request 编号只用于诊断关联，不证明身份或授权；Server/CLI 显示版本不能替代镜像冻结证据。

## 当前账号偏好

`profile show` 先验证当前企业身份，再返回当前账号的 `preferences.md` 路径。读取前与业务身份比较，不匹配时停止并新开会话。更新保留文档；升级选择只问一次，默认 `profile keep`，明确清空才 `profile reset`。不枚举或加载其他账号资料，不把偏好用于权限或最终提交授权。

## 附件

使用官方 `attachments` 命令直接调用公司附件服务，不需要宜搭连接器或新上传脚本。有效的业务与附件登录应复用；首次附件使用可能单独授权，尚未实现全流程统一一次扫码。两用途必须属于同一公司和同一员工，凭据不能互换。

只使用上传接口返回的稳定公网地址，不拼接 token、授权码或页面脚本的缓存参数。PC 钉钉可能在外部浏览器验证公司身份后查看、下载，这是支持的打开方式。

同一申请沿用原批次。CLI 在准备草稿前同步最终清单，Server 核验后将快照绑定到草稿；提交成功后以真实实例编号、同一快照和稳定幂等键自动通知。若业务已成功而 `attachment_binding` 待确认，只对原批次运行 `attachments notify --batch BATCH`；最多三次，包含首次自动通知。禁止重提业务来补附件，结果未知时先核查。

实际 SDK 可能将结构化或 JSON 文本结果包装为 `{"result": {...}}`。当前 CLI 已处理这一层；不要把外层没有 `draft_id` 当作业务失败，也不要自行构造草稿编号或绕过最终清单校验。

## 旧客户端连接迁移

本版只提供 CLI 和员工 Skill，已移除 stdio Bridge、宿主 MCP 注册和启动器。CLI 仍管理 OAuth 和到服务端的 MCP HTTP 调用。升级仅清理有旧自有记录且命令、参数和环境精确吻合的连接；外来、修改过或无法安全读取的配置保留并提示人工查看。WorkBuddy 旧记录没有完整精确配置证据，因此不自动删除。旧 Bridge 文件若无法核对包内文件摘要，保留恢复材料并给出路径；凭据及员工画像不清空。

Fargo AI/Fargo Pass 是另一产品，保持其配置、凭据和日志。当前发布支持 Windows x64，四流程是公司测试用途，服务端实时检查 `MCP_allow` 提交角色；Mac 与正式业务尚未开放。
