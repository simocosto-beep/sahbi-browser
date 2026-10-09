import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';

export class BrowserError extends Error {
  constructor(code, detail) { super(code); this.code=code; this.detail=detail; }
}
export const result = data => ({content:[{type:'text',text:JSON.stringify(data)}]});
export function safeError(error) {
  return {ok:false,status:'failed',code:error instanceof BrowserError?error.code:'browser_operation_failed',...(error instanceof BrowserError && error.detail?{detail:error.detail}:{})};
}
export function webUrl(value) {
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)) throw new BrowserError('unsupported_url');
  return u.href;
}
export async function locate(p, a, kind) {
  let l;
  const control=kind==='file'?'input[type=file]':kind==='check'?'input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]':'input,textarea,select,[role=combobox],[role=listbox]';
  if(a.selector) l=p.locator(a.selector);
  else if(a.label) l=p.getByLabel(a.label,{exact:true});
  else if(a.role&&a.name) l=p.getByRole(a.role,{name:a.name,exact:true});
  else if(a.name) l=p.locator(`[name=${JSON.stringify(a.name)}]`);
  else if(a.text) {
    l=kind?p.getByLabel(a.text,{exact:true}):p.getByText(a.text,{exact:true});
    if(kind && await l.count()===0) {
      const ids=await p.locator(control).evaluateAll((els,text)=>els.flatMap((e,i)=>{
        const t=e.closest('label')?.textContent?.trim() || e.parentElement?.textContent?.trim();
        return t===text?[i]:[];
      }),a.text);
      if(ids.length===1) l=p.locator(control).nth(ids[0]);
    }
  } else throw new BrowserError('target_required');
  const n=await l.count();
  if(n!==1) throw new BrowserError(n?'ambiguous_target':'target_not_found');
  if(kind==='file' && !await l.evaluate(e=>e.matches('input[type=file]'))) throw new BrowserError('not_file_input');
  return l;
}

