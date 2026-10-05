import express from "express";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({limit:"2mb"}));
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.SAHBI_TOKEN || "";
let context, page;

function auth(req,res,next){
  if (!TOKEN) return next();
  const v=req.headers.authorization||"";
  if(v!==`Bearer ${TOKEN}`) return res.status(401).json({error:"unauthorized"});
  next();
}
async function browser(){
  if(!context){
    context=await chromium.launchPersistentContext("/tmp/sahbi-profile",{
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    page=context.pages()[0] || await context.newPage();
  }
  return page;
}
app.get("/",(_req,res)=>res.json({name:"Sahbi Browser",version:"0.1.0",status:"ok"}));
app.get("/health",(_req,res)=>res.json({ok:true}));

function createMcpServer(){
  const mcp = new McpServer({name:"sahbi-browser",version:"0.2.0"});
  mcp.tool("browser_open","Open a URL in Sahbi Browser",{url:z.string().url()},async({url})=>{
    const p=await browser(); await p.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title()})}]};
  });
  mcp.tool("browser_read","Read visible text from the current page",{},async()=>{
    const p=await browser(); const body=(await p.locator("body").innerText()).slice(0,50000);
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),text:body})}]};
  });
  mcp.tool("browser_click","Click the first element matching visible text",{text:z.string(),exact:z.boolean().optional()},async({text,exact})=>{
    const p=await browser(); await p.getByText(text,{exact:!!exact}).first().click();
    return {content:[{type:"text",text:JSON.stringify({ok:true,url:p.url(),title:await p.title()})}]};
  });
  mcp.tool("browser_fill","Fill a form field by label",{label:z.string(),value:z.string()},async({label,value})=>{
    const p=await browser(); await p.getByLabel(label).first().fill(value);
    return {content:[{type:"text",text:JSON.stringify({ok:true})}]};
  });
  mcp.tool("browser_snapshot","List interactive elements on the current page",{},async()=>{
    const p=await browser();
    const items=await p.locator("a,button,input,textarea,select").evaluateAll(els=>els.slice(0,300).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim(),type:e.getAttribute("type")})));
    return {content:[{type:"text",text:JSON.stringify({url:p.url(),title:await p.title(),items})}]};
  });
  return mcp;
}
app.all("/mcp",auth,async(req,res)=>{
  const mcp=createMcpServer();
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on("close",()=>{transport.close();mcp.close();});
  try{await mcp.connect(transport); await transport.handleRequest(req,res,req.body);}
  catch(e){if(!res.headersSent)res.status(500).json({error:e.message});}
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
