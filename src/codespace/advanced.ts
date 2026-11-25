import fs from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { watch as watchFs } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { assertNoSymlinkComponents, assertProtocolBufferCapacity, assertProtocolQueueCapacity, assertUploadCapacity, createChildProcessEnv, filterTrustedExecutablePath, isExpired, linkFileNoReplace, parseMakeTargets, pruneEndedSessions, resolveTrustedExecutable, writeFilesAtomically } from "./agent-utils.js";

const execFileAsync = promisify(execFile);
const root = realpathSync(path.resolve(process.env.CODESPACE_WORKSPACE ?? process.cwd()));
const childEnv = createChildProcessEnv();
const systemEnv = { ...childEnv, PATH: filterTrustedExecutablePath(childEnv.PATH ?? "", root) };
const startedAt = Date.now();

function safePath(input = "."): string {
  const target = path.resolve(root, input);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Path escapes the workspace root.");
  assertNoSymlinkComponents(root, target);
  return target;
}
async function readWorkspaceFileBounded(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Workspace read target must be a regular file.");
    if (stat.size > maxBytes) throw new Error(`Workspace file exceeds the ${Math.floor(maxBytes / 1024)} KiB read limit.`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function readWorkspaceTextBounded(file: string, maxBytes: number): Promise<string> {
  return (await readWorkspaceFileBounded(file, maxBytes)).toString("utf8");
}
async function command(bin: string, args: string[], timeout = 15000) {
  try {
    const executable = await resolveTrustedExecutable(bin, systemEnv.PATH ?? "", root);
    const result = await execFileAsync(executable, args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: systemEnv });
    return { available: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    const missing = error?.code === "ENOENT";
    return { available: !missing, exitCode: typeof error?.code === "number" ? error.code : null, stdout: error?.stdout ?? "", stderr: error?.stderr ?? error?.message ?? String(error), ...(missing ? { reason: `${bin} executable is not installed in the Codespace agent container.` } : {}) };
  }
}
async function dockerEngineStatus() {
  const cli = await command("docker", ["--version"], 5000);
  if (!cli.available || cli.exitCode !== 0) {
    return { cliAvailable: false, daemonAvailable: false, scope: "nested-docker-engine", reason: cli.reason ?? cli.stderr ?? "Docker CLI is unavailable." };
  }
  const info = await command("docker", ["info", "--format", "{{json .}}"], 10000);
  if (!info.available || info.exitCode !== 0) {
    return { cliAvailable: true, daemonAvailable: false, scope: "nested-docker-engine", reason: info.stderr || "Docker CLI is installed, but the nested Docker daemon is not reachable." };
  }
  let parsed: any = {};
  try { parsed = JSON.parse(info.stdout.trim()); } catch {}
  return {
    cliAvailable: true,
    daemonAvailable: true,
    scope: "nested-docker-engine",
    serverVersion: parsed.ServerVersion ?? null,
    containers: typeof parsed.Containers === "number" ? parsed.Containers : null,
    images: typeof parsed.Images === "number" ? parsed.Images : null,
    operatingSystem: parsed.OperatingSystem ?? null
  };
}
const MAX_WORKSPACE_TRAVERSAL_ENTRIES = 10_000;
async function walk(dir: string, base: string, files: Array<{path:string;size:number;modifiedAt:string}>, state: { visited: number }, limit: number): Promise<void> {
  if (files.length >= limit) return;
  const directory = await fs.opendir(dir);
  for await (const item of directory) {
    if (++state.visited > MAX_WORKSPACE_TRAVERSAL_ENTRIES) throw new Error("Workspace manifest exceeds the 10000-entry traversal limit; narrow the workspace or exclude generated directories.");
    if ([".git","node_modules",".venv",".next","dist","build"].includes(item.name)) continue;
    const full = path.join(dir,item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) await walk(full,base,files,state,limit);
    else if (item.isFile()) {
      const stat = await fs.stat(full);
      files.push({path:path.relative(base,full).split(path.sep).join("/"),size:stat.size,modifiedAt:stat.mtime.toISOString()});
      if (files.length >= limit) return;
    }
  }
}
async function syncManifest() {
  const files: Array<{path:string;size:number;modifiedAt:string}> = [];
  await walk(root,root,files,{visited:0},2000);
  return { root, count: files.length, files };
}
async function applyEdits(a: any) {
  const file = safePath(a.path);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("Edited file must be a regular file no larger than 10 MiB.");
  const original = await readWorkspaceTextBounded(file,10*1024*1024);
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
  if (direction === "upload") {
    const staged: Array<{ path: string; data: Buffer }> = [];
    const destinations = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || !entry.path) throw new Error("Every upload entry requires a workspace-relative path.");
      if (typeof entry.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)) {
        throw new Error(`Invalid base64 content for upload path: ${entry.path}`);
      }
      const file = safePath(entry.path);
      if (file === root) throw new Error("A batch upload cannot replace the workspace root.");
      if (destinations.has(file)) throw new Error(`Duplicate upload destination: ${entry.path}`);
      destinations.add(file);
      const data = Buffer.from(entry.contentBase64, "base64");
      if (data.toString("base64") !== entry.contentBase64) throw new Error(`Non-canonical base64 content for upload path: ${entry.path}`);
      total += data.length;
      if (total > 1024 * 1024) throw new Error("Batch sync exceeds 1 MiB; use resumable chunked transfer for larger files.");
      staged.push({ path: file, data });
    }
    await writeFilesAtomically(staged);
    return { direction, completed: staged.length, bytes: total, files: entries.map((entry: any) => ({ path: entry.path, size: Buffer.from(entry.contentBase64, "base64").length })) };
  }
  if (direction === "download") {
    const downloaded: Array<{ path: string; contentBase64: string; size: number }> = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || !entry.path) throw new Error("Every download entry requires a workspace-relative path.");
      const file = safePath(entry.path);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`Download target is not a regular file: ${entry.path}`);
      if (stat.size > 1024 * 1024 || total + stat.size > 1024 * 1024) throw new Error("Batch sync exceeds 1 MiB; use resumable chunked transfer for larger files.");
      const data = await readWorkspaceFileBounded(file, 1024 * 1024 - total);
      total += data.length;
      downloaded.push({ path: entry.path, contentBase64: data.toString("base64"), size: data.length });
    }
    return { direction, completed: downloaded.length, bytes: total, files: downloaded };
  }
  throw new Error("direction must be manifest, upload, or download.");
}
async function vscodeConfig(a: any) {
  const allowed = new Set(["settings.json","tasks.json","launch.json","extensions.json"]);
  if (!allowed.has(a.name)) throw new Error("Only .vscode settings.json, tasks.json, launch.json, and extensions.json are supported.");
  const dir = safePath(".vscode");
  const file = safePath(path.join(".vscode",a.name));
  if (a.action === "read") {
    try {
      const stat=await fs.stat(file);
      if(!stat.isFile()||stat.size>512*1024)throw new Error("VS Code configuration file exceeds the 512 KiB limit.");
      return { path:path.relative(root,file), text:await readWorkspaceTextBounded(file,512*1024) }; }
    catch (error:any) { if (error?.code === "ENOENT") return { path:path.relative(root,file), found:false }; throw error; }
  }
  if (a.action !== "write" || typeof a.content !== "string") throw new Error("action must be read or write; write requires content.");
  if(Buffer.byteLength(a.content,"utf8")>512*1024)throw new Error("VS Code configuration content exceeds the 512 KiB limit.");
  JSON.parse(a.content);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(file,a.content,"utf8");
  return { written:true,path:path.relative(root,file),bytes:Buffer.byteLength(a.content) };
}


