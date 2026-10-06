import express from "express";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { setupOAuth } from "./oauth.js";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

const app = express();
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:false,limit:"256kb"}));
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.SAHBI_TOKEN || "";
const PLUGIN_KEY = TOKEN ? createHash("sha256").update(`sahbi-plugin:${TOKEN}`).digest("hex") : "";
const LEGACY_PLUGIN_KEY = process.env.SAHBI_LEGACY_PLUGIN_KEY || "";
let context, page, cdpBrowser;
let cloudTakeoverActive=false;
const PROFILE_DIR = process.env.SAHBI_PROFILE_DIR || (process.env.RAILWAY_ENVIRONMENT ? "/data/profile" : "/workspaces/sahbi-browser/.data/profile");
const mcpStats={requests:0,lastMethod:null,lastAt:null,lastStatus:null};
const takeovers=new Map();
const downloads=new Map();
const TAKEOVER_TTL_MS=10*60*1000;
const DOWNLOAD_TTL_MS=10*60*1000;
const MAX_TRANSFER_BYTES=20*1024*1024;
function publicBaseUrl(){
  if(process.env.SAHBI_PUBLIC_BASE_URL) return process.env.SAHBI_PUBLIC_BASE_URL.replace(/\/$/,"");
  if(process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN){
    return `https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  }
  return "";
}
function cloudBrowserUrl(){
  if(process.env.SAHBI_NOVNC_URL) return process.env.SAHBI_NOVNC_URL;
  if(process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN){
    return `https://${process.env.CODESPACE_NAME}-6080.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/vnc.html?autoconnect=1&resize=remote&path=websockify`;
  }
  return "";
}

const {authenticateRequest,oauthChallengeValue}=setupOAuth(app,{legacyToken:TOKEN,legacyPluginKey:LEGACY_PLUGIN_KEY,publicBaseUrl});
function takeoverAuth(req,res,next){
  const id=String(req.params.token||"");
  const session=takeovers.get(id);
  if(!session || Date.now()>session.expiresAt){
    takeovers.delete(id);
    return res.status(404).send("Takeover session expired or not found.");
  }
  next();
}
function downloadAuth(req,res,next){
  const id=String(req.params.token||"");
  const item=downloads.get(id);
  if(!item || Date.now()>item.expiresAt){
    downloads.delete(id);
    return res.status(404).send("Download expired or not found.");
  }
  req.downloadItem=item;
  next();
}
function chooseLocator(p,{selector,label,text}){
  if(selector) return p.locator(selector).first();
  if(label) return p.getByLabel(label).first();
  if(text) return p.getByText(text).first();
  throw new Error("Provide selector, label, or text");
}

function auth(req,res,next){
  const v=String(req.headers.authorization||"");
  const bearer=v.startsWith("Bearer ") ? v.slice(7) : "";
  const directOk=Boolean(TOKEN) && bearer===TOKEN;
  const legacyOk=Boolean(LEGACY_PLUGIN_KEY) && bearer &&
    createHash("sha256").update(`sahbi-plugin:${bearer}`).digest("hex")===LEGACY_PLUGIN_KEY;
  if(!directOk && !legacyOk) return res.status(401).json({error:"unauthorized"});
  next();
}
function pluginCapabilityAuth(req,res,next){
  const supplied=String(req.params.key||"");
  const accepted=[PLUGIN_KEY,LEGACY_PLUGIN_KEY].filter(Boolean);
  if(!accepted.length) return res.status(503).json({error:"plugin capability not configured"});
  const ok=accepted.some(key=>{
    const a=Buffer.from(supplied), b=Buffer.from(key);
    return a.length===b.length && timingSafeEqual(a,b);
  });
  if(!ok) return res.status(404).json({error:"not found"});
  next();
}
async function browser(options={}){
  if(cloudTakeoverActive && !options.allowDuringTakeover){
    throw new Error("Cloud takeover is active. End the takeover before resuming automation.");
  }
  if(!context){
    if(process.env.SAHBI_CDP_URL){
      cdpBrowser=await chromium.connectOverCDP(process.env.SAHBI_CDP_URL);
      context=cdpBrowser.contexts()[0];
      if(!context) throw new Error("No Chromium context available over CDP");
      page=context.pages().at(-1) || await context.newPage();
    }else{
      context=await chromium.launchPersistentContext(PROFILE_DIR,{
        headless:true,
        args:["--no-sandbox","--disable-dev-shm-usage"]
      });
      page=context.pages()[0] || await context.newPage();
    }
  }
  if(!page || page.isClosed()) page=context.pages().at(-1) || await context.newPage();
  return page;
}
app.get("/",(_req,res)=>res.json({name:"Sahbi Browser",version:"0.9.1",status:"ok"}));
app.get("/health",(_req,res)=>res.json({ok:true,version:"0.9.1",mcp:"/mcp"}));
app.get("/mcp-status",auth,(_req,res)=>res.json({ok:true,version:"0.3.1",...mcpStats}));

