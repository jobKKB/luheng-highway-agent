// Fabricated sites for tests only. No real accounts, websites, or credentials.
import http from 'node:http';
async function server(handler) {
  const s = http.createServer(handler); await new Promise(resolve => s.listen(0,'127.0.0.1',resolve));
  return { server:s, origin:`http://127.0.0.1:${s.address().port}`, close:async()=>{s.closeAllConnections();await new Promise(resolve=>s.close(resolve));} };
}
export async function createControlledBrowserFixtures({ echoSecret = '' } = {}) {
  const escape = value => String(value).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const stats = { inputs:0, saves:0, ticketSaves:0, deniedHTTP:0, deniedWS:0, unauthorizedWrites:0, receivedProxyCredentials:false };
  const denied = await server((_req,res)=>{stats.deniedHTTP++;res.end('SHOULD NEVER LOAD');});
  denied.server.on('upgrade', (_req,socket)=>{stats.deniedWS++;socket.destroy();});
  const oa = await server(async (req,res)=>{
    if(req.headers['proxy-authorization'])stats.receivedProxyCredentials=true;
    const u=new URL(req.url,'http://fixture.local');
    if(u.pathname==='/redirect'){res.writeHead(302,{Location:denied.origin+'/escaped'});return res.end();}
    if(u.pathname==='/sw.js'){res.setHeader('content-type','text/javascript');return res.end('self.addEventListener("fetch",()=>{});');}
    if(u.pathname==='/bootstrap-write'){stats.unauthorizedWrites++;return res.end('no');}
    if(u.pathname==='/whoami'){res.setHeader('content-type','text/plain');return res.end(req.headers.cookie||'anonymous');}
    if(u.pathname==='/autosave'){stats.inputs++;return res.end('saved');}
    if(u.pathname==='/save'){let body='';for await(const chunk of req)body+=chunk;stats.saves++;res.setHeader('Set-Cookie','owner='+encodeURIComponent(body)+'; SameSite=Lax');return res.end(String(stats.saves));}
    if(u.pathname==='/download'){res.setHeader('Content-Disposition','attachment; filename="blocked.txt"');return res.end('test download');}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>虚构公路 OA</title><h1>虚构公路 OA</h1>${echoSecret ? `<p id="echo">${escape(echoSecret)}</p><input id="ordinary-note" aria-label="普通备注" value="${escape(echoSecret)}">` : ''}<ul><li>桥面巡查：待安排</li></ul><p id="profile"></p><p id="cookie"></p><form id="plan"><label for="subject">巡查安排</label><input id="subject" name="subject"><button id="save">保存安排</button></form><p id="result"></p><label for="secret">账号密码</label><input id="secret" type="password" value="fixture-password-not-readable"><a id="download" href="/download">下载测试文件</a><iframe src="${denied.origin}/frame"></iframe><script>
      profile.textContent='存储：'+(localStorage.getItem('owner')||'empty');
      fetch('/whoami').then(r=>r.text()).then(x=>cookie.textContent='会话：'+x);
      fetch('/bootstrap-write',{method:'POST'}).catch(()=>{});
      fetch('${denied.origin}/outside').catch(()=>{});
      try {const ws=new WebSocket('${denied.origin.replace('http:','ws:')}/ws');ws.onerror=()=>{};}catch{}
      try{navigator.serviceWorker?.register('/sw.js')?.catch(()=>{});}catch{}
      subject.addEventListener('input',()=>fetch('/autosave',{method:'POST',body:subject.value}).catch(()=>{}));
      plan.addEventListener('submit',async e=>{e.preventDefault();const count=await fetch('/save',{method:'POST',body:subject.value}).then(r=>r.text());localStorage.setItem('owner',subject.value);profile.textContent='存储：'+subject.value;cookie.textContent='会话：'+await fetch('/whoami').then(r=>r.text());result.textContent='已保存 '+count+'：'+subject.value;});
    </script>`);
  });
  const ticket = await server(async(req,res)=>{
    if(req.method==='POST'&&req.url==='/ticket/update'){stats.ticketSaves++;return res.end(String(stats.ticketSaves));}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>虚构工单中心</title><main><article><header><h2>工单 T-204：路灯维护</h2></header><div><label>处理说明<textarea name="resolution" aria-label="处理说明"></textarea></label></div><div class="actions"><button type="button" aria-label="更新工单">确认更新</button></div><output aria-live="polite"></output></article></main><script>document.querySelector('button').onclick=async()=>{const n=await fetch('/ticket/update',{method:'POST',body:document.querySelector('textarea').value}).then(r=>r.text());document.querySelector('output').textContent='工单已更新 '+n;};</script>`);
  });
  return {stats,oa,ticket,denied,close:async()=>{await Promise.all([oa.close(),ticket.close(),denied.close()]);}};
}
