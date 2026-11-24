import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { watch as watchFs } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(process.env.CODESPACE_WORKSPACE ?? process.cwd());
const rootReal = realpathSync(root);
const startedAt = Date.now();

function safePath(input = "."): string {
  const target = path.resolve(root, input);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Path escapes the workspace root.");
  let probe = target;
  while (true) {
    try {
      const actual = realpathSync(probe);
      if (actual !== rootReal && !actual.startsWith(rootReal + path.sep)) throw new Error("Symlink resolves outside the workspace root.");
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  return target;
}
async function command(bin: string, args: string[], timeout = 15000) {
  try {
    const result = await execFileAsync(bin, args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return { available: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    const missing = error?.code === "ENOENT";
    return { available: !missing, exitCode: typeof error?.code === "number" ? error.code : null, stdout: error?.stdout ?? "", stderr: error?.stderr ?? error?.message ?? String(error), ...(missing ? { reason: `${bin} executable is not installed in the Codespace agent container.` } : {}) };
  }
}
async function walk(dir: string, base: string, files: Array<{path:string;size:number;modifiedAt:string}>, limit: number): Promise<void> {
  if (files.length >= limit) return;
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if ([".git","node_modules",".venv",".next","dist","build"].includes(item.name)) continue;
    const full = path.join(dir,item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) await walk(full,base,files,limit);
    else if (item.isFile()) {
      const stat = await fs.stat(full);
      files.push({path:path.relative(base,full).split(path.sep).join("/"),size:stat.size,modifiedAt:stat.mtime.toISOString()});
      if (files.length >= limit) return;
    }
  }
}
async function syncManifest() {
  const files: Array<{path:string;size:number;modifiedAt:string}> = [];
  await walk(root,root,files,2000);
  return { root, count: files.length, files };
}
async function applyEdits(a: any) {
  const file = safePath(a.path);
  const original = await fs.readFile(file,"utf8");
  const edits = a.edits as Array<{search:string;replace:string;all?:boolean}>;
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 100) throw new Error("edits must contain 1-100 exact-match edits.");
  let content = original;
  const applied: number[] = [];
  for (let i=0;i<edits.length;i++) {
    const edit = edits[i];
    if (!edit.search) throw new Error("Each edit requires a non-empty search string.");
    const occurrences = content.split(edit.search).length - 1;
    if (!occurrences) throw new Error(`Edit ${i} did not match the file.`);
    if (!edit.all && occurrences !== 1) throw new Error(`Edit ${i} matched ${occurrences} times; set all=true or make the search unique.`);
    content = edit.all ? content.split(edit.search).join(edit.replace) : content.replace(edit.search,edit.replace);
    applied.push(edit.all ? occurrences : 1);
  }
  if (Buffer.byteLength(content,"utf8") > 10*1024*1024) throw new Error("Edited file exceeds 10 MiB.");
  await fs.writeFile(file,content,"utf8");
  return { updated:true,path:path.relative(root,file),bytes:Buffer.byteLength(content),applied };
}
async function syncFiles(a: any) {
  const direction = a.direction;
  if (direction === "manifest") return syncManifest();
  const entries = a.files;
  if (!Array.isArray(entries) || entries.length > 500) throw new Error("files must be an array containing at most 500 entries.");
  let total = 0, completed = 0;
  for (const entry of entries) {
    const file = safePath(entry.path);
    if (direction === "upload") {
      const data = Buffer.from(String(entry.contentBase64 ?? ""),"base64");
      total += data.length;
      if (total > 1024*1024) throw new Error("Batch sync exceeds 1 MiB; use resumable chunked transfer for larger files.");
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,data);
    } else if (direction === "download") {
      const data = await fs.readFile(file);
      total += data.length;
      if (total > 1024*1024) throw new Error("Batch sync exceeds 1 MiB; use resumable chunked transfer for larger files.");
      entry.contentBase64 = data.toString("base64");
      entry.size = data.length;
    } else throw new Error("direction must be manifest, upload, or download.");
    completed++;
  }
  return { direction, completed, bytes:total, files:entries };
}
async function vscodeConfig(a: any) {
  const allowed = new Set(["settings.json","tasks.json","launch.json","extensions.json"]);
  if (!allowed.has(a.name)) throw new Error("Only .vscode settings.json, tasks.json, launch.json, and extensions.json are supported.");
  const dir = safePath(".vscode");
  const file = safePath(path.join(".vscode",a.name));
  if (a.action === "read") {
    try { return { path:path.relative(root,file), text:await fs.readFile(file,"utf8") }; }
    catch (error:any) { if (error?.code === "ENOENT") return { path:path.relative(root,file), found:false }; throw error; }
  }
  if (a.action !== "write" || typeof a.content !== "string") throw new Error("action must be read or write; write requires content.");
  JSON.parse(a.content);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(file,a.content,"utf8");
  return { written:true,path:path.relative(root,file),bytes:Buffer.byteLength(a.content) };
}


type WatchSession = { watcher: ReturnType<typeof watchFs>; events: Array<{event:string;filename:string|null;at:string}> };
const watchSessions = new Map<string,WatchSession>();
type TransferSession = { path:string; tempPath:string; expectedSize:number; received:number };
const uploadTransfers = new Map<string,TransferSession>();

type LspSession = { child: ReturnType<typeof spawn>; buffer: Buffer; messages: unknown[]; stderr: string; ended: boolean; exitCode: number | null };
const lspSessions = new Map<string,LspSession>();
function parseLsp(session: LspSession) {
  while (true) {
    const boundary=session.buffer.indexOf("\r\n\r\n");
    if(boundary<0)return;
    const header=session.buffer.subarray(0,boundary).toString("ascii");
    const match=header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
    if(!match)throw new Error("Invalid JSON-RPC Content-Length header.");
    const length=Number(match[1]), start=boundary+4;
    if(!Number.isSafeInteger(length)||length<0||length>8*1024*1024)throw new Error("Invalid JSON-RPC message length.");
    if(session.buffer.length<start+length)return;
    const body=session.buffer.subarray(start,start+length).toString("utf8");
    session.buffer=session.buffer.subarray(start+length);
    try{session.messages.push(JSON.parse(body));}catch{session.messages.push({parseError:true,body});}
    if(session.messages.length>1000)session.messages.shift();
  }
}
async function runTask(task: string, args: string[] = [], timeoutMs = 120000) {
  if(!/^[A-Za-z0-9:_-]{1,80}$/.test(task))throw new Error("Invalid task name.");
  if(args.length>64||args.some(x=>x.length>2048))throw new Error("Task arguments exceed limits.");
  let pkg:any=null;
  try{pkg=JSON.parse(await fs.readFile(safePath("package.json"),"utf8"));}catch(error:any){if(error?.code!=="ENOENT")throw error;}
  const scripts=pkg?.scripts??{};
  const files=await fs.readdir(root);
  const manager=files.includes("pnpm-lock.yaml")?"pnpm":files.includes("yarn.lock")?"yarn":files.includes("bun.lockb")||files.includes("bun.lock")?"bun":"npm";
  let executable=manager, commandArgs:string[];
  if(Object.prototype.hasOwnProperty.call(scripts,task)) {
    commandArgs=manager==="npm"?["run",task,"--",...args]:["run",task,...args];
  } else if(task==="test") {
    const tests:string[]=[];
    async function findTests(dir:string):Promise<void>{
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if([".git","node_modules",".venv","dist","build"].includes(entry.name))continue;
        const full=path.join(dir,entry.name);
        if(entry.isDirectory())await findTests(full);
        else if(entry.isFile()&&/\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry.name))tests.push(path.relative(root,full));
        if(tests.length>=500)return;
      }
    }
    await findTests(root);
    if(!tests.length)return {task,manager,skipped:true,exitCode:0,stdout:"",stderr:"",reason:"No package.json test script or discoverable *.test.* / *.spec.* files exist in this workspace."};
    executable="node";
    const usesTs=tests.some(file=>/\.(?:ts|tsx)$/.test(file));
    commandArgs=[...(usesTs&&await fs.access(path.join(root,"node_modules/tsx")).then(()=>true).catch(()=>false)?["--import","tsx"]:[]),"--test",...tests,...args];
  } else if(task==="build"&&await fs.access(path.join(root,"tsconfig.json")).then(()=>true).catch(()=>false)) {
    const tsc=path.join(root,"node_modules/.bin/tsc");
    if(!await fs.access(tsc).then(()=>true).catch(()=>false))return {task,manager,exitCode:127,stdout:"",stderr:"No build script is defined and TypeScript compiler is not installed."};
    executable=tsc;commandArgs=["--noEmit",...args];
  } else if (task === "build") {
    return {task,manager,skipped:true,exitCode:0,stdout:"",stderr:"",reason:"No package.json build script or tsconfig.json is present in this workspace."};
  } else {
    return {task,manager,exitCode:1,stdout:"",stderr:`Task '${task}' is not defined in package.json and no safe automatic fallback applies.`};
  }
  try{
    const result=await execFileAsync(executable,commandArgs,{cwd:root,timeout:Math.min(Math.max(timeoutMs,1000),600000),maxBuffer:8*1024*1024,windowsHide:true});
    return {task,manager,runner:executable,exitCode:0,stdout:result.stdout,stderr:result.stderr};
  }catch(error:any){
    return {task,manager,runner:executable,exitCode:typeof error?.code==="number"?error.code:null,stdout:error?.stdout??"",stderr:error?.stderr??error?.message??String(error)};
  }
}

