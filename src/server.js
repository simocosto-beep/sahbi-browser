import express from "express";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { setupOAuth } from "./oauth.js";

const app=express();
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:false,limit:"256kb"}));

const PORT=Number(process.env.PORT||8080);
const PROFILE_DIR=process.env.SAHBI_PROFILE_DIR||"/data/profile";
const CDP_URL=String(process.env.SAHBI_CDP_URL||"").trim();
const TAKEOVER_TTL=10*60*1000;

let context=null;
let page=null;
let remoteBrowser=null;
const takeovers=new Map();

function publicBaseUrl(){
  return String(process.env.SAHBI_PUBLIC_BASE_URL||"").replace(/\/$/,"");
}

async function browser(){
  if(!context){
    if(CDP_URL){
      remoteBrowser=await chromium.connectOverCDP(CDP_URL);
      context=remoteBrowser.contexts()[0];
      if(!context) throw new Error("Remote browser has no default context");
    }else{
      context=await chromium.launchPersistentContext(PROFILE_DIR,{
        headless:true,
        locale:"fr-FR",
        timezoneId:"Europe/Paris",
        viewport:{width:1365,height:900},
        acceptDownloads:true,
        serviceWorkers:"allow",
        args:["--no-sandbox","--disable-dev-shm-usage","--window-size=1365,900"]
      });
    }
    page=context.pages()[0]||await context.newPage();
    context.on("page",async newPage=>{
      page=newPage;
      await newPage.waitForLoadState("domcontentloaded",{timeout:15000}).catch(()=>null);
    });
  }
  if(!page||page.isClosed()) page=context.pages().at(-1)||await context.newPage();
  return page;
}

function locatorFor(p,{selector,label,text,role,name}){
  if(selector) return p.locator(selector).first();
  if(label) return p.getByLabel(label).first();
  if(role&&name) return p.getByRole(role,{name}).first();
  if(text) return p.getByText(text).first();
  throw new Error("Provide selector, label, text, or role+name");
}

const {authenticateRequest,oauthChallengeValue}=setupOAuth(app,{publicBaseUrl});

function registerSecure(mcp,authContext,name,description,inputSchema,handler){
  mcp.registerTool(name,{
    description,
    inputSchema,
    securitySchemes:[{type:"oauth2",scopes:["browser:control"]}]
  },async(args)=>{
    if(!authContext){
      return {
        isError:true,
        content:[{type:"text",text:"Authentication required. Connect Sahbi Browser first."}],
        _meta:{"mcp/www_authenticate":[oauthChallengeValue("invalid_token","Connect Sahbi Browser to continue")]}
      };
    }
    try{
      return await handler(args||{});
    }catch(error){
      return {isError:true,content:[{type:"text",text:String(error?.message||error)}]};
    }
  });
}

