import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {acquireOwnedLock} from './portal-memory-lock.mjs';

export function byokDirectory(cwd,{create=false}={}) {
  const root=fs.realpathSync(cwd),local=path.join(root,'.idleproof'),dir=path.join(local,'byok');
  for(const target of [local,dir]) {
    if(!fs.existsSync(target)){if(!create)return dir;fs.mkdirSync(target,{mode:0o700});}
    if(fs.lstatSync(target).isSymbolicLink()||!fs.realpathSync(target).startsWith(root+path.sep))throw new Error('BYOK_STORAGE_UNSAFE');
  }
  return dir;
}
export function readByok(file,{optional=false}={}) {
  try {
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024||(process.platform!=='win32'&&(stat.mode&0o077)))throw new Error('BYOK_STORAGE_UNSAFE');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}
}
export function writeByok(file,value) {
  const temp=file+`.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});
  try{fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
}
export function byokLock(cwd){return acquireOwnedLock(path.join(byokDirectory(cwd,{create:true}),'request.lock'),'BYOK_BUSY','Optional interpretation');}

function protect(value,encrypt) {
  // Fixed program; secret bytes travel through stdin, never the process argument list.
  const program=`Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${encrypt?'Protect':'Unprotect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',program],{input:value,encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true});
  if(result.error||result.status!==0||!result.stdout.trim())throw new Error('BYOK_SECURE_STORAGE_UNAVAILABLE');
  return result.stdout.trim();
}
export function saveCredential(cwd,key) {
  if(typeof key!=='string'||key.length<16||key.length>2048||/[\s\x00-\x1f]/.test(key))throw new Error('BYOK_INVALID_CREDENTIAL');
  const protectedValue=process.platform==='win32'?protect(Buffer.from(key).toString('base64'),true):key;
  writeByok(path.join(byokDirectory(cwd,{create:true}),'credential.json'),{scheme:process.platform==='win32'?'windows-dpapi-current-user':'posix-0600',value:protectedValue});
}
export function loadCredential(cwd) {
  const value=readByok(path.join(byokDirectory(cwd),'credential.json'));
  if(process.platform==='win32'){
    if(value.scheme!=='windows-dpapi-current-user')throw new Error('BYOK_STORAGE_UNSAFE');
    return Buffer.from(protect(value.value,false),'base64').toString('utf8');
  }
  if(value.scheme!=='posix-0600'||typeof value.value!=='string')throw new Error('BYOK_STORAGE_UNSAFE');
  return value.value;
}
