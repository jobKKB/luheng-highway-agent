'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripBuildOnlyShims, stagingPlan, assertWindowsX64Executable } = require('../stage-utils.cjs');
test('portable staging removes build-only npm CLI shims without losing dependency modules', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'luheng-stage-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.bin'));fs.mkdirSync(path.join(root,'nested/node_modules/.bin'),{recursive:true});
 fs.writeFileSync(path.join(root,'nested/index.js'),'module.exports=true');
 fs.writeFileSync(path.join(root,'.bin/fixture'),'checkout-dependent command');
 fs.writeFileSync(path.join(root,'nested/node_modules/.bin/fixture'),'nested build-only command');
 stripBuildOnlyShims(root);
 assert.equal(fs.existsSync(path.join(root,'.bin')),false);assert.equal(fs.existsSync(path.join(root,'nested/node_modules/.bin')),false);
 assert.equal(fs.readFileSync(path.join(root,'nested/index.js'),'utf8'),'module.exports=true');
});
test('portable staging rejects unresolved production dependency links', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'luheng-stage-link-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'target'));
 fs.symlinkSync(path.join(root,'target'),path.join(root,'unexpected'),'junction');
 assert.throws(()=>stripBuildOnlyShims(root),/unresolved symbolic link/);
});
test('Windows cross-staging selects win64 and preserves the separate Linux bundle', () => {
 assert.deepEqual(stagingPlan({target:'win32',hostPlatform:'linux',arch:'x64'}),{bundleName:'bundle-win32-x64',playwrightPlatform:'win64'});
 assert.equal(stagingPlan({target:'linux',hostPlatform:'linux',arch:'x64',offlineDebian:true}).bundleName,'bundle');
 assert.throws(()=>stagingPlan({target:'win32',hostPlatform:'linux',arch:'arm64'}),/cross-staging/);
 assert.throws(()=>stagingPlan({target:'win32',hostPlatform:'linux',arch:'x64',offlineDebian:true}),/Linux x64 only/);
});
test('Windows browser staging rejects HTML, ELF and wrong-architecture runtime files', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'luheng-pe-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'chrome.exe');
 for(const bytes of [Buffer.from('<html>Site Unavailable</html>'),Buffer.from('\x7fELF'),Buffer.alloc(64)]) {
  fs.writeFileSync(file,bytes);assert.throws(()=>assertWindowsX64Executable(file),/PE executable/);
 }
 const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,0x3c);pe.write('PE\0\0',64);pe.writeUInt16LE(0x14c,68);
 fs.writeFileSync(file,pe);assert.throws(()=>assertWindowsX64Executable(file),/x64 PE header/);
 pe.writeUInt16LE(0x8664,68);fs.writeFileSync(file,pe);assert.doesNotThrow(()=>assertWindowsX64Executable(file));
});
test('installer fails before packaging a runtime staged for a different target', () => {
 const config=require('../electron-builder.cjs');
 assert.throws(()=>config.beforePack({electronPlatformName:'win32',arch:1}),/does not match|ENOENT/);
});
