import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Synthetic DOM/network doubles only. Runs the shipped navigate, closeModal,
// loadState and new-task action code; tests/ui-recovery.mjs covers the real browser.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,'slice '+start);return source.slice(a,b);};
const code=between('function navigate(','function formatOutput(')+between('function closeModal(','async function createTask(')+between('async function action(','\nasync function mailAction(');
const deferred=()=>{let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n;});return{promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const stateData=()=>({settings:{},tasks:[],schedules:[],agents:[],memories:[],reminders:[],audit:[],approvals:[]});
const DRAFT='弹窗下方的未提交草稿';

function harness({modalOpen=true}={}){
 const h={apis:[],pending:[],renders:[],toasts:[],promptFocus:0};
 const doc={activeElement:null,body:{tagName:'BODY',style:{overflow:modalOpen?'hidden':''},classList:{remove(){}}},querySelectorAll:()=>[],contains:()=>true};
 let context,children=[];
 const element=(id,tagName,inMain=true)=>({id,tagName,inMain,isConnected:true,value:'',selectionStart:0,selectionEnd:0,
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
  focus(){if(!this.isConnected)return;if(this.id==='prompt-input')h.promptFocus++;doc.activeElement=this;}});
 // A render replaces everything inside #main; a focused control inside it is lost to <body>, as in a browser.
 const paint=()=>{for(const el of children)el.isConnected=false;if(doc.activeElement?.inMain)doc.activeElement=doc.body;
  children=context.view==='chat'?[Object.assign(element('prompt-input','TEXTAREA'),{value:context.draft}),element('agent-select','SELECT')]:[element('model','INPUT')];};
 h.notification=element('notification-button','BUTTON',false);h.modalField=element('reminder-title','INPUT',false);
 h.modalRoot={innerHTML:modalOpen?'<div class="modal"></div>':''};
 h.find=id=>children.find(el=>el.id===id)||null;
 h.resolve=index=>h.pending[index].resolve(stateData());
 context=vm.createContext({console,JSON,Object,Array,Promise,Error,Set,String,setTimeout,clearTimeout,
  document:doc,window:{scrollTo(){}},location:{hash:''},views:{chat:1,tasks:1,settings:1},main:{focus(){}},
  view:'chat',search:'',navigationVersion:0,activeTaskDetail:null,taskDetailRequest:0,modal:modalOpen?{kind:'reminder'}:null,modalReturnFocus:modalOpen?{node:h.notification}:null,
  localAccessChallenge:null,pendingSubmission:{id:'old'},chatTaskId:'old-chat',selectedSkills:[],draftVersion:0,chatTurnCache:new Map(),draft:DRAFT,pendingRender:false,
  state:{settings:{},tasks:[],reminders:[]},pollBusy:false,refreshWaiters:[],settingsSaving:null,settingsEpoch:0,online:true,loaded:true,localAccessAvailable:false,localAccessLastSignature:'[false,null]',lastSignature:'',selectedTaskId:null,notificationSeen:new Set(),
  $:selector=>selector==='#prompt-input'?h.find('prompt-input'):selector==='#modal-root'?h.modalRoot:null,
  api:route=>{h.apis.push(route);const d=deferred();h.pending.push(d);return d.promise;},
  array:value=>Array.isArray(value)?value:[],syncLocalAccess:async()=>{},syncTaskDetail:async()=>{},selectActiveChat:id=>{context.chatTaskId=id;},
  render:force=>{h.renders.push(!!force);const active=doc.activeElement;if(!force&&active?.inMain&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName)){context.pendingRender=true;return;}context.pendingRender=false;paint();},
  renderChrome:()=>{},renderLocalSettingsSummary:()=>'',maybeLocalOnboarding:()=>{},notificationSignature:()=>'',openModal:()=>{},toast:(text,isError)=>h.toasts.push({text,isError}),
 });
 vm.runInContext(code,context);
 paint();h.find('prompt-input').focus();if(modalOpen)h.modalField.focus();
 h.context=context;return h;
}