export async function executeAdvanced(operation: string, a: Record<string, any>): Promise<unknown> {
  switch (operation) {




    case "git.worktree.list": return command("git",["worktree","list","--porcelain"]);
    case "git.worktree.add": {
      if(a.confirm!==true)throw new Error("Adding a Git worktree requires confirm=true.");
      const target=safePath(String(a.path));
      if(target===root)throw new Error("A worktree cannot replace the workspace root.");
      const branch=String(a.branch??"");
      if(!branch||branch.startsWith("-"))throw new Error("A valid branch name is required.");
      const validBranch=await command("git",["check-ref-format","--branch",branch]);
      if(validBranch.exitCode!==0)throw new Error("Git rejected the worktree branch name.");
      const args=["worktree","add",...(a.createBranch?["-b",branch]:[]),target,...(a.createBranch?[]:[branch])];
      return command("git",args);
    }
    case "git.worktree.remove": {
      if(a.confirm!==true)throw new Error("Removing a Git worktree requires confirm=true.");
      const target=safePath(String(a.path));
      if(target===root)throw new Error("Refusing to remove the current workspace root.");
      return command("git",["worktree","remove",...(a.force?["--force"]:[]),target]);
    }
    case "git.worktree.prune": {
      if(a.confirm!==true)throw new Error("Pruning Git worktree metadata requires confirm=true.");
      return command("git",["worktree","prune"]);
    }
    case "git.submodule.status": return command("git",["submodule","status","--recursive"]);
    case "git.submodule.update": {
      if(a.confirm!==true)throw new Error("Updating Git submodules requires confirm=true.");
      return command("git",["submodule","update","--init",...(a.recursive?["--recursive"]:[])]);
    }
    case "workspace.watch.start": {
      if(watchSessions.size>=50)throw new Error("Workspace watch limit reached (50).");
      const dir=safePath(String(a.path??"."));
      const stat=await fs.stat(dir);
      if(!stat.isDirectory())throw new Error("Watch target must be a directory.");
      const id=randomUUID();
      const session:WatchSession={watcher:null as any,events:[]};
      session.watcher=watchFs(dir,{recursive:Boolean(a.recursive)},(event,filename)=>{
        session.events.push({event,filename:filename?.toString()??null,at:new Date().toISOString()});
        if(session.events.length>500)session.events.shift();
      });
      watchSessions.set(id,session);
      return {watchId:id,path:path.relative(root,dir),recursive:Boolean(a.recursive)};
    }
    case "workspace.watch.read": {
      const session=watchSessions.get(String(a.watchId));
      if(!session)throw new Error("Unknown file watch session.");
      const limit=Math.min(Math.max(Number(a.limit??100),1),500);
      return {events:session.events.splice(0,limit),queuedEvents:session.events.length};
    }
    case "workspace.watch.close": {
      if(a.confirm!==true)throw new Error("Closing a watch session requires confirm=true.");
      const id=String(a.watchId),session=watchSessions.get(id);
      if(!session)return {closed:false,alreadyClosed:true};
      session.watcher.close();watchSessions.delete(id);
      return {closed:true};
    }
    case "transfer.upload.begin": {
      if(uploadTransfers.size>=20)throw new Error("Upload session limit reached (20).");
      if(a.confirm!==true)throw new Error("Starting an upload requires confirm=true.");
      const target=safePath(String(a.path));
      if(target===root)throw new Error("Cannot upload over the workspace root.");
      const expectedSize=Number(a.expectedSize);
      if(!Number.isSafeInteger(expectedSize)||expectedSize<0||expectedSize>1024*1024*1024)throw new Error("expectedSize must be between 0 and 1 GiB.");
      if(a.overwrite!==true){try{await fs.access(target);throw new Error("Destination already exists; set overwrite=true to replace it.");}catch(error:any){if(error?.code!=="ENOENT")throw error;}}
      await fs.mkdir(path.dirname(target),{recursive:true});
      const id=randomUUID(), tempPath=path.join(path.dirname(target),`.${path.basename(target)}.codespace-${id}.upload`);
      await fs.writeFile(tempPath,Buffer.alloc(0),{flag:"wx"});
      uploadTransfers.set(id,{path:target,tempPath,expectedSize,received:0});
      return {sessionId:id,path:path.relative(root,target),expectedSize,chunkBytes:256*1024};
    }
    case "transfer.upload.chunk": {
      const session=uploadTransfers.get(String(a.sessionId));
      if(!session)throw new Error("Unknown upload session.");
      const offset=Number(a.offset), data=Buffer.from(String(a.contentBase64??""),"base64");
      if(offset!==session.received)throw new Error(`Expected offset ${session.received}.`);
      if(!data.length||data.length>256*1024)throw new Error("Chunk must contain 1-262144 bytes.");
      if(session.received+data.length>session.expectedSize)throw new Error("Chunk exceeds declared upload size.");
      await fs.appendFile(session.tempPath,data);
      session.received+=data.length;
      return {received:session.received,expectedSize:session.expectedSize,complete:session.received===session.expectedSize};
    }
    case "transfer.upload.commit": {
      const id=String(a.sessionId),session=uploadTransfers.get(id);
      if(!session)throw new Error("Unknown upload session.");
      if(session.received!==session.expectedSize)throw new Error(`Upload incomplete: received ${session.received} of ${session.expectedSize} bytes.`);
      await fs.rename(session.tempPath,session.path);
      uploadTransfers.delete(id);
      return {committed:true,path:path.relative(root,session.path),bytes:session.received};
    }
    case "transfer.upload.abort": {
      if(a.confirm!==true)throw new Error("Aborting an upload requires confirm=true.");
      const id=String(a.sessionId),session=uploadTransfers.get(id);
      if(!session)return {aborted:false,alreadyClosed:true};
      await fs.unlink(session.tempPath).catch(()=>undefined);
      uploadTransfers.delete(id);
      return {aborted:true,received:session.received};
    }
    case "transfer.download.chunk": {
      const file=safePath(String(a.path)),offset=Number(a.offset??0),length=Math.min(Math.max(Number(a.length??262144),1),262144);
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error("offset must be a non-negative integer.");
      const handle=await fs.open(file,"r");
      try{
        const stat=await handle.stat();
        if(!stat.isFile())throw new Error("Download target must be a regular file.");
        if(offset>stat.size)throw new Error("offset exceeds file size.");
        const buffer=Buffer.alloc(Math.min(length,Math.max(0,stat.size-offset)));
        const read=buffer.length?await handle.read(buffer,0,buffer.length,offset):{bytesRead:0};
        const chunk=buffer.subarray(0,read.bytesRead);
        return {path:path.relative(root,file),offset,nextOffset:offset+chunk.length,totalBytes:stat.size,contentBase64:chunk.toString("base64"),eof:offset+chunk.length>=stat.size};
      }finally{await handle.close();}
    }
    case "workspace.tasks.list": {
      let pkg:any=null;
      try{pkg=JSON.parse(await fs.readFile(safePath("package.json"),"utf8"));}catch(error:any){if(error?.code!=="ENOENT")throw error;}
      const make=await command("make",["-qp"]);
      const targets=[...make.stdout.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)].map(m=>m[1]).filter(x=>!x.startsWith("."));
      return {packageManager:(await fs.readdir(root)).includes("pnpm-lock.yaml")?"pnpm":(await fs.readdir(root)).includes("yarn.lock")?"yarn":"npm",scripts:pkg?.scripts??{},makeTargets:[...new Set(targets)].slice(0,300)};
    }
    case "workspace.run_task": if(a.confirm!==true)throw new Error("Running a workspace task requires confirm=true."); return runTask(String(a.task),Array.isArray(a.args)?a.args.map(String):[],Number(a.timeoutMs??120000));
    case "workspace.run_tests": if(a.confirm!==true)throw new Error("Running tests requires confirm=true."); return runTask("test",Array.isArray(a.args)?a.args.map(String):[],Number(a.timeoutMs??300000));
    case "workspace.run_build": if(a.confirm!==true)throw new Error("Running a build requires confirm=true."); return runTask("build",Array.isArray(a.args)?a.args.map(String):[],Number(a.timeoutMs??300000));
    case "workspace.language_servers": {
      const names=["typescript-language-server","pyright-langserver","bash-language-server","yaml-language-server","vscode-json-language-server","vscode-html-language-server","vscode-css-language-server","rust-analyzer","gopls","clangd","vscode-eslint-language-server","solargraph","jdtls"];
      return Promise.all(names.map(async name=>({name,available:(await command("which",[name],3000)).exitCode===0})));
    }
    case "lsp.start": {
      const argv=Array.isArray(a.command)?a.command.map(String):[];
      if(!argv.length||argv.length>64||argv.some(x=>x.length>4096))throw new Error("LSP command must be a non-empty argv array.");
      const child=spawn(argv[0],argv.slice(1),{cwd:safePath(a.cwd??"."),env:process.env,stdio:["pipe","pipe","pipe"]});
      const id=randomUUID();
      const session:LspSession={child,buffer:Buffer.alloc(0),messages:[],stderr:"",ended:false,exitCode:null};
      child.stdout.on("data",(chunk:Buffer)=>{try{session.buffer=Buffer.concat([session.buffer,chunk]);parseLsp(session);}catch(error){session.stderr=(session.stderr+String(error)).slice(-50000);child.kill("SIGTERM");}});
      child.stderr.on("data",(chunk:Buffer)=>{session.stderr=(session.stderr+chunk.toString("utf8")).slice(-50000);});
      child.on("close",(code:number|null)=>{session.ended=true;session.exitCode=code;});
      child.on("error",(error:Error)=>{session.stderr=(session.stderr+error.message).slice(-50000);session.ended=true;});
      lspSessions.set(id,session);
      return {sessionId:id,pid:child.pid??null,protocol:"Language Server Protocol / JSON-RPC"};
    }
    case "lsp.send": {
      const session=lspSessions.get(String(a.sessionId));
      if(!session||session.ended)throw new Error("Language server session is not running.");
      const body=Buffer.from(JSON.stringify(a.message),"utf8");
      if(body.length>8*1024*1024)throw new Error("LSP message exceeds 8 MiB.");
      session.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
      return {sent:true,bytes:body.length};
    }
    case "lsp.read": {
      const session=lspSessions.get(String(a.sessionId));
      if(!session)throw new Error("Unknown language server session.");
      return {messages:session.messages.splice(0,Math.min(Math.max(Number(a.maxMessages??100),1),500)),stderr:session.stderr,running:!session.ended,exitCode:session.exitCode};
    }
    case "lsp.close": {
      const session=lspSessions.get(String(a.sessionId));
      if(!session)throw new Error("Unknown language server session.");
      if(!session.ended)session.child.kill("SIGTERM");
      return {closed:true,alreadyEnded:session.ended};
    }
    case "workspace.monitor": {
      const [disk, df] = await Promise.all([fs.stat(root), command("df",["-Pk",root])]);
      const memory = process.memoryUsage();
      return { sampledAt:new Date().toISOString(), uptimeSeconds:Math.floor(process.uptime()), loadAverage:os.loadavg(), cpuCount:os.cpus().length, memory:{total:os.totalmem(),free:os.freemem(),process:memory}, workspace:{root,modifiedAt:disk.mtime.toISOString()}, disk:df, containers:{available:false,reason:"The agent runs inside the Codespace container and cannot inspect the parent Docker host."} };
    }
    case "workspace.diagnostics": {
      const [git, versions] = await Promise.all([
        command("git",["status","--short","--branch"]),
        Promise.all(["node","npm","git","gh","code","devcontainer","docker"].map(async name => {
          const result = await command(name,["--version"],5000);
          return {name,available:result.available && result.exitCode===0,version:result.available ? (result.stdout||result.stderr).trim().split("\n")[0] : null,reason:result.available ? undefined : result.reason};
        }))
      ]);
      let devcontainer: unknown = {found:false};
      for (const relative of [".devcontainer/devcontainer.json",".devcontainer.json"]) {
        try { const raw=await fs.readFile(path.join(root,relative),"utf8"); JSON.parse(raw); devcontainer={found:true,path:relative,valid:true,validation:"static-json"}; break; }
        catch(error:any) { if(error?.code==="ENOENT") continue; devcontainer={found:true,path:relative,valid:false,error:error.message}; break; }
      }
      return {generatedAt:new Date().toISOString(),agent:{uptimeSeconds:Math.floor(process.uptime()),startedAt:new Date(Date.now()-process.uptime()*1000).toISOString()},workspace:root,git,devcontainer,hostContainerControl:{available:false,reason:"Docker and Dev Container CLI are host-level tools and are not available from inside the agent container."},tools:versions};
    }
    case "workspace.health": return {ok:true,codespace:process.env.CODESPACE_NAME??null,workspace:root,uptimeSeconds:Math.floor(process.uptime()),agentStartedAt:new Date(startedAt).toISOString(),pid:process.pid,node:process.version};
    case "fs.apply_edits": return applyEdits(a);
    case "fs.sync": if(a.direction==="upload"&&a.confirm!==true)throw new Error("Uploading batch files requires confirm=true."); return syncFiles(a);
    case "vscode.config": if(a.action==="write"&&a.confirm!==true)throw new Error("Writing VS Code configuration requires confirm=true."); return vscodeConfig(a);
    case "devcontainer.logs":
    case "devcontainer.list_containers": {
      const socketAvailable = await fs.access("/var/run/docker.sock").then(()=>true).catch(()=>false);
      const docker = await command("docker",["--version"]);
      return {available:false,operation,hostDockerCli:docker.available,hostDockerSocket:socketAvailable,reason:"The Codespaces agent runs inside the development container. Docker CLI/socket access belongs to the Codespaces host and is not mounted into this container. Use the Codespaces creation log or Rebuild Container action for host-container diagnostics."};
    }
    default: return undefined;
  }
}