function secureTool(mcp,authContext,name,description,inputSchema,handler){
  return mcp.registerTool(name,{
    description,
    inputSchema,
    securitySchemes:[{type:"oauth2",scopes:["browser:control"]}]
  },async(args,extra)=>{
    if(!authContext){
      const challenge=oauthChallengeValue("invalid_token","Sign in to Sahbi Browser to continue");
      return {
        isError:true,
        content:[{type:"text",text:"Authentication required: connect Sahbi Browser to continue."}],
        _meta:{"mcp/www_authenticate":[challenge]}
      };
    }
    return handler(args,extra);
  });
}

function createMcpServer(authContext){
  const mcp = new McpServer({name:"sahbi-browser",version:"0.9.1"});
  secureTool(mcp,authContext,"browser_open","Open a URL in Sahbi Browser",{url:z.string().url()},async({url})=>{
    const p=await browser(); await p.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};
  });
  secureTool(mcp,authContext,"browser_read","Read visible text from the current page",{},async()=>{
    const p=await browser(); const body=(await p.locator("body").innerText()).slice(0,50000);
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),text:body})}]};
  });
  secureTool(mcp,authContext,"browser_click","Click the first element matching visible text",{text:z.string(),exact:z.boolean().optional()},async({text,exact})=>{
    const p=await browser(); await p.getByText(text,{exact:!!exact}).first().click();
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url(),title:await p.title()})}]};
  });
  secureTool(mcp,authContext,"browser_fill","Fill a form field by label",{label:z.string(),value:z.string()},async({label,value})=>{
    const p=await browser(); await p.getByLabel(label).first().fill(value);
    return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  secureTool(mcp,authContext,"browser_snapshot","List interactive elements on the current page",{},async()=>{
    const p=await browser();
    const items=await p.locator("a,button,input,textarea,select").evaluateAll(els=>els.slice(0,300).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim(),type:e.getAttribute("type")})));
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),items})}]};
  });
  secureTool(mcp,authContext,"browser_info","Get current page URL, title and viewport",{},async()=>{const p=await browser();return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),viewport:await p.evaluate(()=>({width:innerWidth,height:innerHeight}))})}]};});
  secureTool(mcp,authContext,"browser_back","Go back in browser history",{},async()=>{const p=await browser();await p.goBack({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};});
  secureTool(mcp,authContext,"browser_forward","Go forward in browser history",{},async()=>{const p=await browser();await p.goForward({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};});
  secureTool(mcp,authContext,"browser_new_tab","Open a new tab",{url:z.string().url().optional()},async({url})=>{const p=await context.newPage();page=p;if(url)await p.goto(url,{waitUntil:"domcontentloaded",timeout:30000});return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};});
  secureTool(mcp,authContext,"browser_tabs","List open tabs",{},async()=>{await browser();const pages=context.pages();const tabs=[];for(let i=0;i<pages.length;i++)tabs.push({index:i,url:pages[i].url(),title:await pages[i].title()});return {content:[{type:"text",text:JSON.stringify(tabs)}]};});
  secureTool(mcp,authContext,"browser_switch_tab","Switch active tab",{index:z.number().int().nonnegative()},async({index})=>{await browser();const pages=context.pages();if(!pages[index])throw new Error("Tab not found");page=pages[index];await page.bringToFront();return {content:[{type:"text",text:JSON.stringify({index,url:page.url(),title:await page.title()})}]};});
  secureTool(mcp,authContext,"browser_close_tab","Close a tab",{index:z.number().int().nonnegative().optional()},async({index})=>{await browser();const pages=context.pages();const target=index===undefined?page:pages[index];if(!target)throw new Error("Tab not found");await target.close();page=context.pages().at(-1)||await context.newPage();return {content:[{type:"text",text:JSON.stringify({ok:true,url:page.url()})}]};});
  secureTool(mcp,authContext,"browser_press","Press a keyboard key",{key:z.string()},async({key})=>{const p=await browser();await p.keyboard.press(key);return {content:[{type:"text",text:JSON.stringify({ok:true})}]};});
  secureTool(mcp,authContext,"browser_scroll","Scroll page",{direction:z.enum(["up","down"]),pixels:z.number().int().positive().max(10000).optional()},async({direction,pixels})=>{const p=await browser();const n=(pixels||700)*(direction==="up"?-1:1);await p.evaluate(y=>scrollBy(0,y),n);return {content:[{type:"text",text:JSON.stringify({ok:true,scrollY:await p.evaluate(()=>scrollY)})}]};});
  secureTool(mcp,authContext,"browser_click_selector","Click an element using a CSS selector",{selector:z.string()},async({selector})=>{const p=await browser();await p.locator(selector).first().click();return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url(),title:await p.title()})}]};});
  secureTool(mcp,authContext,"browser_fill_selector","Fill a field using a CSS selector",{selector:z.string(),value:z.string()},async({selector,value})=>{const p=await browser();await p.locator(selector).first().fill(value);return {content:[{type:"text",text:JSON.stringify({ok:true})}]};});
  secureTool(mcp,authContext,"browser_click_role","Click by accessibility role and name",{role:z.string(),name:z.string()},async({role,name})=>{const p=await browser();await p.getByRole(role,{name}).first().click();return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url(),title:await p.title()})}]};});
  secureTool(mcp,authContext,"browser_screenshot","Capture the current page screenshot as base64 PNG",{fullPage:z.boolean().optional()},async({fullPage})=>{const p=await browser();const buf=await p.screenshot({type:"png",fullPage:!!fullPage});return {content:[{type:"image",data:buf.toString("base64"),mimeType:"image/png"}]};});
  secureTool(mcp,authContext,"browser_cookies","List cookies for the current browser context",{},async()=>{await browser();const cookies=await context.cookies();return {content:[{type:"text",text:JSON.stringify(cookies.map(c=>({name:c.name,domain:c.domain,path:c.path,expires:c.expires,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite})))}]};});
  secureTool(mcp,authContext,"browser_wait","Wait for a number of milliseconds",{ms:z.number().int().min(0).max(15000)},async({ms})=>{const p=await browser();await p.waitForTimeout(ms);return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url()})}]};});
  secureTool(mcp,authContext,"browser_type","Type text into a field without clearing it first",{selector:z.string().optional(),label:z.string().optional(),text:z.string()},async({selector,label,text})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,label}); await loc.type(text); return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  secureTool(mcp,authContext,"browser_clear","Clear a form field",{selector:z.string().optional(),label:z.string().optional()},async({selector,label})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,label}); await loc.clear(); return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  secureTool(mcp,authContext,"browser_select","Select an option in a select element",{selector:z.string().optional(),label:z.string().optional(),value:z.string()},async({selector,label,value})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,label}); const selected=await loc.selectOption(value); return {content:[{type:"text",text:JSON.stringify({ok:true,selected})}]};
  });
  secureTool(mcp,authContext,"browser_check","Check or uncheck a checkbox/radio",{selector:z.string().optional(),label:z.string().optional(),checked:z.boolean().optional()},async({selector,label,checked})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,label}); if(checked===false) await loc.uncheck(); else await loc.check(); return {content:[{type:"text",text:JSON.stringify({ok:true,checked:checked!==false})}]};
  });
  secureTool(mcp,authContext,"browser_hover","Hover an element",{selector:z.string().optional(),text:z.string().optional()},async({selector,text})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,text}); await loc.hover(); return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  secureTool(mcp,authContext,"browser_wait_for","Wait for an element by selector or visible text",{selector:z.string().optional(),text:z.string().optional(),state:z.enum(["attached","detached","visible","hidden"]).optional(),timeoutMs:z.number().int().min(100).max(30000).optional()},async({selector,text,state,timeoutMs})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,text}); await loc.waitFor({state:state||"visible",timeout:timeoutMs||10000}); return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  secureTool(mcp,authContext,"browser_get_attribute","Read an element attribute",{selector:z.string().optional(),label:z.string().optional(),name:z.string()},async({selector,label,name})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,label}); const value=await loc.getAttribute(name); return {content:[{type:"text",text:JSON.stringify({name,value})}]};
  });
  secureTool(mcp,authContext,"browser_download_click","Click an element and capture the resulting download. Returns a private temporary download link valid for 10 minutes.",{selector:z.string().optional(),text:z.string().optional(),timeoutMs:z.number().int().min(1000).max(30000).optional()},async({selector,text,timeoutMs})=>{
    const p=await browser(); const loc=chooseLocator(p,{selector,text});
    const [dl]=await Promise.all([p.waitForEvent("download",{timeout:timeoutMs||15000}),loc.click()]);
    const stream=await dl.createReadStream(); const chunks=[]; let total=0;
    for await (const chunk of stream){ total+=chunk.length; if(total>MAX_TRANSFER_BYTES) throw new Error("Download exceeds 20 MB limit"); chunks.push(chunk); }
    const buffer=Buffer.concat(chunks); const token=randomBytes(24).toString("hex"); const expiresAt=Date.now()+DOWNLOAD_TTL_MS;
    const filename=dl.suggestedFilename()||"download.bin"; downloads.set(token,{buffer,filename,expiresAt});
    const base=publicBaseUrl(); const url=(base?base:"")+`/download/${token}`;
    return {content:[{type:"text",text:JSON.stringify({ok:true,filename,sizeBytes:buffer.length,url,expiresAt:new Date(expiresAt).toISOString(),validMinutes:10})}]};
  });
  secureTool(mcp,authContext,"browser_form_inspect","Inspect visible form fields, labels, types and validation state",{},async()=>{
    const p=await browser();
    const fields=await p.locator("input,textarea,select,button").evaluateAll(els=>els.map((e,index)=>{
      const tag=e.tagName.toLowerCase();
      const type=(e.getAttribute("type")||"").toLowerCase();
      let label=e.getAttribute("aria-label")||"";
      if(!label && e.id){
        const l=Array.from(document.querySelectorAll("label")).find(x=>x.htmlFor===e.id);
        if(l) label=(l.innerText||"").trim();
      }
      if(!label){
        const parent=e.closest("label");
        if(parent) label=(parent.innerText||"").trim();
      }
      return {
        index,tag,type,
        name:e.getAttribute("name"),
        id:e.id||null,
        label,
        placeholder:e.getAttribute("placeholder"),
        required:!!e.required,
        disabled:!!e.disabled,
        checked:"checked" in e ? !!e.checked : null,
        value:type==="password" ? "[hidden]" : ("value" in e ? e.value : null)
      };
    }));
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),fields})}]};
  });

  secureTool(mcp,authContext,"browser_form_fill","Fill several form fields intelligently in one call",{
    fields:z.array(z.object({
      selector:z.string().optional(),
      label:z.string().optional(),
      name:z.string().optional(),
      value:z.string(),
      action:z.enum(["fill","select","check","uncheck"]).optional()
    }))
  },async({fields})=>{
    const p=await browser();
    const results=[];
    for(const f of fields){
      let loc;
      if(f.selector) loc=p.locator(f.selector).first();
      else if(f.label) loc=p.getByLabel(f.label).first();
      else if(f.name) loc=p.locator('[name="'+f.name.replace(/"/g,'\\"')+'"]').first();
      else throw new Error("Each field needs selector, label, or name");

      const meta=await loc.evaluate(e=>({
        tag:e.tagName.toLowerCase(),
        type:(e.getAttribute("type")||"").toLowerCase()
      }));

      const action=f.action ||
        (meta.tag==="select" ? "select" :
        (meta.type==="checkbox" || meta.type==="radio") ? "check" : "fill");

      if(action==="select"){
        try{ await loc.selectOption({label:f.value}); }
        catch{ await loc.selectOption(f.value); }
      } else if(action==="check"){
        await loc.check();
      } else if(action==="uncheck"){
        await loc.uncheck();
      } else {
        await loc.fill(f.value);
      }
      results.push({ok:true,label:f.label||null,name:f.name||null,action});
    }
    return {content:[{type:"text",text:JSON.stringify({ok:true,results})}]};
  });

  secureTool(mcp,authContext,"browser_validation_errors","Read browser validation errors and visible error messages",{},async()=>{
    const p=await browser();
    const invalid=await p.locator("input:invalid,textarea:invalid,select:invalid").evaluateAll(els=>els.map(e=>({
      name:e.getAttribute("name"),
      id:e.id||null,
      type:e.getAttribute("type"),
      message:e.validationMessage||""
    })));
    const visibleErrors=await p.locator('[role="alert"],.error,.errors,.invalid-feedback,.field-error').evaluateAll(
      els=>els.filter(e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length))
              .map(e=>(e.innerText||"").trim()).filter(Boolean).slice(0,50)
    );
    return {content:[{type:"text",text:JSON.stringify({invalid,visibleErrors})}]};
  });

  secureTool(mcp,authContext,"browser_popup_wait","Wait for a popup/new window, optionally triggered by clicking an element",{
    selector:z.string().optional(),
    text:z.string().optional(),
    timeoutMs:z.number().int().min(500).max(30000).optional()
  },async({selector,text,timeoutMs})=>{
    const p=await browser();
    const timeout=timeoutMs||15000;
    let popup;
    if(selector || text){
      const loc=selector ? p.locator(selector).first() : p.getByText(text).first();
      [popup]=await Promise.all([
        p.waitForEvent("popup",{timeout}),
        loc.click()
      ]);
    }else{
      popup=await p.waitForEvent("popup",{timeout});
    }
    page=popup;
    await popup.waitForLoadState("domcontentloaded",{timeout}).catch(()=>{});
    const pages=context.pages();
    return {content:[{type:"text",text:JSON.stringify({
      ok:true,index:pages.indexOf(popup),url:popup.url(),title:await popup.title()
    })}]};
  });

  secureTool(mcp,authContext,"browser_downloads","List temporary downloads currently available",{},async()=>{
    const now=Date.now();
    const base=publicBaseUrl();
    const items=[];
    for(const [token,item] of downloads){
      if(now>item.expiresAt){ downloads.delete(token); continue; }
      items.push({
        filename:item.filename,
        sizeBytes:item.buffer.length,
        url:(base?base:"")+"/download/"+token,
        expiresAt:new Date(item.expiresAt).toISOString()
      });
    }
    return {content:[{type:"text",text:JSON.stringify({downloads:items})}]};
  });

  secureTool(mcp,authContext,"browser_resume_after_takeover","Resume automation after the user completed login/2FA/CAPTCHA",{
    revokeActive:z.boolean().optional()
  },async({revokeActive})=>{
    const p=await browser();
    if(revokeActive!==false) takeovers.clear();
    const pages=context.pages();
    const cookies=await context.cookies();
    return {content:[{type:"text",text:JSON.stringify({
      ok:true,
      url:p.url(),
      title:await p.title(),
      tabs:pages.length,
      cookies:cookies.length,
      takeoverRevoked:revokeActive!==false
    })}]};
  });

  secureTool(mcp,authContext,"browser_cloud_takeover_start","Give the user direct interactive control of the same visible Chromium session through the private GitHub Codespaces noVNC port. Automation pauses until browser_cloud_takeover_end is called.",{},async()=>{
    await browser();
    const url=cloudBrowserUrl();
    if(!url) throw new Error("Cloud browser URL is not configured");
    cloudTakeoverActive=true;
    return {content:[{type:"text",text:JSON.stringify({ok:true,url,mode:"interactive-cloud-browser",automationPaused:true})}]};
  });
  secureTool(mcp,authContext,"browser_cloud_takeover_end","Return control of the visible Chromium session to automation.",{},async()=>{
    cloudTakeoverActive=false;
    const p=await browser({allowDuringTakeover:true});
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url(),title:await p.title(),automationPaused:false})}]};
  });
  secureTool(mcp,authContext,"browser_cloud_status","Report whether the interactive cloud-browser takeover is active and the current browser page.",{},async()=>{
    const p=await browser({allowDuringTakeover:true});
    return {content:[{type:"text",text:JSON.stringify({takeoverActive:cloudTakeoverActive,url:p.url(),title:await p.title(),mode:process.env.SAHBI_CDP_URL?"headed-cdp":"headless-fallback"})}]};
  });
  secureTool(mcp,authContext,"browser_takeover_start","Create a temporary private takeover link so the user can interact directly with the current browser for login, 2FA, CAPTCHA, or other sensitive steps. The link expires automatically.",{},async()=>{
    await browser();
    const token=randomBytes(24).toString("hex");
    const expiresAt=Date.now()+TAKEOVER_TTL_MS;
    takeovers.set(token,{expiresAt});
    const base=publicBaseUrl();
    const path=`/takeover/${token}`;
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:base?base+path:path,expiresAt:new Date(expiresAt).toISOString(),validMinutes:10})}]};
  });
  secureTool(mcp,authContext,"browser_takeover_end","Immediately revoke all active takeover links",{},async()=>{
    takeovers.clear();
    return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  return mcp;
}
async function handleMcp(req,res){
  mcpStats.requests++; mcpStats.lastMethod=req.body?.method||req.method; mcpStats.lastAt=new Date().toISOString();
  const authContext=authenticateRequest(req);
  const mcp=createMcpServer(authContext);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on("close",()=>{transport.close();mcp.close();});
  try{await mcp.connect(transport); await transport.handleRequest(req,res,req.body); mcpStats.lastStatus=res.statusCode;}
  catch(e){mcpStats.lastStatus=500; console.error("MCP error",e); if(!res.headersSent)res.status(500).json({error:e.message});}
}
app.all("/mcp",handleMcp);
app.all("/plugin-mcp/:key",pluginCapabilityAuth,handleMcp);

app.get("/takeover/:token",takeoverAuth,async(req,res)=>{
  await browser();
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sahbi Browser Takeover</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#111;color:#eee}
#bar{position:sticky;top:0;z-index:5;background:#1b1b1b;padding:10px;display:flex;gap:8px;flex-wrap:wrap}
input,button{font:inherit;padding:9px;border-radius:8px;border:1px solid #555;background:#222;color:#fff}
#url{flex:1;min-width:260px}.secret{min-width:220px}
button{cursor:pointer}.note{padding:8px 12px;font-size:13px;color:#bbb}
#wrap{padding:10px}#screen{display:block;max-width:100%;height:auto;border:1px solid #444;background:#fff;cursor:crosshair}
</style></head>
<body>
<div id="bar">
  <button onclick="back()">←</button>
  <button onclick="refresh()">↻</button>
  <input id="url" placeholder="https://example.com">
  <button onclick="go()">Go</button>
  <input id="text" class="secret" type="password" autocomplete="off" placeholder="Private typing (password/2FA)">
  <button onclick="sendText()">Type</button>
  <button onclick="key('Enter')">Enter</button>
  <button onclick="key('Tab')">Tab</button>
  <button onclick="key('Escape')">Esc</button>
  <input id="file" type="file">
  <input id="fileSelector" value='input[type="file"]' placeholder="file input selector">
  <button onclick="uploadFile()">Upload file</button>
</div>
<div class="note">Temporary takeover session. Click the screenshot to focus fields/buttons, then use “Private typing” for passwords or 2FA. This page expires automatically.</div>
<div id="wrap"><img id="screen" alt="browser screen"></div>
<script>
const token=${JSON.stringify(req.params.token)};
const base='/takeover/'+token;
const img=document.getElementById('screen');
async function state(){try{const r=await fetch(base+'/state');const j=await r.json();document.getElementById('url').value=j.url||'';}catch{}}
function refresh(){img.src=base+'/screen.png?t='+Date.now();state();}
img.addEventListener('click',async e=>{
 const r=img.getBoundingClientRect();
 const x=(e.clientX-r.left)*(img.naturalWidth/r.width);
 const y=(e.clientY-r.top)*(img.naturalHeight/r.height);
 await fetch(base+'/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x,y})});
 setTimeout(refresh,250);
});
async function sendText(){const el=document.getElementById('text');const text=el.value;el.value='';await fetch(base+'/type',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});setTimeout(refresh,250);}
async function key(k){await fetch(base+'/key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})});setTimeout(refresh,250);}
async function go(){const url=document.getElementById('url').value;await fetch(base+'/navigate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});setTimeout(refresh,500);}
async function back(){await fetch(base+'/back',{method:'POST'});setTimeout(refresh,400);}
async function uploadFile(){
 const file=document.getElementById('file').files[0]; if(!file){alert('Choose a file first');return;}
 const selector=document.getElementById('fileSelector').value||'input[type="file"]';
 const buf=await file.arrayBuffer();
 const r=await fetch(base+'/upload',{method:'POST',headers:{'content-type':'application/octet-stream','x-filename':encodeURIComponent(file.name),'x-mime-type':file.type||'application/octet-stream','x-selector':selector},body:buf});
 const j=await r.json(); if(!r.ok) alert(j.error||'Upload failed'); else alert('File attached: '+file.name);
 setTimeout(refresh,300);
}
setInterval(refresh,1800);refresh();
</script></body></html>`);
});
app.get("/takeover/:token/state",takeoverAuth,async(req,res)=>{const p=await browser();res.json({url:p.url(),title:await p.title()});});
app.get("/takeover/:token/screen.png",takeoverAuth,async(req,res)=>{const p=await browser();const png=await p.screenshot({type:"png"});res.type("png").send(png);});
app.post("/takeover/:token/click",takeoverAuth,async(req,res)=>{const p=await browser();await p.mouse.click(Number(req.body.x),Number(req.body.y));res.json({ok:true});});
app.post("/takeover/:token/type",takeoverAuth,async(req,res)=>{const p=await browser();await p.keyboard.insertText(String(req.body.text??""));res.json({ok:true});});
app.post("/takeover/:token/key",takeoverAuth,async(req,res)=>{const p=await browser();await p.keyboard.press(String(req.body.key||"Enter"));res.json({ok:true});});
app.post("/takeover/:token/navigate",takeoverAuth,async(req,res)=>{const p=await browser();await p.goto(String(req.body.url),{waitUntil:"domcontentloaded",timeout:30000});res.json({ok:true,url:p.url(),title:await p.title()});});
app.post("/takeover/:token/back",takeoverAuth,async(req,res)=>{const p=await browser();await p.goBack({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);res.json({ok:true,url:p.url(),title:await p.title()});});
app.post("/takeover/:token/upload",takeoverAuth,express.raw({type:"application/octet-stream",limit:"20mb"}),async(req,res)=>{
  try{
    const p=await browser();
    const filename=decodeURIComponent(String(req.headers["x-filename"]||"upload.bin"));
    const mimeType=String(req.headers["x-mime-type"]||"application/octet-stream");
    const selector=String(req.headers["x-selector"]||'input[type="file"]');
    const buffer=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||[]);
    await p.locator(selector).first().setInputFiles({name:filename,mimeType,buffer});
    res.json({ok:true,filename,sizeBytes:buffer.length});
  }catch(e){res.status(400).json({error:e.message});}
});
app.get("/download/:token",downloadAuth,(req,res)=>{
  const item=req.downloadItem;
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`);
  res.send(item.buffer);
});
app.use("/api",auth);
app.post("/api/open",async(req,res)=>{
  try{const p=await browser(); await p.goto(req.body.url,{waitUntil:"domcontentloaded",timeout:30000}); res.json({ok:true,url:p.url(),title:await p.title()});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/read",async(_req,res)=>{
  try{const p=await browser(); res.json({url:p.url(),title:await p.title(),text:(await p.locator("body").innerText()).slice(0,50000)});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/click",async(req,res)=>{
  try{const p=await browser(); await p.getByText(req.body.text,{exact:!!req.body.exact}).first().click(); res.json({ok:true,url:p.url(),title:await p.title()});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/fill",async(req,res)=>{
  try{const p=await browser(); const loc=req.body.label?p.getByLabel(req.body.label):p.locator(req.body.selector); await loc.first().fill(String(req.body.value??"")); res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/snapshot",async(_req,res)=>{
  try{const p=await browser(); const items=await p.locator("a,button,input,textarea,select").evaluateAll(els=>els.slice(0,300).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim(),type:e.getAttribute("type")}))); res.json({url:p.url(),title:await p.title(),items});}
  catch(e){res.status(500).json({error:e.message});}
});
app.listen(PORT,"0.0.0.0",()=>console.log(`Sahbi Browser listening on ${PORT}`));
