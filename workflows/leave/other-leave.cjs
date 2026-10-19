'use strict';
const {createLeaveWorkflow}=require('../leave-common.cjs');
module.exports=createLeaveWorkflow(require('../../config/workflows/leave/other_leave.json'));
