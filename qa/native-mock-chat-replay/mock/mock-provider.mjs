// Local-only deterministic model substitute. Built-in Node modules only.
import http from 'node:http';
import {createHash} from 'node:crypto';

export const MODEL = 'luheng-local-mock-acceptance';
export const DUMMY_KEY = 'luheng-disposable-mock-not-a-real-key';
const MAX_BODY = 8 * 1024 * 1024;
const digest = x => createHash('sha256').update(x).digest('hex');
const contentText = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(p => p?.type === 'text' ? p.text : '').join('\n') : '';

export function createProtocol({markerPath, markerText, nonce}) {
  if (!markerPath || !/^LUHENG_READ_MARKER_[a-f0-9]{32}$/.test(markerText) || !/^[a-f0-9]{32}$/.test(nonce)) throw Error('Invalid synthetic fixture');
  const prompt = `Local acceptance ${nonce}: use read_file once to read exactly ${markerPath}, offset 1, limit 5. Then report the result. Do not use any other tool.`;
  const finalText = `LUHENG_MOCK_ORCHESTRATION_OK ${nonce}: owned marker read through the real app tool loop.`;
  const callId = `call_luheng_${nonce}`;
  const args = {path:markerPath, offset:1, limit:5};
  const state = {schema:1, kind:'mocked-model-orchestration', stage:0, model:MODEL, model_requests:0,
    discovery_requests:0, transport_probes:0, rejected_requests:0, failure:null, requests:[],
    tool_name:'read_file', tool_call_id:callId, marker_sha256:digest(markerText), marker_verified:false,
    real_provider_verified:false, llm_quality_verified:false, offline_verified:false};
  function reject(code) {
    state.rejected_requests++;
    state.failure ||= code;
    throw Error(code);
  }
  function completion(body) {
    if (state.failure) reject('protocol_already_failed');
    if (body?.model !== MODEL || !Array.isArray(body?.messages)) reject('unexpected_model_or_messages');
    if (body.messages.length === 1 && body.messages[0].role === 'user' && body.messages[0].content === 'hi'
        && body.max_tokens === 1 && !body.stream && !body.tools && state.stage === 0 && state.transport_probes < 2) {
      state.transport_probes++;
      return {kind:'probe', content:'ok'};
    }
    if (state.stage >= 2) reject('unexpected_extra_model_request');
    if (body.messages.length > 256 || body.messages.some(m => !m || !['system','developer','user','assistant','tool'].includes(m.role))) reject('unexpected_message_shape');
    const users = body.messages.filter(m => m.role === 'user');
    if (users.length !== 1 || !contentText(users[0].content).includes(prompt)) reject('unexpected_user_turn');
    const tools = body.messages.filter(m => m.role === 'tool');
    const calls = body.messages.flatMap(m => m.tool_calls || []);
    if (body.messages.some(m => m.role !== 'tool' && contentText(m.content).includes(markerText))) reject('marker_leaked_outside_tool_result');
    if (state.stage === 0) {
      if (tools.length || calls.length) reject('premature_tool_history');
      const schemas = (body.tools || []).filter(t => t?.type === 'function' && t.function?.name === 'read_file');
      if (schemas.length !== 1 || schemas[0].function.parameters?.properties?.path?.type !== 'string') reject('read_file_schema_missing');
      state.stage = 1;
      state.model_requests++;
      state.requests.push({sequence:1, streaming:body.stream === true, message_count:body.messages.length,
        advertised_tool_count:body.tools.length, returned_tool:'read_file'});
      return {kind:'tool', callId, args};
    }
    if (tools.length !== 1 || calls.length !== 1 || calls[0].id !== callId || calls[0].type !== 'function'
        || calls[0].function?.name !== 'read_file' || tools[0].tool_call_id !== callId
        || (tools[0].name && tools[0].name !== 'read_file')) reject('unexpected_tool_roundtrip');
    let returnedArgs;
    try {returnedArgs = JSON.parse(calls[0].function.arguments);} catch {reject('tool_arguments_invalid');}
    if (returnedArgs.path !== markerPath || returnedArgs.offset !== 1 || returnedArgs.limit !== 5
        || Object.keys(returnedArgs).length !== 3) reject('tool_arguments_changed');
    const toolText = contentText(tools[0].content);
    if (!toolText.includes(markerText) || toolText.length > 20000) reject('owned_marker_result_missing');
    state.marker_verified = true;
    state.model_requests++;
    state.stage = 2;
    state.requests.push({sequence:2, streaming:body.stream === true, message_count:body.messages.length,
      tool_result_bytes:Buffer.byteLength(toolText), tool_result_sha256:digest(toolText), marker_verified:true});
    return {kind:'final', content:finalText};
  }
  return {state,prompt,finalText,completion,reject};
}

