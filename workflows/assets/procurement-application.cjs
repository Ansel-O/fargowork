'use strict';
const {createProcurementWorkflow} = require('../procurement-common.cjs');
module.exports = createProcurementWorkflow(require('../../config/workflows/assets/procurement_application.json'));
