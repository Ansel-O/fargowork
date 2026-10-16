'use strict';

const {check, today} = require('./common.cjs');
const {ROOT, TENANT, CORP} = require('./policy.cjs');
const cli = require('./official-cli.cjs');
function context({optional = false} = {}) {
  const s = cli.run(['auth', 'status']);
  check(s && typeof s === 'object' && !Array.isArray(s), 'AUTH_STATUS_UNAVAILABLE');
  check(s.status !== 'profile_required' && s.failure_reason !== 'profile_required', 'OPENYIDA_PROFILE_REQUIRED');
  if (s.base_url) check([ROOT, TENANT].includes(s.base_url), 'OPENYIDA_ENVIRONMENT_UNSUPPORTED');
  if (s.corp_id) check(s.corp_id === CORP, 'COMPANY_MISMATCH');
  if (optional && (!s.user_id || !s.corp_id || s.can_auto_use === false || s.status !== 'ok')) return null;
  check(s.status === 'ok' && s.can_auto_use !== false && s.user_id && s.corp_id && [ROOT, TENANT].includes(s.base_url), 'OPENYIDA_LOGIN_REQUIRED');
  return s;
}
function actorFrom(s) {
  return {userid: s.user_id, corp_id: s.corp_id, name: s.user_name || s.user_id};
}
function actor() { return actorFrom(context()); }
function same(before, after) {
  check(after.user_id === before.user_id && after.corp_id === before.corp_id, 'IDENTITY_CHANGED');
}
async function command(args, options = {}) {
  const before = context();
  const result = cli.run(args, {...options, identity: before});
  same(before, context());
  return result;
}
async function token() {
  const before = context();
  // Only the official provider resolves credentials and performs any refresh.
  // There is no local expiry timer, auth-store access or business-request retry.
  const t = await cli.gapProvider().getAccessToken({
    authProfile: before.auth_profile || undefined, corpId: before.corp_id, userId: before.user_id});
  check(typeof t === 'string' && t.length > 0, 'OPENYIDA_LOGIN_REQUIRED');
  same(before, context());
  return t;
}
async function status() {
  const s = context({optional: true});
  return {status: s ? 'ready' : 'login_required', ...(s ? {actor: actorFrom(s)} : {}),
    businessDate: today(), timeZone: 'Asia/Shanghai'};
}
async function login() {
  const current = await status();
  if (current.status === 'ready') return current;
  cli.run(['login'], {login: true});
  const result = await status();
  check(result.status === 'ready', 'LOGIN_NOT_COMPLETED');
  return result;
}
async function logout() {
  cli.run(['logout']);
  return {status: 'logged_out'};
}
module.exports = {actor, token, status, login, logout, command};