test('Ctrl+K over a modal keeps the draft and the composer stays focused, caret included, across the late forced state render',async()=>{
 const h=harness();
 await h.context.action('new-task');
 assert.equal(h.context.modal,null);assert.equal(h.modalRoot.innerHTML,'');assert.equal(h.context.document.body.style.overflow,'');
 const first=h.find('prompt-input');assert.equal(h.context.document.activeElement,first,'focused right after the synchronous navigation render');
 first.setSelectionRange(3,3); // the user starts typing before /api/state answers
 h.resolve(0);await settle();
 assert.deepEqual(h.renders,[true,true]);assert.equal(first.isConnected,false,'late forced render replaced the composer');
 const second=h.find('prompt-input');assert.equal(h.context.document.activeElement,second,'focus restored on the replacement composer');
 assert.deepEqual([second.selectionStart,second.selectionEnd],[3,3]);assert.equal(second.value,DRAFT);
 assert.equal(h.context.pendingSubmission,null);assert.equal(h.context.chatTaskId,null);assert.equal(h.context.pollBusy,false);assert.equal(h.context.refreshWaiters.length,0);assert.deepEqual(h.toasts,[]);
});

test('leaving chat before the late state render does not pull focus back to the composer',async()=>{
 const h=harness();
 await h.context.action('new-task');const before=h.promptFocus;
 h.context.navigate('settings');h.find('model').focus();
 h.resolve(0);await settle();h.resolve(1);await settle();
 assert.equal(h.context.view,'settings');assert.equal(h.promptFocus,before);assert.equal(h.find('prompt-input'),null);
 assert.notEqual(h.context.document.activeElement?.id,'prompt-input');assert.deepEqual(h.toasts,[]);
});

test('in the same chat, Tab/click to another control or a click on a blank area is not overridden by the late render',async()=>{
 for(const intent of ['other-control','blank-area']){
  const h=harness();
  await h.context.action('new-task');const before=h.promptFocus;
  if(intent==='other-control')h.find('agent-select').focus();else h.context.document.activeElement=h.context.document.body;
  h.resolve(0);await settle();
  assert.equal(h.context.view,'chat');assert.equal(h.promptFocus,before,intent+' must not be overridden');
  assert.notEqual(h.context.document.activeElement?.id,'prompt-input');assert.deepEqual(h.toasts,[]);
 }
});

test('repeated Ctrl+K while a poll is busy ends with the composer focused after every queued render',async()=>{
 const h=harness();
 const poll=h.context.loadState();assert.equal(h.context.pollBusy,true);
 await h.context.action('new-task');await h.context.action('new-task');
 assert.equal(h.apis.length,1,'forced refreshes wait for the busy poll');
 h.resolve(0);await poll;await settle();assert.equal(h.apis.length,2);
 h.resolve(1);await settle();assert.equal(h.apis.length,3,'second forced refresh is serialized after the first');
 assert.equal(h.context.document.activeElement,h.find('prompt-input'));
 h.resolve(2);await settle();
 assert.equal(h.context.document.activeElement,h.find('prompt-input'));assert.equal(h.find('prompt-input').value,DRAFT);
 assert.equal(h.context.refreshWaiters.length,0);assert.equal(h.context.pollBusy,false);assert.deepEqual(h.toasts,[]);
});

test('a failed state refresh still leaves a focused, usable composer and a visible error',async()=>{
 const h=harness();
 await h.context.action('new-task');h.pending[0].reject(new Error('synthetic state failure'));await settle();
 assert.equal(h.context.document.activeElement,h.find('prompt-input'));assert.equal(h.context.online,false);
 assert.deepEqual(h.toasts,[{text:'synthetic state failure',isError:true}]);assert.equal(h.context.pollBusy,false);
});

test('a forced refresh behind an open modal leaves focus in the modal; the new-task branch has no deferred timer',async()=>{
 const h=harness();
 const refresh=h.context.loadState(true);h.resolve(0);await refresh;await settle();
 assert.equal(h.context.document.activeElement,h.modalField);assert.equal(h.promptFocus,1);
 assert.doesNotMatch(between("if(name==='new-task')",'return;}'),/setTimeout/);
});
