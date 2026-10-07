import express from "express";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
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

const proxy=net.createServer(client=>{
  const upstream=net.connect({host:"127.0.0.1",port:INTERNAL_CDP_PORT});
  client.pipe(upstream);
  upstream.pipe(client);
  upstream.on("error",()=>client.destroy());
  client.on("error",()=>upstream.destroy());
});
proxy.listen(CDP_PORT,"0.0.0.0",()=>console.log(`CDP proxy listening on 0.0.0.0:${CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT}`));

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