function createMcp(authContext){
  const mcp=new McpServer({name:"sahbi-browser",version:"2.0.0"});

  registerSecure(mcp,authContext,"browser_info","Get the active page URL, title, viewport, and tab count.",{},async()=>{
    const p=await browser();
    return {content:[{type:"text",text:JSON.stringify({
      url:p.url(),title:await p.title(),
      viewport:await p.evaluate(()=>({width:innerWidth,height:innerHeight})),
      tabs:context.pages().length
    })}]};
  });

  registerSecure(mcp,authContext,"browser_open","Open a URL in the active tab.",{url:z.string().url()},async({url})=>{
    const p=await browser();
    await p.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};
  });

  registerSecure(mcp,authContext,"browser_read","Read visible text from the active page.",{maxChars:z.number().int().min(1000).max(100000).optional()},async({maxChars})=>{
    const p=await browser();
    const text=(await p.locator("body").innerText()).slice(0,maxChars||50000);
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),text})}]};
  });

  registerSecure(mcp,authContext,"browser_snapshot","List visible interactive elements on the page.",{},async()=>{
    const p=await browser();
    const items=await p.locator("a,button,input,textarea,select,[role=button],[role=link]").evaluateAll(els=>
      els.slice(0,300).map((e,i)=>({
        i,
        tag:e.tagName.toLowerCase(),
        role:e.getAttribute("role"),
        text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim().slice(0,300),
        name:e.getAttribute("name"),
        type:e.getAttribute("type"),
        href:e.getAttribute("href")
      }))
    );
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),items})}]};
  });

  registerSecure(mcp,authContext,"browser_click","Click an element by selector, label, visible text, or role+name.",{
    selector:z.string().optional(),label:z.string().optional(),text:z.string().optional(),
    role:z.string().optional(),name:z.string().optional()
  },async(args)=>{
    const p=await browser();
    await locatorFor(p,args).click();
    await p.waitForTimeout(250);
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url(),title:await p.title()})}]};
  });

  registerSecure(mcp,authContext,"browser_fill","Replace a field's value by selector or label.",{
    selector:z.string().optional(),label:z.string().optional(),value:z.string()
  },async(args)=>{
    const p=await browser();
    await locatorFor(p,args).fill(args.value);
    return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });

  registerSecure(mcp,authContext,"browser_press","Press a keyboard key in the active page.",{key:z.string()},async({key})=>{
    const p=await browser();
    await p.keyboard.press(key);
    return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });

  registerSecure(mcp,authContext,"browser_scroll","Scroll the active page.",{
    direction:z.enum(["up","down"]),pixels:z.number().int().positive().max(10000).optional()
  },async({direction,pixels})=>{
    const p=await browser();
    const delta=(pixels||700)*(direction==="up"?-1:1);
    await p.evaluate(y=>scrollBy(0,y),delta);
    return {content:[{type:"text",text:JSON.stringify({ok:true,scrollY:await p.evaluate(()=>scrollY)})}]};
  });

  registerSecure(mcp,authContext,"browser_wait","Wait briefly for a page to settle.",{
    ms:z.number().int().min(0).max(15000)
  },async({ms})=>{
    const p=await browser();
    await p.waitForTimeout(ms);
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url()})}]};
  });

  registerSecure(mcp,authContext,"browser_back","Go back in history.",{},async()=>{
    const p=await browser();
    await p.goBack({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};
  });

  registerSecure(mcp,authContext,"browser_forward","Go forward in history.",{},async()=>{
    const p=await browser();
    await p.goForward({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};
  });

  registerSecure(mcp,authContext,"browser_tabs","List all open tabs.",{},async()=>{
    await browser();
    const tabs=[];
    for(const [index,p] of context.pages().entries()) tabs.push({index,url:p.url(),title:await p.title()});
    return {content:[{type:"text",text:JSON.stringify(tabs)}]};
  });

  registerSecure(mcp,authContext,"browser_new_tab","Open a new tab, optionally at a URL.",{
    url:z.string().url().optional()
  },async({url})=>{
    await browser();
    page=await context.newPage();
    if(url) await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    return {content:[{type:"text",text:JSON.stringify({url:page.url(),title:await page.title()})}]};
  });

  registerSecure(mcp,authContext,"browser_switch_tab","Switch to a tab by index.",{
    index:z.number().int().nonnegative()
  },async({index})=>{
    await browser();
    const pages=context.pages();
    if(!pages[index]) throw new Error("Tab not found");
    page=pages[index];
    await page.bringToFront();
    return {content:[{type:"text",text:JSON.stringify({index,url:page.url(),title:await page.title()})}]};
  });

  registerSecure(mcp,authContext,"browser_close_tab","Close a tab by index or close the active tab.",{
    index:z.number().int().nonnegative().optional()
  },async({index})=>{
    await browser();
    const pages=context.pages();
    const target=index===undefined?page:pages[index];
    if(!target) throw new Error("Tab not found");
    await target.close();
    page=context.pages().at(-1)||await context.newPage();
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:page.url()})}]};
  });

  registerSecure(mcp,authContext,"browser_screenshot","Capture a PNG screenshot.",{
    fullPage:z.boolean().optional()
  },async({fullPage})=>{
    const p=await browser();
    const png=await p.screenshot({type:"png",fullPage:!!fullPage});
    return {content:[{type:"image",data:png.toString("base64"),mimeType:"image/png"}]};
  });

  registerSecure(mcp,authContext,"browser_takeover_start","Create a temporary private takeover page for login, 2FA, CAPTCHA, or manual interaction.",{},async()=>{
    await browser();
    const token=randomBytes(24).toString("hex");
    const expiresAt=Date.now()+TAKEOVER_TTL;
    takeovers.set(token,{expiresAt});
    const base=publicBaseUrl();
    if(!base) throw new Error("SAHBI_PUBLIC_BASE_URL is not configured");
    return {content:[{type:"text",text:JSON.stringify({
      ok:true,url:`${base}/takeover/${token}`,
      expiresAt:new Date(expiresAt).toISOString(),validMinutes:10
    })}]};
  });

  registerSecure(mcp,authContext,"browser_takeover_end","Revoke all active takeover links.",{},async()=>{
    takeovers.clear();
    return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });

  return mcp;
}

