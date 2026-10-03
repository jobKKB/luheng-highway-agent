import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { now } from './store.mjs';
const MAX_SKILL_BYTES = 65536, MAX_PACKAGE_BYTES = 262144, MAX_FILES = 24;
const digest = value => createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const textFile = name => /\.(md|txt|json|ya?ml|csv)$/i.test(name);
function metadata(content) {
  const head = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!head) throw new Error('SKILL.md 必须包含 name 与 description 的 YAML 头部');
  const scalar = key => {
    const lines = head[1].split(/\r?\n/).filter(line => line.startsWith(key+':'));
    if (lines.length !== 1) throw new Error(`Skill 的 ${key} 必须只出现一次`);
    const raw = lines[0].slice(key.length+1).trim();
    if (!raw || /^[>|\[\]{]/.test(raw)) throw new Error(`Skill 的 ${key} 须为单行文字`);
    const value = raw[0] === '"' ? (() => { try{return JSON.parse(raw);}catch{throw new Error('Skill 元数据引号无效');} })()
      : raw[0] === "'" && raw.endsWith("'") ? raw.slice(1,-1).replace(/''/g,"'") : raw;
    if (typeof value !== 'string' || !value.trim() || value.length > (key==='name'?80:500)) throw new Error('Skill 元数据长度无效');
    return value.trim();
  };
  return {name:scalar('name'),description:scalar('description')};
}
function safeText(value, max) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value,'utf8') > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(value))
    throw new Error('Skill 文件须为有界 UTF-8 纯文本');
  return value.replace(/^\ufeff/,'');
}
export class SkillsService {
  constructor(store) {
    this.store=store; this.root=join(store.dir,'skills');
    mkdirSync(this.root,{recursive:true,mode:0o700});
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root)!==resolve(this.root)) throw new Error('Skills 目录不能是符号链接');
  }
  list() {return this.store.all('skills').map(({id,name,description,importedAt,fileCount,bytes})=>({id,name,description,importedAt,fileCount,bytes,status:'available',readOnly:true}));}
  importPackage(input) {
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['files'].includes(key)) || !Array.isArray(input.files) || !input.files.length || input.files.length>MAX_FILES)
      throw new Error('请选择包含 SKILL.md 的文本包，最多24个文件');
    let bytes=0; const names=new Set();
    const files=input.files.map(file=>{
      if(!file || typeof file!=='object' || Array.isArray(file) || Object.keys(file).some(key=>!['path','content'].includes(key))) throw new Error('Skill 文件结构无效');
      const path=file.path;
      if(typeof path!=='string' || path.length>160 || !/^[A-Za-z0-9\u4e00-\u9fff_. -]+(?:\/[A-Za-z0-9\u4e00-\u9fff_. -]+)*$/u.test(path) || path.split('/').some(part=>part==='.'||part==='..'||part.startsWith('.')) || !textFile(path) || names.has(path)) throw new Error('Skill 文件路径无效；不接受绝对路径、隐藏文件、脚本或重复文件');
      names.add(path); const content=safeText(file.content,path==='SKILL.md'?MAX_SKILL_BYTES:MAX_SKILL_BYTES);bytes+=Buffer.byteLength(content);
      return {path,content};
    }).sort((a,b)=>a.path.localeCompare(b.path));
    if(bytes>MAX_PACKAGE_BYTES) throw new Error('Skill 文本包超过256KB');
    const main=files.find(file=>file.path==='SKILL.md');if(!main)throw new Error('文本包根目录必须有 SKILL.md');
    const meta=metadata(main.content), id=digest(JSON.stringify(files));
    const existing=this.store.get('skills',id);if(existing){this.view(id);return this.list().find(skill=>skill.id===id);}
    const directory=join(this.root,id);mkdirSync(directory,{mode:0o700,recursive:true});
    if(lstatSync(directory).isSymbolicLink()||realpathSync(directory)!==resolve(directory))throw new Error('Skill 包目录不安全');
    // Only an immutable data bundle is saved. Never run imports, shell commands,
    // dependency installation or package scripts. User paths cannot reach disk.
    const bundle=join(directory,'bundle.json');
    if(existsSync(bundle)){if(lstatSync(bundle).isSymbolicLink()||!lstatSync(bundle).isFile()||lstatSync(bundle).size>MAX_PACKAGE_BYTES*6||digest(readFileSync(bundle))!==id)throw new Error('已有 Skill 文本包不安全或损坏；请导入新的版本');}
    else writeFileSync(bundle,JSON.stringify(files),{encoding:'utf8',mode:0o600,flag:'wx'});
    this.store.put('skills',id,{id,...meta,importedAt:now(),fileCount:files.length,bytes});
    this.store.audit('skill.imported',`导入只读 Skill：${meta.name}`);
    return this.list().find(skill=>skill.id===id);
  }
  view(id) {
    if(!safeId(id)||!this.store.get('skills',id))throw new Error('Skill 不存在');
    const directory=join(this.root,id),path=join(directory,'bundle.json');
    if(lstatSync(directory).isSymbolicLink()||lstatSync(path).isSymbolicLink()||realpathSync(path)!==resolve(path)||lstatSync(path).size>MAX_PACKAGE_BYTES*6)throw new Error('Skill 包路径或大小不安全');
    const files=JSON.parse(readFileSync(path,'utf8'));
    if(digest(JSON.stringify(files))!==id)throw new Error('Skill 包已变更，请导入新的版本后再启用');
    return {...this.list().find(skill=>skill.id===id),files};
  }
  resolveSelection(ids=[]) {
    if(!Array.isArray(ids)||ids.length>4||ids.some(id=>!safeId(id))||new Set(ids).size!==ids.length)throw new Error('最多启用4个不同 Skills');
    const selected=ids.map(id=>this.view(id));
    const context=selected.map(skill=>`用户为此对话选用的 Skill：${skill.name}\n${skill.files.find(file=>file.path==='SKILL.md').content}`).join('\n\n');
    if(Buffer.byteLength(context)>MAX_SKILL_BYTES)throw new Error('所选 Skills 合计超过64KB，请减少启用数量');
    return {ids:[...ids],context};
  }
}
