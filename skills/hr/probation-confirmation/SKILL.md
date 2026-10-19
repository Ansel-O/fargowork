---
name: probation-confirmation
description: 试用期转正申请已迁移至 HR 应用 Moka。仅提示办理入口，不在 FargoWork 发起。
---

# 试用期转正申请

收到此类请求，直接告知：**该流程不可发起，请转至 HR 应用 Moka。**

不收集个人资料或附件，不登录、起草或提交旧宜搭流程，不搜索同名表单替代，不修改迁移状态。
需要核对状态时，在包根执行 `node scripts/fargowork.cjs requirements probation_confirmation`；该命令不查询个人资料。

