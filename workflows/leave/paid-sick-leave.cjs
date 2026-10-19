'use strict';
const {createLeaveWorkflow}=require('../leave-common.cjs');
module.exports=createLeaveWorkflow(require('../../config/workflows/leave/paid_sick_leave.json'));