export async function startMockProvider(fixture) {
  const protocol = createProtocol(fixture);
  const sockets = new Set();
  const server = http.createServer(async (req,res) => {
    const send = (status,payload) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
    try {
      if (protocol.state.failure) protocol.reject('protocol_already_failed');
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${server.address().port}`) protocol.reject('non_loopback_or_host');
      if (req.headers.authorization !== `Bearer ${DUMMY_KEY}`) protocol.reject('non_synthetic_auth');
      if (req.method === 'GET' && req.url === '/v1/models') {
        if (++protocol.state.discovery_requests > 32) protocol.reject('discovery_limit');
        send(200,{object:'list',data:[{id:MODEL,object:'model',created:0,owned_by:'disposable-local-mock'}]});
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') protocol.reject('unexpected_route_or_method');
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) protocol.reject('unexpected_content_type');
      let bytes=0, chunks=[];
      for await (const c of req) {bytes+=c.length; if(bytes>MAX_BODY) protocol.reject('request_too_large'); chunks.push(c);}
      let body;
      try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {protocol.reject('invalid_json');}
      const answer=protocol.completion(body);
      const meta={id:`chatcmpl-local-${fixture.nonce}-${protocol.state.model_requests}`,created:Math.floor(Date.now()/1000),model:MODEL};
      const message=answer.kind === 'tool'
        ? {role:'assistant',content:null,tool_calls:[{id:answer.callId,type:'function',function:{name:'read_file',arguments:JSON.stringify(answer.args)}}]}
        : {role:'assistant',content:answer.content};
      const finish=answer.kind === 'tool' ? 'tool_calls' : 'stop';
      if (body.stream === true) {
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        const event=(delta,finish_reason=null) => res.write(`data: ${JSON.stringify({...meta,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`);
        event({role:'assistant'});
        if(answer.kind==='tool') {
          const text=JSON.stringify(answer.args), split=Math.floor(text.length/2);
          event({tool_calls:[{index:0,id:answer.callId,type:'function',function:{name:'read_file',arguments:text.slice(0,split)}}]});
          event({tool_calls:[{index:0,function:{arguments:text.slice(split)}}]});
        } else {
          const split=Math.floor(answer.content.length/2);
          event({content:answer.content.slice(0,split)}); event({content:answer.content.slice(split)});
        }
        event({},finish);
        res.write(`data: ${JSON.stringify({...meta,object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        send(200,{...meta,object:'chat.completion',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
      }
    } catch {
      // Never serialize request bodies, auth, external errors or full prompts.
      if (!protocol.state.failure) {protocol.state.failure='server_protocol_error';protocol.state.rejected_requests++;}
      if (!res.headersSent) send(400,{error:{message:'Local synthetic acceptance protocol rejected the request',type:'invalid_request_error'}});
      else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=15000;server.keepAliveTimeout=1000;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  if(address.address !== '127.0.0.1' || address.port < 1) throw Error('Loopback bind failed');
  return {...protocol,baseUrl:`http://127.0.0.1:${address.port}/v1`,port:address.port,
    async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
