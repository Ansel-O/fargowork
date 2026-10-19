---
name: business-card
description: 使用 FargoWork 为当前登录员工发起名片申请，读取固定模板和地点候选，保留本人填写的名片内容并可附 PDF。
---

# 名片申请

从本文件位置向上三级确定包根，在包根执行：

```text
node scripts/fargowork.cjs status
node scripts/fargowork.cjs requirements business_card
node scripts/fargowork.cjs prepare business_card --input <绝对路径的UTF-8业务JSON>
node scripts/fargowork.cjs preview <draftId>
```

可提供 `quantity`（200 或 500）、`template`、`office`、`print_method`（电子版或纸质版）、`purpose`、`mailing_address`、中英文名片字段和 `remarks`。模板筛选非空的办公场所候选；唯一场所自动带入，多项时请员工选择，也允许明确留空。审批用公司始终取本人合同公司，模板品牌不会替换该字段。

公司名、地址和本人联系信息只作初次填充，随后可按员工意愿修改。收到补充或修改后，始终在原草稿使用 `prepare business_card --input <文件> --draft <draftId>`；省略的文字保留，明确传空字符串表示清空。更换模板或场所只更新有关的自动字段，不覆盖已手改文字。不要为了改地址重建草稿或重新填整组资料。

数量和打印方式沿用原表默认的 200、电子版；员工有要求时再修改，明确清空也保留。不为技术核对反复询问已由配置确定的选项来源。

办公场所为上环办公室时，按 `needsInput` 问一次是否改用另一个房间号 `Room 4309-4310/09-10室`；回答保留传 `sheung_wan_address: "keep"`，回答替换传 `"alternate"`。脚本只替换对应语言地址的房间号，保留其余地址；识别不了时请员工提供完整地址。已经确认或明确手填地址后不重复追问，不重新执行整组联动。

PDF 可选，使用顶层 `attachments` 数组提供真实文件的绝对路径。同一名片草稿的补充答复省略此项会保留已有文件；明确传 `attachments: []` 才移除。“HR制作后名片”和“名片确认”均属于后续节点，发起时不询问、不赋值、不列入预览，即使原页面可见。这里的“名片确认”字段与提交前必须保留的草稿确认是两件事。

部分模板或办公地点可能对应多个公司名或地址。遇到多个候选时，请员工选择或填写要印制的文本，不猜测拼接。展示两语名片全文、数量、模板、办公地点及可选 PDF 文件名后停下，等待员工对本次预览的新确认。正常隐藏字段不出现在员工确认中。

确认后使用同一草稿摘要提交一次。结果未知时先核对，不重提、不重传。只查询当前登录人的花名册字段，不查询其他员工；审批由宜搭流程处理。
