import express from "express";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const app=express();
const PORT=Number(process.env.PORT||8080);
const CDP_PORT=Number(process.env.SAHBI_CDP_PORT||9222);
const INTERNAL_CDP_PORT=Number(process.env.SAHBI_INTERNAL_CDP_PORT||9223);
const PROFILE_DIR=process.env.SAHBI_PROFILE_DIR||"/data/profile";

const args=[
  `--user-data-dir=${PROFILE_DIR}`,
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${INTERNAL_CDP_PORT}`,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1365,900",
  "--lang=fr-FR",
  "--no-first-run",
  "--no-default-browser-check"
];

const child=spawn(chromium.executablePath(),args,{
  stdio:"inherit",
  env:{...process.env,LANG:"fr_FR.UTF-8",TZ:"Europe/Paris"}
});

let exited=false;
child.on("exit",(code,signal)=>{
  exited=true;
  console.error("Chromium exited",{code,signal});
});

const proxy=http.createServer((req,res)=>{
  const headers={...req.headers,host:`localhost:${INTERNAL_CDP_PORT}`};
  const upstream=http.request({
    host:"127.0.0.1",
    port:INTERNAL_CDP_PORT,
    method:req.method,
    path:req.url,
    headers
  },upRes=>{
    const chunks=[];
    upRes.on("data",chunk=>chunks.push(chunk));
    upRes.on("end",()=>{
      let body=Buffer.concat(chunks);
      const contentType=String(upRes.headers["content-type"]||"");
      if(contentType.includes("application/json")){
        const text=body.toString("utf8")
          .replaceAll(`ws://127.0.0.1:${INTERNAL_CDP_PORT}`,`ws://sahbi-browser-engine-v2.railway.internal:${CDP_PORT}`)
          .replaceAll(`ws://localhost:${INTERNAL_CDP_PORT}`,`ws://sahbi-browser-engine-v2.railway.internal:${CDP_PORT}`);
        body=Buffer.from(text);
      }
      const responseHeaders={...upRes.headers,"content-length":String(body.length)};
      res.writeHead(upRes.statusCode||502,responseHeaders);
      res.end(body);
    });
  });
  upstream.on("error",error=>{
    res.statusCode=502;
    res.end(String(error?.message||error));
  });
  req.pipe(upstream);
});

proxy.on("upgrade",(req,clientSocket,head)=>{
  const headers={...req.headers,host:`localhost:${INTERNAL_CDP_PORT}`};
  const upstream=net.connect({host:"127.0.0.1",port:INTERNAL_CDP_PORT},()=>{
    let raw=`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for(const [key,value] of Object.entries(headers)){
      if(value===undefined) continue;
      if(Array.isArray(value)){
        for(const v of value) raw+=`${key}: ${v}\r\n`;
      }else{
        raw+=`${key}: ${value}\r\n`;
      }
    }
    raw+="\r\n";
    upstream.write(raw);
    if(head?.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.on("error",()=>clientSocket.destroy());
  clientSocket.on("error",()=>upstream.destroy());
});

proxy.listen(CDP_PORT,"0.0.0.0",()=>console.log(`CDP HTTP/WS proxy listening on 0.0.0.0:${CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT}`));

app.get("/",(_req,res)=>res.json({name:"Sahbi Browser Engine",version:"2.0.0",cdpPort:CDP_PORT,internalCdpPort:INTERNAL_CDP_PORT,running:!exited}));
app.get("/health",(_req,res)=>res.status(exited?503:200).json({ok:!exited,version:"2.0.0",cdpPort:CDP_PORT,internalCdpPort:INTERNAL_CDP_PORT}));

const server=app.listen(PORT,"0.0.0.0",()=>console.log(`Sahbi Browser Engine 2.0.0 health on ${PORT}, CDP on ${CDP_PORT}`));

function shutdown(){
  try{child.kill("SIGTERM")}catch{}
  try{proxy.close()}catch{}
  server.close(()=>process.exit(0));
}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
