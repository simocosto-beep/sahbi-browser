import express from "express";
import { chromium } from "playwright";

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
