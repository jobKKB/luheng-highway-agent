import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const action=source.split('\n').find(line=>line.startsWith('async function mailAction('));
assert.ok(action);
test('request-send refreshes released busy controls before opening the immutable approval snapshot',async()=>{
 const busy=new Set(),events=[];
 const c=vm.createContext({mailBusy:busy,view:'mail',modal:null,state:{mailApprovals:[]},array:v=>Array.isArray(v)?v:[],mailAccount:()=>({}),document:{contains:()=>false},post:async()=>({approval:{id:'approval-1',draftId:'draft-1'}}),toast(){}});
 c.render=()=>events.push({type:'render',busy:busy.has('draft-1'),modal:!!c.modal});
 c.loadState=async()=>c.render();
 c.openModal=(kind,id)=>{events.push({type:'open',busy:busy.has('draft-1'),kind,id});c.modal={kind,id};};
 vm.runInContext(action,c);
 await vm.runInContext("mailAction('mail-request-send','draft-1',{disabled:false})",c);
 assert.deepEqual(events,[{type:'render',busy:true,modal:false},{type:'render',busy:false,modal:false},{type:'open',busy:false,kind:'mail-approval',id:'approval-1'}]);
 assert.equal(busy.size,0);
});
