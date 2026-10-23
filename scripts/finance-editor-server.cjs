#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {startServer}=require('../shared/finance-local-editor.cjs');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--draft-dir'||!path.isAbsolute(args[1]))process.exitCode=2;
else startServer({dir:args[1]}).then(({close})=>{
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close();});
}).catch(()=>{process.exitCode=1;});