// Executed in the page. No field values are ever logged. Password/auth fields are redacted.
export function inspectForm({selector}={}) {
  const root=selector?document.querySelector(selector):document;
  if(!root) return {error:'form_not_found'};
  const visible=e=>!!(e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && !e.closest('[aria-hidden=true]'));
  const refs=(e,attr)=>(e.getAttribute(attr)||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();
  const label=e=>(Array.from(e.labels||[]).map(l=>l.textContent.trim()).join(' ')||refs(e,'aria-labelledby')||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').trim();
  const elements=Array.from(root.querySelectorAll('input,textarea,select,[role=combobox],[role=checkbox],[role=radio],[role=listbox]'));
  const fields=[];
  for(const e of elements) {
    const type=(e.getAttribute('type')||e.getAttribute('role')||e.tagName).toLowerCase();
    if(['hidden','submit','button','reset','image'].includes(type)) continue;
    const associatedVisible=Array.from(e.labels||[]).some(visible)||visible(e.parentElement);
    const isVisible=visible(e);
    if(!isVisible && !(type==='file'&&associatedVisible) && !(['checkbox','radio'].includes(type)&&Array.from(e.labels||[]).some(visible))) continue;
    const disabled=e.matches(':disabled')||e.getAttribute('aria-disabled')==='true';
    let title=label(e);
    const container=e.closest('.form-group,.field,.mb-3,[data-field]')||e.parentElement;
    const labelText=container?.querySelector('label')?.textContent?.trim()||'';
    if(!title) title=labelText;
    const group=type==='radio'?elements.filter(x=>x.type==='radio'&&x.name===e.name&&x.form===e.form):[e];
    const required=!disabled&&(!!e.required||e.getAttribute('aria-required')==='true'||group.some(x=>x.required)||/\*\s*$/.test(title)||/\*\s*$/.test(labelText));
    const sensitive=type==='password'||/password|passwd|token|secret|otp|one.time|verification.code|security.code/i.test(`${e.name} ${e.id} ${e.autocomplete} ${title}`);
    const value=type==='file'?Array.from(e.files||[]).map(f=>({name:f.name,size:f.size,mimeType:f.type})):['checkbox','radio'].includes(type)?e.checked:typeof e.value==='string'?e.value:e.getAttribute('aria-valuetext')||e.textContent.trim();
    const checked=e.getAttribute('aria-checked');
    const empty=type==='file'?!e.files?.length:type==='radio'?!group.some(x=>x.checked):type==='checkbox'?!e.checked:checked!==null?checked!=='true':String(value??'').trim()==='';
    const errors=[];
    if(required&&empty) errors.push('required');
    if(e.validity && !e.validity.valid) for(const k of ['valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError']) if(e.validity[k]&&!errors.includes(k)) errors.push(k);
    if(e.getAttribute('aria-invalid')==='true') errors.push('aria_invalid');
    const messages=[refs(e,'aria-errormessage')];
    for(const x of container?.querySelectorAll('.invalid-feedback,.error-message,[role=alert],.text-danger')||[]) if(visible(x)) messages.push(x.textContent.trim());
    const validationMessages=[...new Set(messages.filter(Boolean))];
    if(validationMessages.length && !errors.length) errors.push('site_validation_error');
    const options=e.tagName==='SELECT'?Array.from(e.options).map(o=>({text:o.text,value:o.value,selected:o.selected,disabled:o.disabled})):type==='radio'?group.map(x=>({text:label(x),value:x.value,selected:x.checked,disabled:x.disabled})):['combobox','listbox'].includes(type)?Array.from((document.getElementById(e.getAttribute('aria-controls'))||e).querySelectorAll('[role=option]')).map(x=>({text:x.textContent.trim(),value:x.getAttribute('data-value'),selected:x.getAttribute('aria-selected')==='true'})):undefined;
    fields.push({label:title,name:e.name||e.getAttribute('name')||'',id:e.id||'',type,required,visible:isVisible,disabled,value:sensitive?'[REDACTED]':value,options,accept:type==='file'?e.accept:undefined,multiple:type==='file'||e.tagName==='SELECT'?e.multiple:undefined,errors,validationMessages:sensitive?[]:validationMessages});
  }
  return {fields};
}
export async function formState(p,args={}) {
  const out=await p.evaluate(inspectForm,args);
  if(out.error) throw new BrowserError(out.error);
  return {ok:true,...out};
}
export async function validateForm(p,args={}) {
  const {fields}=await formState(p,args);
  const missing=fields.filter(f=>!f.disabled&&f.errors.length).map(({label,name,id,type,required,errors,validationMessages})=>({label,name,id,type,required,errors,validationMessages}));
  return {ok:!missing.length,status:missing.length?'validation_error':'valid',missing};
}
export async function gate(p) {
  const frames=p.frames().map(f=>f.url());
  const body=(await p.locator('body').innerText()).slice(0,100000);
  if(await p.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"]').filter({visible:true}).count() || /verify you are human|complete the captcha|vérifiez que vous êtes humain|checking your browser/i.test(body) || frames.some(u=>/challenge-platform/.test(u))) return 'captcha_required';
  if(await p.locator('input[type=password],input[autocomplete=one-time-code]').filter({visible:true}).count() || /enter (the )?(verification|authentication|security) code|two.factor authentication|code de vérification/i.test(body)) return 'auth_required';
  if(/access denied|unusual traffic|temporarily blocked|subscribe to continue|abonnez-vous pour continuer/i.test(body)) return 'blocked';
  return null;
}
export async function selectField(p,a) {
  const l=await locate(p,a,'field');
  if((a.optionText===undefined)===(a.value===undefined)) throw new BrowserError('choose_optionText_or_value');
  if(await l.evaluate(e=>e.tagName==='SELECT')) {
    const selected=await l.selectOption(a.optionText!==undefined?{label:a.optionText}:{value:a.value});
    return {ok:true,selected};
  }
  await l.click();
  const controlled=await l.getAttribute('aria-controls');
  const scope=controlled?p.locator(`[id=${JSON.stringify(controlled)}]`):p;
  let option=a.optionText!==undefined?scope.getByRole('option',{name:a.optionText,exact:true}):scope.locator(`[role=option][data-value=${JSON.stringify(a.value)}]`);
  if(await option.count()===0 && a.optionText!==undefined) option=scope.getByRole('menuitemradio',{name:a.optionText,exact:true});
  if(await option.count()!==1) throw new BrowserError('option_missing_or_ambiguous');
  await option.click();
  return {ok:true,selected:a.optionText??a.value};
}
export async function checkField(p,a,checked) {
  const l=await locate(p,a,'check');
  const type=await l.evaluate(e=>e.type||e.getAttribute('role'));
  if(!['checkbox','radio'].includes(type)) throw new BrowserError('not_checkable');
  if(type==='radio'&&!checked) throw new BrowserError('radio_cannot_be_unchecked_select_another');
  await l.setChecked(checked);
  return {ok:true,checked:await l.isChecked()};
}
const MIME={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
export function inspectFile(name,buffer,maxBytes=20*1024*1024) {
  if(!buffer.length||buffer.length>maxBytes) throw new BrowserError('file_size_invalid');
  const ext=path.extname(name).toLowerCase();
  let valid=false;
  if(ext==='.pdf') valid=buffer.subarray(0,5).toString()==='%PDF-' && buffer.subarray(-2048).includes(Buffer.from('%%EOF'));
  if(ext==='.docx') {
    try {const z=unzipSync(buffer,{filter:f=>['[Content_Types].xml','word/document.xml'].includes(f.name)&&f.originalSize<5*1024*1024});valid=!!(z['[Content_Types].xml']&&z['word/document.xml']);}catch{}
  }
  if(ext==='.txt') valid=!buffer.includes(0);
  if(ext==='.png') valid=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(ext==='.jpg'||ext==='.jpeg') valid=buffer[0]===255&&buffer[1]===216&&buffer.at(-2)===255&&buffer.at(-1)===217;
  if(!valid) throw new BrowserError('unsupported_or_mismatched_file_type');
  return {name:path.basename(name),mimeType:MIME[ext],size:buffer.length};
}
export async function upload(p,a,roots=['/mnt/data']) {
  const blocked=await gate(p);if(blocked)return {ok:false,status:blocked};
  if((!!a.paths?.length)===(!!a.attachments?.length)) throw new BrowserError('provide_paths_or_attachments');
  const files=[];
  for(const value of a.paths||[]) {
    if(!path.isAbsolute(value)) throw new BrowserError('absolute_file_path_required');
    let real;
    try {real=await fs.realpath(value);}catch{throw new BrowserError('file_not_found',{path:value,filesystem:'browser_server'});}
    const allowed=await Promise.all(roots.map(r=>fs.realpath(r).catch(()=>path.resolve(r))));
    if(!allowed.some(r=>real.startsWith(r+path.sep))) throw new BrowserError('file_outside_upload_roots');
    const stat=await fs.stat(real);
    if(!stat.isFile()||stat.size>20*1024*1024) throw new BrowserError('file_size_invalid');
    const b=await fs.readFile(real);files.push({...inspectFile(real,b),buffer:b});
  }
  for(const f of a.attachments||[]) {
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)||f.base64.length>28*1024*1024) throw new BrowserError('invalid_attachment');
    const b=Buffer.from(f.base64,'base64');const meta=inspectFile(f.name,b);
    if(f.size!==b.length||f.mimeType!==meta.mimeType) throw new BrowserError('attachment_metadata_mismatch');
    files.push({...meta,buffer:b});
  }
  const l=await locate(p,a,'file');
  const spec=await l.evaluate(e=>({multiple:e.multiple,accept:e.accept}));
  if(files.length>1&&!spec.multiple) throw new BrowserError('multiple_files_not_allowed');
  const accepted=spec.accept.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  for(const f of files) if(accepted.length&&!accepted.some(x=>x.startsWith('.')?f.name.toLowerCase().endsWith(x):x.endsWith('/*')?f.mimeType.startsWith(x.slice(0,-1)):x===f.mimeType)) throw new BrowserError('site_file_type_not_allowed');
  await l.setInputFiles(files.map(({name,mimeType,buffer})=>({name,mimeType,buffer})));
  const attached=await l.evaluate(e=>Array.from(e.files).map(f=>({name:f.name,size:f.size,mimeType:f.type})));
  if(attached.length!==files.length||attached.some((f,i)=>f.name!==files[i].name||f.size!==files[i].size)) throw new BrowserError('upload_verification_failed');
  return {ok:true,status:'attached',files:attached};
}
export async function download(p,a,directory) {
  const blocked=await gate(p);if(blocked)return {ok:false,status:blocked};
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const l=await locate(p,a);
  if(await l.evaluate(e=>e.matches('button[type=submit],input[type=submit]')||(e.tagName==='BUTTON'&&!e.type&&e.form))) throw new BrowserError('use_browser_submit');
  const event=p.waitForEvent('download',{timeout:15000});
  // Observe rejection immediately even if click itself throws.
  event.catch(()=>{});
  await l.click();const d=await event;
  const destination=path.resolve(directory,randomUUID()+'-'+path.basename(d.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g,'_'));
  try {await d.saveAs(destination);}catch(error){
    // CDP engine and API can have different filesystems. Re-fetch only the actual
    // browser-initiated download URL, with this context's cookies; never solve a challenge.
    const url=d.url();if(!/^https?:/.test(url))throw new BrowserError('remote_download_stream_unavailable');
    const response=await p.request.get(url,{timeout:15000});
    if(!response.ok())throw new BrowserError('download_failed');
    const body=await response.body();if(body.length>50*1024*1024)throw new BrowserError('download_too_large');
    if(/text\/html/i.test(response.headers()['content-type']||''))throw new BrowserError('download_returned_html_or_challenge');
    await fs.writeFile(destination,body,{mode:0o600});
  }
  if(await d.failure()) throw new BrowserError('download_failed');
  await fs.chmod(destination,0o600);
  const size=(await fs.stat(destination)).size;
  if(a.returnBase64 && size>5*1024*1024)throw new BrowserError('download_too_large_for_inline_transfer',{path:destination});
  return {ok:true,path:destination,name:d.suggestedFilename(),size,filesystem:'browser_server',...(a.returnBase64?{base64:(await fs.readFile(destination)).toString('base64')}:{})};
}
export async function submit(p,a={}) {
  const blocked=await gate(p);if(blocked)return {ok:false,status:blocked};
  const formSelector=a.formSelector;
  if(!formSelector && await p.locator('form').count()!==1) return {ok:false,status:'blocked',code:'form_selector_required'};
  const root=formSelector?p.locator(formSelector):p.locator('form');
  if(await root.count()!==1) throw new BrowserError('form_missing_or_ambiguous');
  const selector=formSelector||'form';
  const validation=await validateForm(p,{selector});
  if(!validation.ok) return validation;
  if(a.knownValuesConfirmed!==true) return {ok:false,status:'blocked',code:'confirm_required_values_are_known'};
  const l=a.selector||a.label||a.text||a.name?await locate(p,a):root.locator('button[type=submit],input[type=submit],button:not([type])');
  if(await l.count()!==1) throw new BrowserError('submit_target_missing_or_ambiguous');
  if(!await l.evaluate((e,s)=>{const f=document.querySelector(s);return e.form===f&&['submit'].includes(e.type);},selector)) throw new BrowserError('not_form_submit_button');
  // Recheck immediately before click. Native validation is never disabled.
  const last=await validateForm(p,{selector});if(!last.ok)return last;
  const before=p.url();
  const successPattern=/application (has been |was )?(successfully )?(submitted|received)|thank you for applying|candidature.{0,30}(envoyée|reçue)|merci pour votre candidature/i;
  const alreadyConfirmed=successPattern.test(await p.locator('body').innerText());
  const errorsBefore=new Set(await p.locator('[role=alert],.alert-danger,.error-message').allTextContents());
  let responseStatus=null;
  const listener=r=>{if(r.request().method()==='POST'&&r.frame()===p.mainFrame()&&r.status()>=400)responseStatus=r.status();};
  p.on('response',listener);
  try {
    await l.click({timeout:10000});
    const deadline=Date.now()+(a.timeoutMs||10000);
    do {
      const gateStatus=await gate(p);if(gateStatus)return {ok:false,status:gateStatus};
      const errors=(await p.locator('[role=alert],.alert-danger,.error-message').filter({visible:true}).allTextContents()).filter(x=>x.trim()&&!errorsBefore.has(x));
      if(errors.length||responseStatus) return {ok:false,status:'failed',messages:errors,httpStatus:responseStatus};
      const text=await p.locator('body').innerText();
      if(!alreadyConfirmed&&successPattern.test(text)) return {ok:true,status:'submitted',confirmation:true,redirected:p.url()!==before};
      if(await root.count()) {const v=await validateForm(p,{selector});if(!v.ok)return v;}
      await p.waitForTimeout(200);
    }while(Date.now()<deadline);
    return {ok:false,status:'blocked',code:'submission_outcome_unconfirmed',redirected:p.url()!==before,retrySafe:false};
  } finally {p.off('response',listener);}
}
