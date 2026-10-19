'use strict';
const {createLeaveWorkflow}=require('../leave-common.cjs');
module.exports=createLeaveWorkflow(require('../../config/workflows/leave/annual_leave_application.json'));
