'use strict';

const {
  check
} = require('./common.cjs');
const APP = 'APP_GITLRTH76PM6J4M29F5D',
  CORP = 'ding376dac86ffe9d2dbf2c783f7214b6d69';
const ROOT = 'https://www.aliwork.com',
  TENANT = 'https://xdlonl.aliwork.com';
const roster = {
  connectorId: 'Http_5c72b42d47f14a1983767932f6c1d4f1',
  actionId: 'getUserMessage',
  type: 'httpConnector',
  connection: 15597
};
const codes = {
  annual_leave: 'TPROC--WG966BA1VCF7W4FBOP58AAA4HA5Y3HY7QNIRM0',
  business_trip: 'TPROC--V5D66D91YB17BO1GK96R0ABOKNOY24HPFT1RM3',
  procurement_request: 'TPROC--V0A667D1W3Q9FCAWIMSC7DC5E8H63XBMP3RUM1',
  external_expense_request: 'TPROC--75G66PD11X2AKIO9MWLLO68KHRB9257KSEAVM3'
};
const registry = {
  annual_leave: require('../../workflows/annual-leave.cjs'),
  business_trip: require('../../workflows/business-trip.cjs'),
  procurement_request: require('../../workflows/procurement-request.cjs'),
  external_expense_request: require('../../workflows/external-expense-request.cjs')
};
function workflow(key) {
  check(Object.hasOwn(registry, key), 'WORKFLOW_NOT_ALLOWED');
  return registry[key];
}
function processCode(key) {
  workflow(key);
  check(codes[key], 'FIXED_PROCESS_CODE_UNAVAILABLE');
  return codes[key];
}
const relatedSources = {
  contract: {
    form: 'FORM-3DB996CA240D4F3FAB0CC8C9E72A092BUJGU',
    title: 'textField_m0ezwbjl',
    subtitle: 'serialNumberField_m0ewp8f9'
  },
  seal: {
    form: 'FORM-ABF68B75000543F4A34EFCB284AC13FAZL8E',
    title: 'serialNumberField_m0yw02li',
    subtitle: 'selectField_m9ur9e78'
  }
};
module.exports = {
  APP,
  CORP,
  ROOT,
  TENANT,
  roster,
  registry,
  workflow,
  processCode,
  relatedSources
};