async function handleMcp(req,res){
  const authContext=authenticateRequest(req);
  const mcp=createMcp(authContext);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on("close",()=>{transport.close();mcp.close();});
  try{
    await mcp.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch(error){
    console.error("MCP error",error);
    if(!res.headersSent) res.status(500).json({error:String(error?.message||error)});
  }
}

app.get("/",(_req,res)=>res.json({name:"Sahbi Browser",version:"2.0.0",status:"ok",mcp:"/mcp"}));
app.get("/health",(_req,res)=>res.json({ok:true,version:"2.0.0",browserMode:CDP_URL?"remote-cdp":"local"}));
app.all("/mcp",handleMcp);

function takeover(req,res,next){
  const token=String(req.params.token||"");
  const session=takeovers.get(token);
  if(!session||Date.now()>session.expiresAt){
    takeovers.delete(token);
    return res.status(404).send("Takeover expired or not found.");
  }
  next();
}

app.get("/takeover/:token",takeover,async(req,res)=>{
  await browser();
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sahbi Browser</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#111;color:#eee;margin:0}
#bar{position:sticky;top:0;z-index:10;background:#171717;padding:10px;display:grid;gap:8px;border-bottom:1px solid #333}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input,button{min-height:44px;padding:9px 11px;border-radius:10px;border:1px solid #555;background:#222;color:#fff;font:inherit}
button{touch-action:manipulation;white-space:nowrap}button:active{transform:scale(.98)}
#url{flex:1;min-width:180px}#text{flex:1;min-width:160px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
#wrap{padding:8px;overflow:auto;text-align:center}
#screen{display:block;width:100%;max-width:100%;height:auto;margin:auto;border:1px solid #444;background:#fff;cursor:crosshair;touch-action:manipulation}
.note{padding:8px 12px;color:#aaa;font-size:13px}
@media(max-width:600px){#bar{padding:8px}.row{gap:6px}input,button{min-height:46px}#url{min-width:0;width:100%}}
</style></head><body>
<div id="bar">
  <div class="row"><button onclick="back()">←</button><button onclick="refresh()">↻</button><input id="url" autocapitalize="none" autocomplete="off" spellcheck="false"><button onclick="go()">Go</button></div>
  <div class="row"><input id="text" type="text" placeholder="Texte à saisir" autocapitalize="none" autocomplete="off" spellcheck="false"><button id="visibility" onclick="toggleVisibility()">🙈 Masquer</button><button onclick="typeText()">Saisir</button></div>
  <div class="row"><button onclick="key('Enter')">Enter</button><button onclick="key('Tab')">Tab</button><button onclick="scrollPage('up')">↑</button><button onclick="scrollPage('down')">↓</button></div>
</div>
<div class="note">Prise en main privée temporaire. Le texte est visible pendant la saisie ; utilise “Masquer” si nécessaire. Le lien expire automatiquement.</div><div id="wrap"><img id="screen"></div>
<script>
const base='/takeover/'+"${req.params.token}";
const img=document.getElementById('screen');
async function state(){const r=await fetch(base+'/state');const j=await r.json();document.getElementById('url').value=j.url||''}
function refresh(){img.src=base+'/screen.png?t='+Date.now();state()}
img.onclick=async e=>{const r=img.getBoundingClientRect();const x=(e.clientX-r.left)*(img.naturalWidth/r.width);const y=(e.clientY-r.top)*(img.naturalHeight/r.height);await fetch(base+'/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x,y})});setTimeout(refresh,250)}
async function typeText(){const el=document.getElementById('text');const text=el.value;if(!text)return;await fetch(base+'/type',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});el.value='';setTimeout(refresh,250)}
function toggleVisibility(){const el=document.getElementById('text');const b=document.getElementById('visibility');const hiding=el.type==='text';el.type=hiding?'password':'text';b.textContent=hiding?'👁 Afficher':'🙈 Masquer';el.focus()}
async function key(k){await fetch(base+'/key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})});setTimeout(refresh,250)}
async function scrollPage(direction){await fetch(base+'/scroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({direction})});setTimeout(refresh,250)}
async function go(){await fetch(base+'/navigate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:document.getElementById('url').value})});setTimeout(refresh,500)}
async function back(){await fetch(base+'/back',{method:'POST'});setTimeout(refresh,400)}
document.getElementById('text').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();typeText()}})
document.getElementById('url').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go()}})
setInterval(refresh,1800);refresh();
</script></body></html>`);
});

app.get("/takeover/:token/state",takeover,async(_req,res)=>{const p=await browser();res.json({url:p.url(),title:await p.title()})});
app.get("/takeover/:token/screen.png",takeover,async(_req,res)=>{const p=await browser();res.type("png").send(await p.screenshot({type:"png"}))});
app.post("/takeover/:token/click",takeover,async(req,res)=>{const p=await browser();await p.mouse.click(Number(req.body.x),Number(req.body.y));res.json({ok:true})});
app.post("/takeover/:token/type",takeover,async(req,res)=>{const p=await browser();await p.keyboard.insertText(String(req.body.text||""));res.json({ok:true})});
app.post("/takeover/:token/key",takeover,async(req,res)=>{const p=await browser();await p.keyboard.press(String(req.body.key||"Enter"));res.json({ok:true})});
app.post("/takeover/:token/scroll",takeover,async(req,res)=>{const p=await browser();const direction=String(req.body.direction||"down");await p.evaluate(d=>scrollBy(0,d==="up"?-650:650),direction);res.json({ok:true})});
app.post("/takeover/:token/navigate",takeover,async(req,res)=>{const p=await browser();await p.goto(String(req.body.url),{waitUntil:"domcontentloaded",timeout:30000});res.json({ok:true,url:p.url(),title:await p.title()})});
app.post("/takeover/:token/back",takeover,async(_req,res)=>{const p=await browser();await p.goBack({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);res.json({ok:true,url:p.url(),title:await p.title()})});

app.listen(PORT,"0.0.0.0",()=>console.log(`Sahbi Browser 2.0.0 listening on ${PORT}`));
