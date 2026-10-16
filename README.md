# FargoWork

FargoWork 是基于官方 **OpenYida CLI** 的公司流程附加技能包。把下面这句话交给能执行本机命令的 AI 客户端即可：

> 请从 https://github.com/Ansel-O/fargowork 安装或更新 FargoWork，按仓库说明准备官方 OpenYida CLI 并完成登录。

安装顺序是：先安装[官方 OpenYida CLI](https://github.com/openyida/openyida)，再安装 FargoWork 附加技能包。已有可用的官方登录会话会直接复用；需要登录时，由你本人完成钉钉授权。Agent 的安装与调用入口是 [SKILL.md](SKILL.md)。

装好后，直接说“帮我申请明天上午半天年假”等业务需求。Agent 会收集必要信息、生成预览，等你确认后提交。

本版支持四个固定流程：**年假申请、出差申请、采购申请、对外付款申请**。其他流程即使能被 OpenYida 找到，也不属于本包的办理范围，不能自行替换。

- 适用环境：Windows、Node.js 22 或以上及 npm。缺少运行环境时，请按公司 IT 规范从 Node.js 官网安装；安装器不会自动提权。Mac 尚未验收。
- 官方 CLI 按[入口 Skill](SKILL.md#首次安装)通过 `npm install -g openyida` 安装。FargoWork 保存在当前用户目录，复用已安装的官方 CLI，不另装一份 OpenYida，也无需手动注册 MCP。请保留整个技能包，单独复制 Skill 文件会丢失共用脚本。
- 出差、采购和付款支持宜搭原生附件，付款必须有附件。每次最多 9 个、单个不超过 20 MiB；本包支持 PDF、PNG、JPEG、GIF、WebP、TXT、DOCX、XLSX、PPTX，具体流程还须符合原表单允许的类型。

当前为 **2.0.0 预发布试用版**，四流程仍需按实际账号权限完成使用验收。连接器与权限边界见 [连接器说明](references/CONNECTORS.md)，遇到问题见 [DEBUG](references/DEBUG.md)。
