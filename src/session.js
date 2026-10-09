import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserError, webUrl } from './forms.js';

export class Sessions {
  constructor(root,options={}) {this.root=root;this.options={...(process.env.SAHBI_EXECUTABLE_PATH?{executablePath:process.env.SAHBI_EXECUTABLE_PATH}:{}),...options};this.profiles=new Map();this.active='default';this.events=[];this.starting=new Map();}
  directory(key) {return key==='default'?this.root:path.join(path.dirname(this.root),'profiles',key);}
  async current() {return this.ensure(this.active);}
  async ensure(key) {
    if(this.profiles.has(key)) return this.profiles.get(key);
    if(this.starting.has(key)) return this.starting.get(key);
    const job=this.start(key);this.starting.set(key,job);
    try{return await job;}finally{this.starting.delete(key);}
  }
  async start(key) {
    const dir=this.directory(key);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);
    let saved=[];try {saved=JSON.parse(await fs.readFile(path.join(dir,'sahbi-tabs.json'),'utf8'));}catch{}
    const remote=key==='default'&&process.env.SAHBI_CDP_URL?await chromium.connectOverCDP(process.env.SAHBI_CDP_URL):null;
    const context=remote?remote.contexts()[0]:await chromium.launchPersistentContext(dir,{headless:true,locale:'fr-FR',timezoneId:'Europe/Paris',viewport:{width:1365,height:900},acceptDownloads:true,args:['--no-sandbox','--disable-dev-shm-usage'],...this.options});
    if(!context)throw new BrowserError('remote_context_missing');
    if(!remote)try {const state=JSON.parse(await fs.readFile(path.join(dir,'sahbi-state.json'),'utf8'));await context.addCookies(state.cookies||[]);}catch{}
    const record={key,context,remote,page:null,tabs:new Map(),recovering:new Map(),restoring:true,closed:false};this.profiles.set(key,record);
    for(const p of context.pages()) this.track(record,p);
    context.on('page',p=>this.track(record,p));
    context.on('close',()=>{record.closed=true;this.profiles.delete(key);});
    if(saved.length && (!remote||context.pages().every(p=>p.url()==='about:blank'))) {
      const blank=context.pages().find(p=>p.url()==='about:blank');
      for(const [i,url] of saved.slice(0,60).entries()) {
        try {webUrl(url);}catch{continue;}
        const p=i===0&&blank?blank:await context.newPage();
        await p.goto(url,{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>{});
      }
    }
    record.restoring=false;record.page=context.pages().at(-1)||await context.newPage();
    await this.persist(record);return record;
  }
  track(r,p) {
    if(r.tabs.has(p))return;
    r.tabs.set(p,p.url());r.page=p;
    p.on('framenavigated',frame=>{if(frame===p.mainFrame()){r.tabs.set(p,p.url());this.persist(r).catch(()=>{});}});
    p.on('close',()=>{r.tabs.delete(p);if(r.page===p)r.page=r.context.pages().at(-1)||null;this.persist(r).catch(()=>{});});
    p.on('crash',()=>{this.recover(r,p).catch(()=>{this.events.push({status:'failed',code:'page_recovery_failed'});});});
  }
  async persist(r) {
    if(r.restoring||r.closed)return;
    const urls=[...r.tabs.values()].filter(u=>/^https?:/.test(u));
    const file=path.join(this.directory(r.key),'sahbi-tabs.json');
    // Each write is serialized; no URLs or cookie state go to logs.
    r.saving=(r.saving||Promise.resolve()).catch(()=>{}).then(()=>fs.writeFile(file,JSON.stringify(urls),{mode:0o600}));
    await r.saving;
  }
  async recover(r,p) {
    if(r.recovering.has(p))return r.recovering.get(p);
    const job=(async()=>{
      const url=r.tabs.get(p)||'about:blank';const active=r.page===p;const previous=r.page;
      const replacement=await r.context.newPage();
      if(!active&&previous&&!previous.isClosed())r.page=previous;
      await p.close().catch(()=>{});
      if(/^https?:/.test(url))await replacement.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
      if(active)r.page=replacement;
      this.events.push({status:'recovered',url,formValuesRestored:false,filesRestored:false});
      await this.persist(r);return replacement;
    })();r.recovering.set(p,job);
    try{return await job;}finally{r.recovering.delete(p);}
  }
  async page() {const r=await this.current();await Promise.all(r.recovering.values());if(!r.page||r.page.isClosed())r.page=r.context.pages().at(-1)||await r.context.newPage();return r.page;}
  async use(domain,account='default') {
    const host=new URL(webUrl(domain.includes('://')?domain:`https://${domain}`)).hostname;
    const key=createHash('sha256').update(`${host}\n${account}`).digest('hex').slice(0,32);
    await this.ensure(key);this.active=key;return {ok:true,profile:key,domain:host};
  }
  async reset(key) {
    if(!/^(default|[a-f0-9]{32})$/.test(key))throw new BrowserError('invalid_profile');
    // Require an existing profile, never reset an inferred path.
    const dir=this.directory(key);try{await fs.access(dir);}catch{throw new BrowserError('profile_not_found');}
    const r=this.profiles.get(key);
    if(r){await this.persist(r);await r.saving;r.closed=true;if(r.remote){await r.context.clearCookies();for(const p of r.context.pages()){await p.evaluate(()=>{localStorage.clear();sessionStorage.clear();}).catch(()=>{});await p.close();}await r.remote.close();}else await r.context.close();this.profiles.delete(key);}
    await fs.rm(dir,{recursive:true,force:true});
    if(this.active===key)this.active='default';
    return {ok:true,profile:key,reset:true};
  }
  async close() {
    for(const r of this.profiles.values()) {await this.persist(r);await fs.writeFile(path.join(this.directory(r.key),'sahbi-state.json'),JSON.stringify(await r.context.storageState()),{mode:0o600});r.closed=true;await r.saving;if(r.remote)await r.remote.close();else await r.context.close();}
    this.profiles.clear();
  }
}