type WatchSession = { watcher: ReturnType<typeof watchFs>; events: Array<{event:string;filename:string|null;at:string}> };
const watchSessions = new Map<string,WatchSession>();
type TransferSession = { path:string; tempPath:string; expectedSize:number; received:number; lastActivityAt:number; overwrite:boolean };
const uploadTransfers = new Map<string,TransferSession>();
const UPLOAD_TTL_MS = 15 * 60_000;
const MAX_UPLOAD_SESSIONS = 20;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_AGGREGATE_UPLOAD_BYTES = 512 * 1024 * 1024;
async function cleanupExpiredUploads(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const [id, session] of uploadTransfers) {
    if (!isExpired(session.lastActivityAt, now, UPLOAD_TTL_MS)) continue;
    await fs.unlink(session.tempPath).catch(() => undefined);
    uploadTransfers.delete(id);
    removed++;
  }
  return removed;
}
const uploadCleanupTimer = setInterval(() => { void cleanupExpiredUploads(); }, 60_000);
uploadCleanupTimer.unref?.();

type LspSession = { child: ReturnType<typeof spawn>; buffer: Buffer; messages: Array<{body:string;bytes:number}>; queuedBytes:number; stderr: string; ended: boolean; endedAt: number | null; exitCode: number | null };
const lspSessions = new Map<string,LspSession>();
const MAX_PROTOCOL_MESSAGE_BYTES=8*1024*1024;
const MAX_PROTOCOL_HEADER_BYTES=8192;
const MAX_PROTOCOL_BUFFER_BYTES=MAX_PROTOCOL_MESSAGE_BYTES+MAX_PROTOCOL_HEADER_BYTES;
const MAX_PROTOCOL_QUEUE_BYTES=8*1024*1024;
function parseLsp(session: LspSession) {
  while (true) {
    const boundary=session.buffer.indexOf("\r\n\r\n");
    if(boundary<0)return;
    const header=session.buffer.subarray(0,boundary).toString("ascii");
    const match=header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
    if(boundary>MAX_PROTOCOL_HEADER_BYTES)throw new Error("JSON-RPC header exceeds 8 KiB.");
    if(!match)throw new Error("Invalid JSON-RPC Content-Length header.");
    const length=Number(match[1]), start=boundary+4;
    if(!Number.isSafeInteger(length)||length<0||length>MAX_PROTOCOL_MESSAGE_BYTES)throw new Error("Invalid JSON-RPC message length.");
    if(session.buffer.length<start+length)return;
    assertProtocolQueueCapacity(session.queuedBytes,length,MAX_PROTOCOL_QUEUE_BYTES,session.messages.length,4096);
    const body=session.buffer.subarray(start,start+length).toString("utf8");
    const charge=Math.max(length,256);
    session.buffer=session.buffer.subarray(start+length);
    session.messages.push({body,bytes:charge});session.queuedBytes+=charge;
  }
}
async function runTask(task: string, args: string[] = [], timeoutMs = 120000) {
  if(!/^[A-Za-z0-9:_-]{1,80}$/.test(task))throw new Error("Invalid task name.");
  if(args.length>64||args.some(x=>x.length>2048))throw new Error("Task arguments exceed limits.");
  let pkg:any=null;
  try{pkg=JSON.parse(await readWorkspaceTextBounded(safePath("package.json"),1024*1024));}catch(error:any){if(error?.code!=="ENOENT")throw error;}
  const scripts=pkg?.scripts??{};
  const files=await fs.readdir(root);
  const manager=files.includes("pnpm-lock.yaml")?"pnpm":files.includes("yarn.lock")?"yarn":files.includes("bun.lockb")||files.includes("bun.lock")?"bun":"npm";
  let executable=manager, commandArgs:string[];
  if(Object.prototype.hasOwnProperty.call(scripts,task)) {
    commandArgs=manager==="npm"?["run",task,"--",...args]:["run",task,...args];
  } else if(task==="test") {
    const tests:string[]=[];
    let visitedTestEntries = 0;
    async function findTests(dir:string):Promise<void>{
      if(tests.length>=500)return;
      const directory=await fs.opendir(dir);
      for await(const entry of directory){
        if(++visitedTestEntries>MAX_WORKSPACE_TRAVERSAL_ENTRIES)throw new Error("Test discovery exceeds the 10000-entry traversal limit; add a package.json test script or narrow the workspace.");
        if([".git","node_modules",".venv","dist","build"].includes(entry.name))continue;
        const full=path.join(dir,entry.name);
        if(entry.isDirectory())await findTests(full);
        else if(entry.isFile()&&/\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry.name))tests.push(path.relative(root,full));
        if(tests.length>=500)break;
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
    const resolvedExecutable = path.isAbsolute(executable) ? executable : await resolveTrustedExecutable(executable, systemEnv.PATH ?? "", root);
    const result=await execFileAsync(resolvedExecutable,commandArgs,{cwd:root,timeout:Math.min(Math.max(timeoutMs,1000),600000),maxBuffer:8*1024*1024,windowsHide:true,env:systemEnv});
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
      await cleanupExpiredUploads();
      if(a.confirm!==true)throw new Error("Starting an upload requires confirm=true.");
      const target=safePath(String(a.path));
      if(target===root)throw new Error("Cannot upload over the workspace root.");
      const expectedSize=Number(a.expectedSize);
      assertUploadCapacity(uploadTransfers,expectedSize,MAX_UPLOAD_SESSIONS,MAX_UPLOAD_BYTES,MAX_AGGREGATE_UPLOAD_BYTES);
      if(a.overwrite!==true){try{await fs.access(target);throw new Error("Destination already exists; set overwrite=true to replace it.");}catch(error:any){if(error?.code!=="ENOENT")throw error;}}
      await fs.mkdir(path.dirname(target),{recursive:true});
      const id=randomUUID(), tempPath=path.join(path.dirname(target),`.${path.basename(target)}.codespace-${id}.upload`);
      await fs.writeFile(tempPath,Buffer.alloc(0),{flag:"wx"});
      uploadTransfers.set(id,{path:target,tempPath,expectedSize,received:0,lastActivityAt:Date.now(),overwrite:a.overwrite===true});
      return {sessionId:id,path:path.relative(root,target),expectedSize,chunkBytes:256*1024};
    }
    case "transfer.upload.chunk": {
      await cleanupExpiredUploads();
      const session=uploadTransfers.get(String(a.sessionId));
      if(!session)throw new Error("Unknown upload session.");
      const offset=Number(a.offset), data=Buffer.from(String(a.contentBase64??""),"base64");
      if(offset!==session.received)throw new Error(`Expected offset ${session.received}.`);
      if(!data.length||data.length>256*1024)throw new Error("Chunk must contain 1-262144 bytes.");
      if(session.received+data.length>session.expectedSize)throw new Error("Chunk exceeds declared upload size.");
      await fs.appendFile(session.tempPath,data);
      session.received+=data.length;
      session.lastActivityAt=Date.now();
      return {received:session.received,expectedSize:session.expectedSize,complete:session.received===session.expectedSize};
    }
    case "transfer.upload.commit": {
      await cleanupExpiredUploads();
      const id=String(a.sessionId),session=uploadTransfers.get(id);
      if(!session)throw new Error("Unknown upload session.");
      if(session.received!==session.expectedSize)throw new Error(`Upload incomplete: received ${session.received} of ${session.expectedSize} bytes.`);
      safePath(path.relative(root,session.path));
      if (session.overwrite) {
        await fs.rename(session.tempPath,session.path);
      } else {
        // link() is an atomic no-replace operation on the same filesystem.
        await linkFileNoReplace(session.tempPath,session.path);
      }
      uploadTransfers.delete(id);
      return {committed:true,path:path.relative(root,session.path),bytes:session.received};
    }
    case "transfer.upload.abort": {
      await cleanupExpiredUploads();
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
      const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
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
      try{pkg=JSON.parse(await readWorkspaceTextBounded(safePath("package.json"),1024*1024));}catch(error:any){if(error?.code!=="ENOENT")throw error;}
      let makeTargets: string[] = [];
      for (const candidate of ["GNUmakefile", "makefile", "Makefile"]) {
        try {
          const source = await readWorkspaceTextBounded(safePath(candidate), 1024 * 1024);
          makeTargets = parseMakeTargets(source);
          break;
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      const rootEntries = await fs.readdir(root);
      return {packageManager:rootEntries.includes("pnpm-lock.yaml")?"pnpm":rootEntries.includes("yarn.lock")?"yarn":"npm",scripts:pkg?.scripts??{},makeTargets};
    }
    case "workspace.run_task": if(a.confirm!==true)throw new Error("Running a workspace task requires confirm=true."); return runTask(String(a.task),Array.isArray(a.args)?a.args.map(String):[],Number(a.timeoutMs??120000));
    case "workspace.run_tests": if(a.confirm!==true)throw new Error("Running tests requires confirm=true."); return runTask("test",Array.isArray(a.args)?a.args.map(String):[],Number(a.timeoutMs??300000));
    case "workspace.run_build": if(a.confirm!==true)throw new Error("Running a build requires confirm=true."); return runTask("build",Array.isArray(a.args)?a.args.map(String):[],Number(a.timeoutMs??300000));
    case "workspace.language_servers": {
      const names=["typescript-language-server","pyright-langserver","bash-language-server","yaml-language-server","vscode-json-language-server","vscode-html-language-server","vscode-css-language-server","rust-analyzer","gopls","clangd","vscode-eslint-language-server","solargraph","jdtls"];
      return Promise.all(names.map(async name=>({name,available:(await command("which",[name],3000)).exitCode===0})));
    }
    case "lsp.start": {
      pruneEndedSessions(lspSessions, Date.now(), 10 * 60_000, 50);
      if ([...lspSessions.values()].filter(session => !session.ended).length >= 20) throw new Error("Language-server session limit reached (20 active sessions).");
      const argv=Array.isArray(a.command)?a.command.map(String):[];
      if(!argv.length||argv.length>64||argv.some(x=>x.length>4096))throw new Error("LSP command must be a non-empty argv array.");
      const child=spawn(argv[0],argv.slice(1),{cwd:safePath(a.cwd??"."),env:childEnv,stdio:["pipe","pipe","pipe"]});
      const id=randomUUID();
      const session:LspSession={child,buffer:Buffer.alloc(0),messages:[],queuedBytes:0,stderr:"",ended:false,endedAt:null,exitCode:null};
      child.stdout.on("data",(chunk:Buffer)=>{try{assertProtocolBufferCapacity(session.buffer.length,chunk.length,MAX_PROTOCOL_BUFFER_BYTES);session.buffer=Buffer.concat([session.buffer,chunk]);parseLsp(session);}catch(error){session.stderr=(session.stderr+String(error)).slice(-50000);
        child.stdout.pause();session.buffer=Buffer.alloc(0);session.messages=[];session.queuedBytes=0;
        child.kill("SIGTERM");
        const forceTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},1000);forceTimer.unref();}});
      child.stderr.on("data",(chunk:Buffer)=>{session.stderr=(session.stderr+chunk.toString("utf8")).slice(-50000);});
      child.on("close",(code:number|null)=>{session.ended=true;session.endedAt=Date.now();session.exitCode=code;});
      child.on("error",(error:Error)=>{session.stderr=(session.stderr+error.message).slice(-50000);session.ended=true;session.endedAt=Date.now();});
      lspSessions.set(id,session);
      pruneEndedSessions(lspSessions, Date.now(), 10 * 60_000, 50);
      return {sessionId:id,pid:child.pid??null,protocol:"Language Server Protocol / JSON-RPC"};
    }
    case "lsp.send": {
      const session=lspSessions.get(String(a.sessionId));
      if(!session||session.ended)throw new Error("Language server session is not running.");
      const body=Buffer.from(JSON.stringify(a.message),"utf8");
      if(body.length>8*1024*1024)throw new Error("LSP message exceeds 8 MiB.");
      const frame=Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]);
      const writable=session.child.stdin;
      if(writable.writableLength+frame.length>MAX_PROTOCOL_QUEUE_BYTES)throw new Error("Language-server input backpressure limit exceeded.");
      if(!writable.write(frame))await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error("Language-server input drain timed out."));},10000);const cleanup=()=>{clearTimeout(timer);writable.off("drain",onDrain);writable.off("error",onError);writable.off("close",onClose);};const onDrain=()=>{cleanup();resolve();};const onError=(error:Error)=>{cleanup();reject(error);};const onClose=()=>{cleanup();reject(new Error("Language-server input closed before draining."));};writable.once("drain",onDrain);writable.once("error",onError);writable.once("close",onClose);});
      return {sent:true,bytes:body.length};
    }
    case "lsp.read": {
      const session=lspSessions.get(String(a.sessionId));
      if(!session)throw new Error("Unknown language server session.");
      const messages=session.messages.splice(0,Math.min(Math.max(Number(a.maxMessages??100),1),500));
      session.queuedBytes-=messages.reduce((total,item)=>total+item.bytes,0);
      return {messages:messages.map(item=>{try{return JSON.parse(item.body);}catch{return {parseError:true,body:item.body};}}),stderr:session.stderr,running:!session.ended,exitCode:session.exitCode};
    }
    case "lsp.close": {
      const session=lspSessions.get(String(a.sessionId));
      if(!session)throw new Error("Unknown language server session.");
      if(!session.ended)session.child.kill("SIGTERM");
      return {closed:true,alreadyEnded:session.ended};
    }
    case "workspace.monitor": {
      const [disk, df, dockerEngine] = await Promise.all([fs.stat(root), command("df",["-Pk",root]), dockerEngineStatus()]);
      const memory = process.memoryUsage();
      return {
        sampledAt:new Date().toISOString(), uptimeSeconds:Math.floor(process.uptime()), loadAverage:os.loadavg(), cpuCount:os.cpus().length,
        memory:{total:os.totalmem(),free:os.freemem(),process:memory},
        workspace:{root,modifiedAt:disk.mtime.toISOString()}, disk:df,
        containers:{available:dockerEngine.daemonAvailable,scope:"nested-docker-engine",count:dockerEngine.containers,reason:dockerEngine.reason},
        hostContainers:{available:false,reason:"The Codespaces host container is outside the development container's Docker namespace."}
      };
    }
    case "workspace.diagnostics": {
      const [git, versions, dockerEngine] = await Promise.all([
        command("git",["status","--short","--branch"]),
        Promise.all(["node","npm","git","gh","code","devcontainer","docker"].map(async name => {
          const result = await command(name,["--version"],5000);
          return {name,available:result.available && result.exitCode===0,version:result.available ? (result.stdout||result.stderr).trim().split("\n")[0] : null,reason:result.available ? undefined : result.reason};
        })),
        dockerEngineStatus()
      ]);
      let devcontainer: unknown = {found:false};
      for (const relative of [".devcontainer/devcontainer.json",".devcontainer.json"]) {
        try { const raw=await readWorkspaceTextBounded(safePath(relative),512*1024); JSON.parse(raw); devcontainer={found:true,path:relative,valid:true,validation:"static-json"}; break; }
        catch(error:any) { if(error?.code==="ENOENT") continue; devcontainer={found:true,path:relative,valid:false,error:error.message}; break; }
      }
      return {
        generatedAt:new Date().toISOString(),
        agent:{uptimeSeconds:Math.floor(process.uptime()),startedAt:new Date(Date.now()-process.uptime()*1000).toISOString()},
        workspace:root,git,devcontainer,dockerEngine,
        hostContainerControl:{available:false,reason:"The agent can manage its nested Docker-in-Docker engine, but cannot inspect or control the parent Codespaces host container."},
        tools:versions
      };
    }
    case "workspace.health": return {ok:true,codespace:process.env.CODESPACE_NAME??null,workspace:root,uptimeSeconds:Math.floor(process.uptime()),agentStartedAt:new Date(startedAt).toISOString(),pid:process.pid,node:process.version};
    case "fs.apply_edits": return applyEdits(a);
    case "fs.sync": if(a.direction==="upload"&&a.confirm!==true)throw new Error("Uploading batch files requires confirm=true."); return syncFiles(a);
    case "vscode.config": if(a.action==="write"&&a.confirm!==true)throw new Error("Writing VS Code configuration requires confirm=true."); return vscodeConfig(a);
    case "devcontainer.logs":
    case "devcontainer.list_containers": {
      const engine = await dockerEngineStatus();
      if (!engine.daemonAvailable) {
        return {available:false,operation,...engine,reason:engine.reason ?? "Docker-in-Docker is not ready. Rebuild the Codespace after enabling the Docker-in-Docker feature."};
      }
      if (operation === "devcontainer.list_containers") {
        const result = await command("docker",["ps","--all","--no-trunc","--format","{{json .}}"],30000);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Unable to list nested Docker containers.");
        const containers = result.stdout.split("\n").filter(Boolean).map((line:string) => {
          try { return JSON.parse(line); } catch { return {raw:line}; }
        });
        return {available:true,scope:"nested-docker-engine",containers};
      }
      const containerId = String(a.containerId ?? "").trim();
      if (!containerId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) {
        throw new Error("A valid nested Docker containerId is required to retrieve logs.");
      }
      const tail = Math.min(2000,Math.max(1,Number(a.tail) || 100));
      const args = ["logs","--tail",String(tail)];
      if (a.since !== undefined) {
        const since = String(a.since);
        if (!since || since.length > 128 || !/^[A-Za-z0-9:._+-]+$/.test(since)) throw new Error("Invalid Docker logs since value.");
        args.push("--since",since);
      }
      args.push(containerId);
      const result = await command("docker",args,30000);
      if (result.exitCode !== 0) throw new Error(result.stderr || "Unable to retrieve nested Docker container logs.");
      return {available:true,scope:"nested-docker-engine",containerId,stdout:result.stdout,stderr:result.stderr};
    }
    default: return undefined;
  }
}
