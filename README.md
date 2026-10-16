# FargoWork

FargoWork 是官方 **OpenYida CLI** 的公司流程附加技能包。把这句话交给能执行本机命令的 AI 客户端：

> 请从 https://github.com/Ansel-O/fargowork 安装或更新 FargoWork，按仓库说明准备官方 OpenYida CLI 并完成登录。

**前置需要安装官方 OpenYida CLI**，再安装本包；已有官方登录会话直接复用。安装及调用入口是 [SKILL.md](SKILL.md)。本版以官方 CLI `2026.10.16` 为验证基线，官方项目见 [openyida/openyida](https://github.com/openyida/openyida)。

装好后，直接说“帮我申请明天上午半天年假”。Agent 会补问必要业务信息，展示草稿，**停下来等你确认后再提交**。正常办理不展示隐藏字段或执行日志。

- 四个固定流程：**年假申请、出差申请、采购申请、对外付款申请**。其他流程不在本包办理范围。
- 出差、采购和付款支持宜搭原生附件，付款必须附文件。每次最多 9 个、单件不超过 20 MiB，实际格式和数量以原表单为准。[附件使用规则](references/ATTACHMENTS.md)
- Windows、Node.js 22 或以上及 npm；Mac 尚未验收。不另装一份 OpenYida，不注册 MCP，不连接另一套附件服务。
- 仅在问题确实影响办理时提示协助核查：组织假勤找 HR，财务资料找 Finance，技术或不明确的问题找 IT。允许为空的隐藏字段保持无感。

当前为 **2.1.0 预发布试用版**，真实客户端的确认停点及四流程办理仍需使用验收。[连接器与权限边界](references/CONNECTORS.md) · [DEBUG](references/DEBUG.md)
