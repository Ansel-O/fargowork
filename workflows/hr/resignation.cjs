'use strict';
const config=require('../../config/workflows/hr/resignation.json');
module.exports=require('../hr-common.cjs').retainedWorkflow(config);
