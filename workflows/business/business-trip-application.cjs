'use strict';

const formal = require('../../config/workflows/business/business_trip_application.json');
const {createBusinessTripWorkflow} = require('../business-trip-common.cjs');

module.exports = createBusinessTripWorkflow(formal);
