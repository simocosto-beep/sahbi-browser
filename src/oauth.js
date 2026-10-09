import * as fs from "node:fs";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

export function setupOAuth(app, options={}) {
  const legacyToken=String(options.legacyToken||"");
  const legacyPluginKey=String(options.legacyPluginKey||"");
  const pin=String(process.env.SAHBI_OAUTH_PIN||"");
  const storePath=String(process.env.SAHBI_OAUTH_STORE_PATH || (process.env.RAILWAY_ENVIRONMENT ? "/data/oauth-state.json" : ".data/oauth-state.json"));
  const accessTtlMs=60*60*1000;
  const refreshTtlMs=30*24*60*60*1000;
  const codeTtlMs=10*60*1000;
  const scopes=["browser:control","offline_access"];

  function issuer(){
    return String(options.publicBaseUrl?.() || "https://sahbo-browser-production.up.railway.app").replace(/\/$/,"");
  }
  function resource(){ return issuer(); }
  function sha256(v){ return createHash("sha256").update(String(v)).digest("hex"); }
  function pkceS256(v){ return createHash("sha256").update(String(v)).digest("base64url"); }
  function safeEqual(a,b){
    const aa=Buffer.from(String(a||"")), bb=Buffer.from(String(b||""));
    return aa.length===bb.length && timingSafeEqual(aa,bb);
  }
  function html(v){
    return String(v??"").replace(/[&<>"']/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function emptyState(){ return {clients:{},codes:{},accessTokens:{},refreshTokens:{},auth:{}}; }
  function load(){
    try{
      const parsed=JSON.parse(fs.readFileSync(storePath,"utf8"));
      return {
        clients:parsed.clients||{},
        codes:parsed.codes||{},
        accessTokens:parsed.accessTokens||{},
        refreshTokens:parsed.refreshTokens||{},
        auth:parsed.auth||{}
      };
    }catch{
      return emptyState();
    }
  }
  let state=load();

  function verifyStoredPin(value){
    if(pin) return safeEqual(value,pin);
    const h=String(state.auth?.pinHash||"");
    return !!h && safeEqual(sha256("pin:"+String(value||"")),h);
  }
  function bootstrapReady(){
    return !pin && !state.auth?.pinHash && state.auth?.bootstrapHash && Date.now()<Number(state.auth.bootstrapExpiresAt||0);
  }
  function ensureBootstrap(){
    if(pin || state.auth?.pinHash) return;
    if(bootstrapReady()) return;
    const code=String(Math.floor(10000000+Math.random()*90000000));
    state.auth=state.auth||{};
    state.auth.bootstrapHash=sha256("bootstrap:"+code);
    state.auth.bootstrapExpiresAt=Date.now()+30*60*1000;
    save();
    const setupPath=storePath+'.bootstrap';
    fs.writeFileSync(setupPath,code,{mode:0o600});
    console.log("OAuth bootstrap created in private setup file; no credentials are logged.");
  }

  function save(){
    const cut=storePath.lastIndexOf("/");
    const dir=cut>=0 ? storePath.slice(0,cut) : ".";
    fs.mkdirSync(dir||".",{recursive:true});
    fs.writeFileSync(storePath,JSON.stringify(state,null,2),{mode:0o600});
  }
  function prune(doSave=true){
    const now=Date.now();
    for(const [k,v] of Object.entries(state.codes)) if(!v || now>v.expiresAt) delete state.codes[k];
    for(const [k,v] of Object.entries(state.accessTokens)) if(!v || now>v.expiresAt) delete state.accessTokens[k];
    for(const [k,v] of Object.entries(state.refreshTokens)) if(!v || now>v.expiresAt) delete state.refreshTokens[k];
    if(doSave) save();
  }
  prune(false);
  save();
  ensureBootstrap();

  function challenge(res,error="invalid_token",description="Authentication required"){
    res.setHeader(
      "WWW-Authenticate",
      'Bearer resource_metadata="'+issuer()+'/.well-known/oauth-protected-resource", scope="browser:control", error="'+error+'", error_description="'+String(description).replace(/"/g,"'")+'"'
    );
    return res.status(401).json({error:"unauthorized"});
  }
  function legacyOk(bearer){
    if(legacyToken && bearer===legacyToken) return true;
    if(legacyPluginKey && bearer){
      const derived=createHash("sha256").update("sahbi-plugin:"+bearer).digest("hex");
      return safeEqual(derived,legacyPluginKey);
    }
    return false;
  }
  function accessRecord(token){
    if(!token) return null;
    prune(false);
    const rec=state.accessTokens[sha256(token)];
    if(!rec || Date.now()>rec.expiresAt || rec.resource!==resource()) return null;
    const tokenScopes=String(rec.scope||"").split(/\s+/).filter(Boolean);
    if(!tokenScopes.includes("browser:control")) return null;
    return rec;
  }
  function authenticateRequest(req){
    const h=String(req?.headers?.authorization||"");
    const bearer=h.startsWith("Bearer ") ? h.slice(7) : "";
    if(legacyOk(bearer)) return {kind:"legacy",scope:"browser:control"};
    return accessRecord(bearer);
  }
  function oauthChallengeValue(error="invalid_token",description="Authentication required"){
    return 'Bearer resource_metadata="'+issuer()+'/.well-known/oauth-protected-resource", scope="browser:control", error="'+error+'", error_description="'+String(description).replace(/"/g,"'")+'"';
  }
  function mcpAuth(req,res,next){
    const rec=authenticateRequest(req);
    if(!rec) return challenge(res);
    req.oauth=rec;
    next();
  }
  function registeredRedirect(client,uri){
    return !!client && Array.isArray(client.redirect_uris) && client.redirect_uris.includes(String(uri||""));
  }
  function errorRedirect(res,redirectUri,stateValue,error,description){
    try{
      const u=new URL(redirectUri);
      u.searchParams.set("error",error);
      if(description) u.searchParams.set("error_description",description);
      if(stateValue) u.searchParams.set("state",stateValue);
      u.searchParams.set("iss",issuer());
      return res.redirect(302,u.toString());
    }catch{
      return res.status(400).json({error,error_description:description});
    }
  }
  function issueTokens(clientId,resId,scope){
    const accessToken=randomBytes(32).toString("base64url");
    const refreshToken=randomBytes(40).toString("base64url");
    const now=Date.now();
    state.accessTokens[sha256(accessToken)]={clientId,resource:resId,scope,issuedAt:now,expiresAt:now+accessTtlMs};
    state.refreshTokens[sha256(refreshToken)]={clientId,resource:resId,scope,issuedAt:now,expiresAt:now+refreshTtlMs};
    save();
    return {accessToken,refreshToken,expiresIn:Math.floor(accessTtlMs/1000)};
  }

  app.get("/.well-known/oauth-protected-resource",function(_req,res){
    res.json({
      resource:resource(),
      authorization_servers:[issuer()],
      scopes_supported:scopes,
      bearer_methods_supported:["header"],
      resource_documentation:issuer()+"/"
    });
  });

  app.get("/.well-known/oauth-authorization-server",function(_req,res){
    res.json({
      issuer:issuer(),
      authorization_endpoint:issuer()+"/authorize",
      token_endpoint:issuer()+"/token",
      registration_endpoint:issuer()+"/register",
      response_types_supported:["code"],
      grant_types_supported:["authorization_code","refresh_token"],
      code_challenge_methods_supported:["S256"],
      token_endpoint_auth_methods_supported:["none"],
      scopes_supported:scopes,
      authorization_response_iss_parameter_supported:true
    });
  });

  app.post("/register",function(req,res){
    const redirectUris=Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    const invalid=redirectUris.length===0 || redirectUris.some(function(uri){
      try{
        const u=new URL(uri);
        return u.protocol!=="https:" && !(u.protocol==="http:" && ["127.0.0.1","localhost","::1"].includes(u.hostname));
      }catch{
        return true;
      }
    });
    if(invalid) return res.status(400).json({error:"invalid_client_metadata",error_description:"Valid redirect_uris are required"});
    const clientId="sahbi_"+randomBytes(18).toString("base64url");
    const client={
      client_id:clientId,
      client_id_issued_at:Math.floor(Date.now()/1000),
      client_name:String(req.body?.client_name||"MCP client").slice(0,200),
      redirect_uris:redirectUris,
      grant_types:Array.isArray(req.body?.grant_types)&&req.body.grant_types.length?req.body.grant_types:["authorization_code","refresh_token"],
      response_types:Array.isArray(req.body?.response_types)&&req.body.response_types.length?req.body.response_types:["code"],
      token_endpoint_auth_method:"none"
    };
    state.clients[clientId]=client;
    save();
    return res.status(201).json(client);
  });

  app.get("/authorize",function(req,res){
    const q=req.query||{};
    const client=state.clients[String(q.client_id||"")];
    const redirectUri=String(q.redirect_uri||"");
    if(!client || !registeredRedirect(client,redirectUri)) return res.status(400).send("Invalid OAuth client or redirect URI.");
    if(String(q.response_type||"")!=="code") return errorRedirect(res,redirectUri,String(q.state||""),"unsupported_response_type","Only authorization code is supported");
    if(String(q.code_challenge_method||"")!=="S256" || !q.code_challenge) return errorRedirect(res,redirectUri,String(q.state||""),"invalid_request","PKCE S256 is required");
    if(String(q.resource||"")!==resource()) return errorRedirect(res,redirectUri,String(q.state||""),"invalid_target","Invalid resource");

    const scope=String(q.scope||"browser:control offline_access");
    const names=["client_id","redirect_uri","response_type","state","scope","code_challenge","code_challenge_method","resource"];
    const hidden=names.map(function(k){
      return '<input type="hidden" name="'+k+'" value="'+html(q[k]||"")+'">';
    }).join("");

    const needsSetup=!pin && !state.auth?.pinHash;
    if(needsSetup && !bootstrapReady()) ensureBootstrap();
    const authFields=needsSetup
      ? '<label>One-time setup code</label><input name="bootstrap_code" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus>'
        +'<label>Choose a permanent PIN</label><input name="new_pin" type="password" inputmode="numeric" minlength="6" maxlength="64" required>'
      : '<label>Private PIN</label><input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus>';
    const note=needsSetup
      ? 'First connection only: enter the one-time setup code, then choose your permanent PIN. Only a hash of that PIN is stored in the private browser volume.'
      : 'Your PIN is verified locally by Sahbi Browser and is never written into the plugin package.';
    const page='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Sahbi Browser</title>'
      +'<style>body{font-family:system-ui,sans-serif;background:#101114;color:#f5f5f5;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(92vw,460px);background:#191b20;border:1px solid #333;border-radius:18px;padding:26px;box-shadow:0 18px 60px #0008}input,button{width:100%;box-sizing:border-box;padding:13px;border-radius:10px;border:1px solid #444;font:inherit}input{background:#0f1013;color:#fff;margin:12px 0}button{background:#fff;color:#111;font-weight:700;cursor:pointer}.muted{color:#aaa;font-size:14px;line-height:1.4}.scope{background:#111318;padding:10px;border-radius:10px;font-size:13px}</style></head>'
      +'<body><form class="card" method="post" action="/authorize"><h2>Connect Sahbi Browser</h2><p class="muted">Authorize ChatGPT to control your private persistent Sahbi Browser session.</p>'
      +'<div class="scope">Permissions: '+html(scope)+'</div>'+hidden+authFields
      +'<button type="submit">Authorize</button><p class="muted">'+html(note)+'</p></form></body></html>';
    return res.type("html").send(page);
  });

  app.post("/authorize",function(req,res){
    const b=req.body||{};
    const client=state.clients[String(b.client_id||"")];
    const redirectUri=String(b.redirect_uri||"");
    if(!client || !registeredRedirect(client,redirectUri)) return res.status(400).send("Invalid OAuth client or redirect URI.");
    const stateValue=String(b.state||"");
    if(!pin && !state.auth?.pinHash){
      const newPin=String(b.new_pin||"");
      const bootstrapCode=String(b.bootstrap_code||"");
      const bootstrapOk=bootstrapReady() && safeEqual(sha256("bootstrap:"+bootstrapCode),String(state.auth.bootstrapHash||""));
      if(!bootstrapOk) return errorRedirect(res,redirectUri,stateValue,"access_denied","Invalid or expired one-time setup code");
      if(newPin.length<6 || newPin.length>64) return errorRedirect(res,redirectUri,stateValue,"invalid_request","Choose a PIN between 6 and 64 characters");
      state.auth.pinHash=sha256("pin:"+newPin);
      delete state.auth.bootstrapHash;
      delete state.auth.bootstrapExpiresAt;
      save();
    }else if(!verifyStoredPin(String(b.pin||""))){
      return errorRedirect(res,redirectUri,stateValue,"access_denied","Invalid PIN");
    }
    if(String(b.response_type||"")!=="code" || String(b.code_challenge_method||"")!=="S256" || !b.code_challenge) return errorRedirect(res,redirectUri,stateValue,"invalid_request","Invalid authorization request");
    const resId=String(b.resource||"");
    if(resId!==resource()) return errorRedirect(res,redirectUri,stateValue,"invalid_target","Invalid resource");

    const requested=String(b.scope||"browser:control offline_access").split(/\s+/).filter(Boolean);
    const granted=requested.filter(function(x){return scopes.includes(x);});
    if(!granted.includes("browser:control")) return errorRedirect(res,redirectUri,stateValue,"invalid_scope","browser:control is required");
    const scope=granted.join(" ");
    const code=randomBytes(28).toString("base64url");
    state.codes[sha256(code)]={
      clientId:client.client_id,
      redirectUri,
      codeChallenge:String(b.code_challenge),
      resource:resId,
      scope,
      issuedAt:Date.now(),
      expiresAt:Date.now()+codeTtlMs
    };
    save();
    const u=new URL(redirectUri);
    u.searchParams.set("code",code);
    if(stateValue) u.searchParams.set("state",stateValue);
    u.searchParams.set("iss",issuer());
    return res.redirect(302,u.toString());
  });

  app.post("/token",function(req,res){
    prune(false);
    const b=req.body||{};
    const grantType=String(b.grant_type||"");
    const clientId=String(b.client_id||"");
    const client=state.clients[clientId];
    if(!client) return res.status(401).json({error:"invalid_client"});

    if(grantType==="authorization_code"){
      const codeKey=sha256(String(b.code||""));
      const rec=state.codes[codeKey];
      if(!rec || rec.clientId!==clientId || Date.now()>rec.expiresAt){
        delete state.codes[codeKey];
        save();
        return res.status(400).json({error:"invalid_grant"});
      }
      if(String(b.redirect_uri||"")!==rec.redirectUri) return res.status(400).json({error:"invalid_grant",error_description:"redirect_uri mismatch"});
      if(String(b.resource||"")!==rec.resource || rec.resource!==resource()) return res.status(400).json({error:"invalid_target"});
      if(!b.code_verifier || pkceS256(String(b.code_verifier))!==rec.codeChallenge) return res.status(400).json({error:"invalid_grant",error_description:"PKCE verification failed"});
      delete state.codes[codeKey];
      const t=issueTokens(clientId,rec.resource,rec.scope);
      return res.json({access_token:t.accessToken,token_type:"Bearer",expires_in:t.expiresIn,refresh_token:t.refreshToken,scope:rec.scope});
    }

    if(grantType==="refresh_token"){
      const oldKey=sha256(String(b.refresh_token||""));
      const rec=state.refreshTokens[oldKey];
      if(!rec || rec.clientId!==clientId || Date.now()>rec.expiresAt){
        delete state.refreshTokens[oldKey];
        save();
        return res.status(400).json({error:"invalid_grant"});
      }
      if(String(b.resource||"")!==rec.resource || rec.resource!==resource()) return res.status(400).json({error:"invalid_target"});
      delete state.refreshTokens[oldKey];
      const t=issueTokens(clientId,rec.resource,rec.scope);
      return res.json({access_token:t.accessToken,token_type:"Bearer",expires_in:t.expiresIn,refresh_token:t.refreshToken,scope:rec.scope});
    }

    return res.status(400).json({error:"unsupported_grant_type"});
  });

  return {mcpAuth,authenticateRequest,oauthChallengeValue};
}
