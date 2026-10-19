'use strict';
const config=require('../../config/workflows/hr/onboarding.json');
module.exports=require('../hr-common.cjs').retainedWorkflow(config);
