'use strict';
const config=require('../../config/workflows/hr/transfer.json');
module.exports=require('../hr-common.cjs').retainedWorkflow(config);
