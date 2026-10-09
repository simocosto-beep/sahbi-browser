// Live, non-submitting regression: requires a real candidate JSON and an existing CV.
// Never commits candidate data; never submits if the expected document is present.
import {promises as fs} from 'node:fs';
import {Sessions} from '../src/session.js';
import {formState,validateForm,upload,submit} from '../src/forms.js';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const root=await fs.mkdtemp('/tmp/sahbi-bridge-');
const options={};
if(process.env.HTTPS_PROXY)options.proxy={server:process.env.HTTPS_PROXY};
if(process.env.NODE_EXTRA_CA_CERTS){const {X509Certificate,createHash}=await import('node:crypto');const cert=new X509Certificate(await fs.readFile(process.env.NODE_EXTRA_CA_CERTS));const pin=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64');options.args=['--no-sandbox',`--ignore-certificate-errors-spki-list=${pin}`];}
const s=new Sessions(root,options);
try {
 const r=await s.current();const spare=await s.page();const p=await r.context.newPage();r.page=p;
 await p.goto('https://www.careers-page.com/bridge-3/job/L9Y55Y7Y/apply',{waitUntil:'domcontentloaded',timeout:60000});
 await p.locator('[name="1653800"]').waitFor();
 for(const [name,value] of Object.entries(input.fields))await p.locator(`[name="${name}"]`).fill(value);
 const attached=await upload(p,{name:'1653804',paths:[input.cv]});
 const state=await formState(p);const validation=await validateForm(p);
 if(validation.missing.length!==1||validation.missing[0].name!=='1674596')throw new Error('Bridge validation differs; do not submit');
 const outcome=await submit(p,{knownValuesConfirmed:true});
 if(outcome.status!=='validation_error')throw new Error('Expected document block');
 const cdps=await r.context.newCDPSession(p);await cdps.send('Page.crash').catch(()=>{});const recovered=await s.page();
 await recovered.locator('[name="1653800"]').waitFor();
 if(spare.isClosed()||r.context.pages().length!==2)throw new Error('Lost other tab');
 for(const [name,value] of Object.entries(input.fields))await recovered.locator(`[name="${name}"]`).fill(value);
 await upload(recovered,{name:'1653804',paths:[input.cv]});
 const after=await validateForm(recovered);
 if(after.missing.length!==1||after.missing[0].name!=='1674596')throw new Error('Recovery validation differs');
 console.log(JSON.stringify({site:'Bridge Education Group',job:'L9Y55Y7Y',cv:attached.files.map(f=>({name:f.name,size:f.size,mimeType:f.mimeType})),requiredFileFields:state.fields.filter(f=>f.type==='file').map(f=>({label:f.label,required:f.required})),status:outcome.status,missing:validation.missing,crashRecovery:s.events,otherTabPreserved:!spare.isClosed(),afterRecovery:after.status,submitted:false},null,2));
}finally {await s.close();await fs.rm(root,{recursive:true,force:true});}
