'use strict';

// Client-side business scope only. Platform/connector authorization must still
// enforce who may act for another employee; this module never changes actor.
const {check} = require('../scripts/lib/common.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const userId = value => typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,160}$/.test(value);

function delegationActors(policy) {
  if (policy?.delegation === undefined) return [];
  const config = policy.delegation;
  check(object(config) && Object.keys(config).every(key => key === 'allowedActors')
    && Array.isArray(config.allowedActors) && config.allowedActors.length > 0
    && config.allowedActors.length <= 50 && config.allowedActors.every(userId)
    && new Set(config.allowedActors).size === config.allowedActors.length, 'WORKFLOW_DELEGATION_POLICY_INVALID');
  return [...config.allowedActors];
}

function canDelegate(actor, policy) {
  return delegationActors(policy).includes(actor?.userid);
}

function resolveWorkflowSubject({actor, policy, selectedUserId, candidates = []}) {
  check(object(actor) && userId(actor.userid) && typeof actor.corp_id === 'string'
    && actor.corp_id.trim() && actor.corp_id.length <= 256 && !/[\x00-\x1f\x7f]/.test(actor.corp_id),
  'CURRENT_IDENTITY_MISSING');
  delegationActors(policy);
  const id = selectedUserId === undefined ? actor.userid : selectedUserId;
  check(userId(id), 'WORKFLOW_SUBJECT_INVALID');
  if (id === actor.userid) return Object.freeze({userid: id, corp_id: actor.corp_id,
    name: actor.name || actor.userid, delegated: false});
  check(canDelegate(actor, policy), 'WORKFLOW_DELEGATION_NOT_ALLOWED');
  check(Array.isArray(candidates), 'EMPLOYEE_SOURCE_INVALID');
  const matches = candidates.filter(row => object(row) && row.userId === id);
  check(matches.length === 1, 'EMPLOYEE_SELECTION_REQUIRED');
  const selected = matches[0];
  check(selected.corpId === undefined || selected.corpId === actor.corp_id, 'EMPLOYEE_COMPANY_MISMATCH');
  check(typeof selected.userName === 'string' && selected.userName.trim()
    && selected.userName.length <= 160 && !/[\x00-\x1f\x7f]/.test(selected.userName), 'EMPLOYEE_SOURCE_INVALID');
  return Object.freeze({userid: id, corp_id: actor.corp_id, name: selected.userName.trim(), delegated: true});
}

module.exports = {delegationActors, canDelegate, resolveWorkflowSubject};
