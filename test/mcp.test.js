import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('real HTTP MCP: OAuth, registration, all tools, takeover exclusion and resume',async()=>{
 const root=await fs.mkdtemp('/tmp/sahbi-mcp-');const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<form><label>CV<input type=file name=cv required></label><button type=submit>Apply</button></form>');});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const base=`http://127.0.0.1:${port}`;const pin=randomBytes(16).toString('hex');
 const proc=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),SAHBI_OAUTH_PIN:pin,SAHBI_PUBLIC_BASE_URL:base,SAHBI_PROFILE_DIR:root+'/profile',SAHBI_OAUTH_STORE_PATH:root+'/oauth.json'},stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',x=>logs+=x);proc.stderr.on('data',x=>logs+=x);
 const anon=new Client({name:'test-anonymous',version:'1'});const client=new Client({name:'test',version:'1'});
 try {
  for(let i=0;i<80;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  await anon.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  const listed=await anon.listTools();for(const name of ['browser_upload','browser_download','browser_select','browser_check','browser_uncheck','browser_form_state','browser_validate_form','browser_submit','browser_session_use','browser_session_reset'])assert(listed.tools.some(t=>t.name===name));
  assert.equal((await anon.callTool({name:'browser_info',arguments:{}})).isError,true);
  const redirect=base+'/callback';const registration=await (await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[redirect]})})).json();
  const verifier=randomBytes(32).toString('base64url');const challenge=createHash('sha256').update(verifier).digest('base64url');
  const fields={client_id:registration.client_id,redirect_uri:redirect,response_type:'code',scope:'browser:control offline_access',code_challenge:challenge,code_challenge_method:'S256',resource:base,pin};
  const auth=await fetch(base+'/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),redirect:'manual'});const code=new URL(auth.headers.get('location')).searchParams.get('code');
  const token=await (await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:registration.client_id,redirect_uri:redirect,code,code_verifier:verifier,resource:base})})).json();assert(token.access_token);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}}}));
  const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});return JSON.parse(r.content[0].text);};
  await call('browser_open',{url:`http://127.0.0.1:${fixture.address().port}`});
  assert((await call('browser_form_state')).fields.some(f=>f.name==='cv'&&f.required));assert.equal((await call('browser_validate_form')).status,'validation_error');
  assert.equal((await call('browser_click',{text:'Apply'})).code,'use_browser_submit');
  const attached=await call('browser_upload',{name:'cv',paths:['/mnt/data/sahbi-test-fixtures/test.docx']});assert.equal(attached.status,'attached');
  assert.equal((await call('browser_validate_form')).status,'valid');
  assert.equal((await call('browser_submit',{knownValuesConfirmed:false})).status,'blocked');
  const handoff=await call('browser_takeover_start',{reason:'login'});assert(handoff.url);const takeoverToken=new URL(handoff.url).hash.slice(1);assert(takeoverToken);const ui=await (await fetch(handoff.url)).text();assert(!ui.includes(takeoverToken));assert(ui.includes('type="password"'));assert.equal((await fetch(base+'/takeover/api/state',{headers:{'x-sahbi-takeover':takeoverToken}})).status,200);assert.equal((await fetch(base+'/takeover/api/state')).status,404);assert.equal((await call('browser_fill',{name:'anything',value:'test'})).code,'human_takeover_active');
  await call('browser_takeover_end');assert((await call('browser_form_state')).ok);assert.equal((await fetch(base+'/takeover/api/state',{headers:{'x-sahbi-takeover':new URL(handoff.url).hash.slice(1)}})).status,404);
  assert(!logs.includes(pin));assert(!logs.includes(token.access_token));
 }finally{await anon.close();await client.close();proc.kill('SIGTERM');await new Promise(r=>proc.once('exit',r));await new Promise(r=>fixture.close(r));await fs.rm(root,{recursive:true,force:true});}
});
