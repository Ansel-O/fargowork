'use strict';
const config=require('../../config/workflows/hr/hr_offboarding.json');
module.exports=require('../hr-common.cjs').retainedWorkflow(config);
