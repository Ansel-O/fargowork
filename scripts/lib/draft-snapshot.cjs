'use strict';

// A draft-local record of already authorized, projected company reads. This is
// a performance contract, not a server-side permission boundary. Credentials,
// raw HTTP responses and write results never enter this cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {check, digest, read, write} = require('./common.cjs');
const TTL_MS = 24 * 60 * 60 * 1000;
const clone = value => structuredClone(value);
const identity = actor => ({userid:actor.userid, corp_id:actor.corp_id});
const dateAt = instant => new Date(instant + 8 * 3600000).toISOString().slice(0,10);

function createDraftSnapshot({stateDir,workflow,actor,now=Date.now,legacy=false,refresh=false}) {
  const file = path.join(stateDir,'source-snapshot.json');
  const owner = {workflow,actor:identity(actor)};
  let state;
  if(fs.existsSync(file)) {
    state=read(file);
    check(state.version===1 && digest(state.owner)===digest(owner),'DRAFT_SOURCE_IDENTITY_MISMATCH');
    check(state.entries && typeof state.entries==='object' && !Array.isArray(state.entries)
      && typeof state.generation==='string','DRAFT_SOURCE_SNAPSHOT_INVALID');
  } else {
    check(!legacy || refresh,'DRAFT_REFRESH_REQUIRED');
  }
  function reset() {
    const at=now();
    check(Number.isFinite(at),'DRAFT_SOURCE_CLOCK_INVALID');
    state={version:1,owner,generation:crypto.randomUUID(),capturedAt:new Date(at).toISOString(),
      businessDate:dateAt(at),startedAt:null,expiresAt:null,entries:{}};
    write(file,state);
  }
  if(!state || refresh) reset();
  function assertValid() {
    const at=now(),start=Date.parse(state.startedAt||state.capturedAt);
    const end=state.expiresAt?Date.parse(state.expiresAt):start+TTL_MS;
    check(Number.isFinite(at)&&Number.isFinite(start)&&Number.isFinite(end)&&at>=start,
      'DRAFT_SOURCE_CLOCK_INVALID');
    check(at<end,'PROCESS_DRAFT_EXPIRED');
  }
  function activate() {
    assertValid();
    if(!state.startedAt) {
      const at=now();state.startedAt=new Date(at).toISOString();
      state.expiresAt=new Date(at+TTL_MS).toISOString();write(file,state);
    }
    return metadata();
  }
  function metadata() {
    return {generation:state.generation,startedAt:state.startedAt,expiresAt:state.expiresAt,
      businessDate:state.businessDate};
  }
  const pending=new Map();
  let onlyCached=false;
  async function get(kind,scope,operation,{cacheWhen=()=>true,readOnly=false}={}) {
    assertValid();
    scope=JSON.parse(JSON.stringify(scope));
    const key=digest({kind,scope}),entry=state.entries[key];
    if(entry) {
      check(entry.sha256===digest(entry.value),'DRAFT_SOURCE_SNAPSHOT_CHANGED');
      return clone(entry.value);
    }
    check(!readOnly&&!onlyCached,'DRAFT_SOURCE_REFRESH_REQUIRED');
    if(!pending.has(key)) pending.set(key,Promise.resolve().then(operation).then(value=>{
      assertValid();
      if(value!==undefined&&cacheWhen(value)) {
        const clean=JSON.parse(JSON.stringify(value));
        state.entries[key]={kind,scope:clone(scope),value:clean,sha256:digest(clean)};
        write(file,state);
      }
      return value;
    }).finally(()=>pending.delete(key)));
    return clone(await pending.get(key));
  }
  return {get,activate,assertValid,metadata,reset,onlyCached:()=>{onlyCached=true;}};
}

// Alternative injected runtimes (including offline tests) get the same source
// semantics. Native runtime caches after policy validation and picker replay.
function bindRuntime(runtime,snapshot) {
  if(typeof runtime.setReadCache==='function') {runtime.setReadCache(snapshot);return runtime;}
  const bind=context=>{
    const result={...context,today:snapshot.metadata().businessDate,
      todayMs:Date.parse(snapshot.metadata().businessDate+'T00:00:00+08:00')};
    for(const method of ['schema','query','roster','related','invoke','departmentRole','rosterForSelectedEmployee','searchEmployees']) {
      if(typeof context[method]!=='function') continue;
      result[method]=async(...args)=>{
        const actor=runtime.actor();
        const value=await snapshot.get('runtime.'+method,{subject:context.subject?.userid||actor.userid,args},
          ()=>context[method](...args));
        runtime.actor();return value;
      };
    }
    if(typeof context.forSubject==='function') result.forSubject=user=>bind(context.forSubject(user));
    return result;
  };
  return {...runtime,ctx:bind(runtime.ctx)};
}

function differences(before,after,prefix='') {
  const output=[];
  if(digest(before??null)===digest(after??null)) return output;
  if(before&&after&&typeof before==='object'&&typeof after==='object') {
    for(const key of new Set([...Object.keys(before),...Object.keys(after)]))
      output.push(...differences(before[key],after[key],prefix?prefix+'.'+key:key));
    return output;
  }
  return [{field:prefix,before:before??null,after:after??null}];
}
module.exports={TTL_MS,createDraftSnapshot,bindRuntime,differences};
