'use strict';
const {createLeaveWorkflow}=require('../leave-common.cjs');
module.exports=createLeaveWorkflow(require('../../config/workflows/leave/unpaid_sick_leave.json'));
