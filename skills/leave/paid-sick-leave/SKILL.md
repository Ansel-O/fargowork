---
name: paid-sick-leave
description: 带薪病假申请已停用。正式假期及销假均已迁移至 HR 应用 Moka，不在 FargoWork 发起。
---

# 带薪病假申请

收到此类办理请求，直接告知：**该流程不可发起，请转至 HR 应用 Moka。**

不收集日期、事由、身份资料或附件，不登录、查询余额、起草或提交旧宜搭流程，不搜索同名表单替代，不修改迁移状态。旧草稿也不能继续提交；年假Demo仅供明确测试，不是正式假期的替代入口。
需要核对当前状态时，在包根执行 `node scripts/fargowork.cjs requirements paid_sick_leave`；该命令不查询个人资料。

体检假也请转至 Moka，按当前 HR 规则办理；不检索或发起旧体检假流程。
