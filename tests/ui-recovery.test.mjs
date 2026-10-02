import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

// Exercise the shipped async handlers with minimal DOM/network doubles. The
// companion ui-recovery.mjs covers actual browser integration and selectors.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const handlers=between('async function createTask(', 'function uiActionKey(')+between('async function action(', '\nasync function mailAction(');
function fixture(){
 const button={disabled:false,innerHTML:'',classList:{remove(){}}};
 const error={textContent:''};
 const form={isConnected:true,dataset:{},fields:{prompt:'synthetic draft',agentId:'coordinator',title:'synthetic reminder',dueAt:new Date(Date.now()+600000).toISOString()},getAttribute(){return this.formId||'task-form';},querySelector(selector){return selector==='.modal-error'?error:button;}};
 const calls={posts:[],renders:[],refreshes:[],toasts:[],closes:0};
 const context=vm.createContext({console,FormData:class{constructor(f){this.f=f;}get(k){return this.f.fields[k]??'';}},document:{contains:e=>e?.isConnected!==false},setTimeout:f=>f(),Date,Number,String,Error,button,form,error,calls,
  crypto:webcrypto,pendingSubmission:null,submitting:false,draft:'synthetic draft',draftVersion:1,navigationVersion:0,selectedTaskId:'prior-selection',state:{settings:{budget:20}},view:'chat',modal:{kind:'reminder'},actionBusy:new Set(),
  $:selector=>selector.includes('button')?button:null,
  post:async(path,body)=>{calls.posts.push({path,body});return{id:'created-task'};},
  loadState:async force=>calls.refreshes.push(force),render:force=>calls.renders.push(force),toast:(text,isError)=>calls.toasts.push({text,isError}),icon:()=>'',date:()=> 'synthetic date',selectActiveChat:id=>{calls.activeChat=id;},closeModal:()=>{calls.closes++;context.modal=null;},navigate:next=>{context.view=next;context.navigationVersion++;},
 });
 vm.runInContext(handlers,context);return {context,button,form,error,calls};
}
function gate(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test('task rejection preserves draft and duplicate submissions stay gated until completion',async()=>{
 const {context,button,form,calls}=fixture(),held=gate();context.post=async(path,body)=>{calls.posts.push({path,body});return held.promise;};
 const first=context.createTask(form);await context.createTask(form);assert.equal(calls.posts.length,1);assert.equal(button.disabled,true);held.reject(new Error('synthetic rejection'));await first;assert.equal(context.draft,'synthetic draft');assert.equal(button.disabled,false);assert.equal(context.submitting,false);
 context.post=async(path,body)=>{calls.posts.push({path,body});return{id:'retry-task'};};await context.createTask(form);assert.equal(calls.posts.length,2);assert.equal(context.draft,'');assert.equal(button.disabled,false);
});
test('late task success preserves newer draft and task-record selection',async()=>{
 const {context,form,calls}=fixture(),held=gate();context.post=()=>held.promise;const request=context.createTask(form);
 context.draft='newer draft';context.draftVersion++;context.view='tasks';context.navigationVersion++;context.selectedTaskId='newer-selection';held.resolve({id:'late-task'});await request;
 assert.equal(context.draft,'newer draft');assert.equal(context.selectedTaskId,'newer-selection');assert.equal(calls.activeChat,undefined);
});
test('late dismissed modal save refreshes without forcing away newer settings edits',async()=>{
 const {context,form,calls}=fixture(),held=gate();form.formId='reminder-form';context.post=()=>held.promise;const request=context.handleForm(form);
 form.isConnected=false;context.view='settings';context.navigationVersion++;context.modal=null;held.resolve({id:'synthetic-reminder'});await request;
 assert.equal(calls.closes,0);assert.deepEqual(calls.refreshes,[false]);
});
test('new task action closes an existing modal before chat navigation',async()=>{
 const {context,calls}=fixture();await context.action('new-task');assert.equal(calls.closes,1);assert.equal(context.modal,null);assert.equal(context.view,'chat');
});

test('successful modal save does not force away unsaved settings behind its overlay',async()=>{
 const {context,form,calls}=fixture();context.view='settings';form.formId='reminder-form';await context.handleForm(form);assert.equal(calls.closes,1);assert.deepEqual(calls.refreshes,[false]);
});
