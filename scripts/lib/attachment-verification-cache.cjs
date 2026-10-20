'use strict';
const fs=require('node:fs'),path=require('node:path');
const {digest,read,write}=require('./common.cjs');
const {verifyDownload}=require('./native-attachment.cjs');
const MAX_AGE_MS=15*60*1000;
function createAttachmentVerifier({stateDir,actor,workflow,verify=verifyDownload,now=()=>Date.now()}) {
  const file=path.join(stateDir,'attachment-verification.json');
  let entries={};
  if(fs.existsSync(file)) {
    try {const value=read(file);if(value.version===1&&value.entries&&typeof value.entries==='object') entries=value.entries;} catch {}
  }
  return async args=>{
    const key=digest({actor:{userid:actor.userid,corp_id:actor.corp_id},workflow,
      reference:args.reference,sha256:args.expectedSha256});
    const at=now(),prior=entries[key];
    if(Number.isFinite(prior)&&at>=prior&&at-prior<MAX_AGE_MS) return {verified:true,reused:true};
    await verify(args);
    const completed=now();
    entries=Object.fromEntries(Object.entries(entries).filter(([,time])=>Number.isFinite(time)&&completed>=time&&completed-time<MAX_AGE_MS));
    entries[key]=completed;write(file,{version:1,entries});
    return {verified:true,reused:false};
  };
}
module.exports={createAttachmentVerifier,MAX_AGE_MS};
