'use strict';
const {createLeaveWorkflow}=require('../leave-common.cjs');
module.exports=createLeaveWorkflow(require('../../config/workflows/leave/personal_leave.json'));
