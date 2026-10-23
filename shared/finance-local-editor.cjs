'use strict';

// A draft-bound localhost writer. It never calls Yida, changes the canonical
// business input, chooses a filename from HTTP, or grants submission consent.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {check,read,write,digest,safeCode}=require('../scripts/lib/common.cjs');
const Editor=require('./finance-detail-editor.cjs'),Markdown=require('./finance-markdown.cjs');
const VERSION=require('../package.json').version;
const PROTOCOL=1,MAX_FILE=8*1024*1024,MAX_BODY=1024*1024,MAX_LIFE=24*60*60*1000,IDLE=2*60*60*1000;
const runtimeName='editor-local-runtime.json';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sessionPattern=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/session\/([a-f0-9]{48})\/$/;
function localFile(file) {
  const stat=fs.lstatSync(file);
  check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_FILE,'DETAIL_EDITOR_FILE_INVALID');
  return fs.readFileSync(file,'utf8');
}
function atomicText(file,content,expected) {
  const original=localFile(file);
  check(expected===undefined||original===expected,'DETAIL_EDITOR_REVISION_CONFLICT');
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try {
    const fd=fs.openSync(temporary,'wx',0o600);
    try {fs.writeFileSync(fd,content,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    check(localFile(file)===original,'DETAIL_EDITOR_REVISION_CONFLICT');
    fs.renameSync(temporary,file);
    check(localFile(file)===content,'DETAIL_EDITOR_SAVE_NOT_VERIFIED');
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function withDraftLock(dir,operation) {
  const lock=path.join(dir,'command.lock');let fd;
  try {fd=fs.openSync(lock,'wx',0o600);}catch {check(false,'DRAFT_BUSY_OR_INTERRUPTED');}
  try {fs.writeFileSync(fd,JSON.stringify({pid:process.pid,operation:'local-editor'})+'\n');fs.fsyncSync(fd);return operation();}
  finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
function draftFiles(dir) {
  check(path.isAbsolute(dir),'DETAIL_EDITOR_TARGET_MISMATCH');
  const document=JSON.parse(localFile(path.join(dir,'editor-document.json')));
  const state=JSON.parse(localFile(path.join(dir,'editor-file.json')));
  check(Editor.supports(document.workflow)&&Markdown.supports(document.workflow)
    &&state.workflow===document.workflow&&state.format==='md'&&path.isAbsolute(state.path)
    &&path.extname(state.path).toLowerCase()==='.md'&&!state.pendingGeneration,'DETAIL_EDITOR_FILE_INVALID');
  localFile(state.path);
  return {draftId:document.draftId,workflow:document.workflow,target:path.resolve(state.path)};
}
function currentDraft(dir,binding) {
  const documentText=localFile(path.join(dir,'editor-document.json')),document=JSON.parse(documentText);
  const infoText=localFile(path.join(dir,'input.json')),info=JSON.parse(infoText);
  const fileState=JSON.parse(localFile(path.join(dir,'editor-file.json')));
  check(document.draftId===binding.draftId&&document.workflow===binding.workflow&&info.workflow===binding.workflow
    &&fileState.workflow===binding.workflow&&fileState.format==='md'
    &&path.resolve(fileState.path)===binding.target,'DETAIL_EDITOR_TARGET_MISMATCH');
  check(!fileState.pendingGeneration&&fileState.baseRevision===document.baseRevision
    &&digest(info.input)===digest(document.baseInput),'DETAIL_EDITOR_REVISION_CONFLICT');
  const processFile=path.join(dir,'process','state.json');
  if(fs.existsSync(processFile))check(JSON.parse(localFile(processFile)).status==='prepared','DETAIL_EDITOR_DRAFT_CLOSED');
  const sourceFile=path.join(dir,'source-snapshot.json');
  if(fs.existsSync(sourceFile)) {
    const source=JSON.parse(localFile(sourceFile));
    const expires=source.expiresAt?Date.parse(source.expiresAt):Date.parse(source.startedAt||source.capturedAt)+MAX_LIFE;
    check(Number.isFinite(expires)&&Date.now()<expires,'PROCESS_DRAFT_EXPIRED');
  }
  const content=localFile(binding.target),fileHash=hash(content);
  return {document,info,content,fileHash,version:hash(documentText+'\0'+infoText+'\0'+content)};
}
function publicError(error) {
  const code=safeCode(error);
  const conflict=['DETAIL_EDITOR_REVISION_CONFLICT','DETAIL_EDITOR_TARGET_MISMATCH'].includes(code);
  const message=conflict?'草稿已更新，请重新打开明细后再修改，当前修改尚未保存。'
    :code==='DRAFT_BUSY_OR_INTERRUPTED'?'Agent 正在处理这份草稿，请稍后再保存。'
    :code==='PROCESS_DRAFT_EXPIRED'?'草稿已到期，请告诉 Agent 刷新后继续。'
    :code==='DETAIL_EDITOR_DRAFT_CLOSED'?'这份申请已进入提交阶段，不能再保存修改。'
    :'修改未保存，请保留页面内容并告诉 Agent，或改用原 MD 明细。';
  return {status:conflict?409:code==='DRAFT_BUSY_OR_INTERRUPTED'?423:code==='PROCESS_DRAFT_EXPIRED'?410:400,
    body:{ok:false,code,message}};
}
function encodePage(html) {
  const nonce=crypto.randomBytes(18).toString('base64');
  return {html:html.replace(/<script(\s[^>]*|)>/g,(tag,attrs)=>/\btype=["']application\/json["']/.test(attrs||'')?tag:tag.slice(0,-1)+` nonce="${nonce}">`),
    csp:`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`};
}
async function startServer({dir,ttlMs=MAX_LIFE,idleMs=IDLE,persist=true}={}) {
  dir=path.resolve(dir);const binding=draftFiles(dir),token=crypto.randomBytes(24).toString('hex');
  withDraftLock(dir,()=>currentDraft(dir,binding));
  const route='/session/'+token+'/',startedAt=Date.now();
  const sourceFile=path.join(dir,'source-snapshot.json');
  const sourceExpiry=fs.existsSync(sourceFile)?Date.parse(read(sourceFile).expiresAt):NaN;
  const expiresAt=Math.min(startedAt+Math.min(ttlMs,MAX_LIFE),Number.isFinite(sourceExpiry)?sourceExpiry:Infinity);
  let origin,lastActivity=startedAt,timer;
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
  const send=(response,status,value,extra={})=>{
    response.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extra});
    response.end(typeof value==='string'?value:JSON.stringify(value));
  };
  const server=http.createServer(async(request,response)=>{
    try {
      check(request.headers.host===origin.slice(7),'DETAIL_EDITOR_HOST_INVALID');
      check(!request.headers.origin||request.headers.origin===origin,'DETAIL_EDITOR_ORIGIN_INVALID');
      check(!request.headers['sec-fetch-site']||request.headers['sec-fetch-site']!=='cross-site','DETAIL_EDITOR_ORIGIN_INVALID');
      check(Date.now()<expiresAt,'PROCESS_DRAFT_EXPIRED');
      const pathname=request.url;
      if(![route,route+'health',route+'save'].includes(pathname))return send(response,404,{ok:false,code:'NOT_FOUND'});
      lastActivity=Date.now();
      if(pathname===route+'health') {
        if(request.method!=='GET')return send(response,405,{ok:false,code:'METHOD_NOT_ALLOWED'},{Allow:'GET'});
        return send(response,200,{ok:true,protocol:PROTOCOL,version:VERSION,draftId:binding.draftId,
          workflow:binding.workflow,expiresAt:new Date(expiresAt).toISOString()});
      }
      if(pathname===route) {
        if(request.method!=='GET')return send(response,405,{ok:false,code:'METHOD_NOT_ALLOWED'},{Allow:'GET'});
        const page=withDraftLock(dir,()=>{
          const current=currentDraft(dir,binding);
          const edit=Markdown.parse(current.document,current.content);
          const applied=Editor.applyEdit({document:current.document,edit,currentRevision:current.document.baseRevision});
          const document=Editor.documentFromApplied(current.document,applied);
          return encodePage(Editor.renderHtml(document,{saveEndpoint:'./save',version:current.version}));
        });
        return send(response,200,page.html,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':page.csp});
      }
      if(request.method!=='POST')return send(response,405,{ok:false,code:'METHOD_NOT_ALLOWED'},{Allow:'POST'});
      check(request.headers.origin===origin,'DETAIL_EDITOR_ORIGIN_INVALID');
      check(/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']||''),'DETAIL_EDITOR_REQUEST_INVALID');
      check(!request.headers['content-length']||Number(request.headers['content-length'])<=MAX_BODY,'DETAIL_EDITOR_REQUEST_TOO_LARGE');
      let size=0;const chunks=[];
      for await(const chunk of request){size+=chunk.length;check(size<=MAX_BODY,'DETAIL_EDITOR_REQUEST_TOO_LARGE');chunks.push(chunk);}
      let payload;try {payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch {check(false,'DETAIL_EDITOR_REQUEST_INVALID');}
      check(payload&&typeof payload==='object'&&!Array.isArray(payload)&&Object.keys(payload).length===2
        &&Object.hasOwn(payload,'edit')&&/^[a-f0-9]{64}$/.test(payload.version),'DETAIL_EDITOR_REQUEST_INVALID');
      const saved=withDraftLock(dir,()=>{
        const current=currentDraft(dir,binding);
        check(payload.version===current.version,'DETAIL_EDITOR_REVISION_CONFLICT');
        const applied=Editor.applyEdit({document:current.document,edit:payload.edit,currentRevision:current.document.baseRevision});
        const before=Editor.applyEdit({document:current.document,edit:Markdown.parse(current.document,current.content),
          currentRevision:current.document.baseRevision});
        if(digest(applied)===digest(before))return {ok:true,saved:true,unchanged:true,version:current.version,
          fileHash:current.fileHash,message:'明细没有变化，可以告诉 Agent 继续。'};
        const content=Markdown.renderEdited(current.document,applied);
        check(Buffer.byteLength(content,'utf8')<=MAX_FILE,'DETAIL_EDITOR_FILE_TOO_LARGE');
        // Verify the same import that read-edit will consume before replacing
        // the only editable file. Derived values never enter business input.
        const roundtrip=Editor.applyEdit({document:current.document,edit:Markdown.parse(current.document,content),
          currentRevision:current.document.baseRevision});
        check(digest(roundtrip.input)===digest(applied.input)&&digest(roundtrip.materials)===digest(applied.materials)
          &&digest(roundtrip.rowIds)===digest(applied.rowIds),'DETAIL_EDITOR_SAVE_NOT_VERIFIED');
        atomicText(binding.target,content,current.content);
        const latest=currentDraft(dir,binding);
        return {ok:true,saved:true,version:latest.version,fileHash:latest.fileHash,
          message:'已保存。请告诉 Agent“改好了”，回读核对后继续。'};
      });
      send(response,200,saved);
    }catch(error){const failure=publicError(error);if(!response.headersSent)send(response,failure.status,failure.body);else response.destroy();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  const runtime={protocol:PROTOCOL,version:VERSION,pid:process.pid,draftDir:dir,draftId:binding.draftId,
    workflow:binding.workflow,target:binding.target,url:origin+route,startedAt:new Date(startedAt).toISOString(),
    expiresAt:new Date(expiresAt).toISOString()};
  const close=()=>new Promise(resolve=>{
    clearInterval(timer);server.close(()=>resolve());server.closeIdleConnections();
    if(persist)try{const file=path.join(dir,runtimeName);if(read(file).url===runtime.url)fs.unlinkSync(file);}catch{}
  });
  timer=setInterval(()=>{if(Date.now()>=expiresAt||Date.now()-lastActivity>=idleMs)void close();},Math.min(30000,ttlMs,idleMs));
  timer.unref();
  try{if(persist)write(path.join(dir,runtimeName),runtime);}catch(error){await close();throw error;}
  return {server,runtime,close};
}
function validRuntime(value,dir,binding) {
  return value?.protocol===PROTOCOL&&value.version===VERSION&&value.draftDir===dir
    &&value.draftId===binding.draftId&&value.workflow===binding.workflow&&value.target===binding.target
    &&sessionPattern.test(value.url)&&Number(sessionPattern.exec(value.url)[1])<=65535
    &&Date.parse(value.expiresAt)>Date.now();
}
async function probeRuntime(value,dir,binding) {
  if(!validRuntime(value,dir,binding))return false;
  try{
    const response=await fetch(value.url+'health',{redirect:'error',signal:AbortSignal.timeout(500)});
    if(!response.ok)return false;const data=await response.json();
    return data.ok===true&&data.protocol===PROTOCOL&&data.version===VERSION
      &&data.draftId===binding.draftId&&data.workflow===binding.workflow;
  }catch{return false;}
}
async function ensure({dir,timeoutMs=5000}={}) {
  dir=path.resolve(dir);const binding=draftFiles(dir),file=path.join(dir,runtimeName);
  const existing=()=>{try{return read(file);}catch{return null;}};
  let current=existing();if(await probeRuntime(current,dir,binding))return current;
  const lock=path.join(dir,'editor-start.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid})+'\n');}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    // An interrupted launcher can leave this small lock behind. Never clear
    // an active owner's lock; recovering a dead launcher does not reset data.
    try{
      const content=localFile(lock),owner=JSON.parse(content);
      if(Number.isSafeInteger(owner.pid)&&owner.pid>0){
        let dead=false;try{process.kill(owner.pid,0);}catch(cause){dead=cause.code==='ESRCH';}
        if(dead&&localFile(lock)===content){fs.unlinkSync(lock);return ensure({dir,timeoutMs});}
      }
    }catch{/* A live/unknown lock is retried normally. */}
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));current=existing();
      if(await probeRuntime(current,dir,binding))return current;
      if(!fs.existsSync(lock))return ensure({dir,timeoutMs:Math.max(100,deadline-Date.now())});}
    check(false,'DETAIL_EDITOR_START_FAILED');
  }
  try {
    current=existing();if(await probeRuntime(current,dir,binding))return current;
    const child=spawn(process.execPath,[path.join(__dirname,'../scripts/finance-editor-server.cjs'),'--draft-dir',dir],
      {cwd:dir,detached:true,windowsHide:true,stdio:'ignore'});
    let spawnError;child.once('error',error=>{spawnError=error;});child.unref();
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline&&!spawnError){await new Promise(resolve=>setTimeout(resolve,100));current=existing();
      if(await probeRuntime(current,dir,binding))return current;}
    check(false,'DETAIL_EDITOR_START_FAILED');
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
module.exports={ensure,startServer,probeRuntime,atomicText,runtimeName};
