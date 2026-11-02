// Real image + browser + signed mock IdP + MCP SDK. No production services or credentials.
// E2E_CHROME=/path/to/chrome node scripts/test-subpath.mjs artifact-site:ci
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import puppeteer from 'puppeteer-core';
import { zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const exec = promisify(execFile);
const docker = async (...args) => { const result=await exec('docker', args, {maxBuffer:4*1024*1024}); return (result.stdout+(args[0]==='logs'?result.stderr:'')).trim(); };
const suffix=String(process.pid), network=`migration-${suffix}`, pg=`migration-pg-${suffix}`, app=`migration-app-${suffix}`, volume=`migration-data-${suffix}`;
const image=process.argv[2] || 'artifact-site:ci';
const chrome=process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const keys=await generateKeyPair('RS256'), jwk=await exportJWK(keys.publicKey);
jwk.kid='acceptance';jwk.alg='RS256';
const codes=new Map();
let issuer, browser, A, B, port, appPort;
let oldEntryEnabled = true;
const discoveryRequests = new Set();
const clients=[];
const idp=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,issuer);
  res.setHeader('content-type','application/json');
  if(url.pathname.endsWith('/.well-known/openid-configuration'))return res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/auth',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks'}));
  if(url.pathname.endsWith('/jwks'))return res.end(JSON.stringify({keys:[jwk]}));
  if(url.pathname.endsWith('/auth')){
   const dest=new URL(url.searchParams.get('redirect_uri'));dest.searchParams.set('state',url.searchParams.get('state'));
   const accountCookie=(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('mock_idp_session='))?.split('=')[1];
   const signedIn=Boolean(accountCookie);
   if(url.searchParams.get('prompt')==='login'&&!url.searchParams.has('mock_account')){
    res.setHeader('content-type','text/html');
    const option=(account,label)=>{const target=new URL(url);target.searchParams.set('mock_account',account);return `<a id="account-${account}" href="${target.href.replaceAll('&','&amp;')}">${label}</a>`;};
    return res.end(`<h1>Choose a test account</h1>${option('1','Account A')}${option('2','Account B')}${option('cancel','Cancel')}`);
   }
   if(url.searchParams.get('mock_account')==='cancel'){
    dest.searchParams.set('error','access_denied');res.writeHead(302,{location:dest.href});return res.end();
   }
   const account=url.searchParams.get('mock_account')||accountCookie||'1';
   url.searchParams.set('mock_account',account);
   if(url.searchParams.get('prompt')==='none'&&!signedIn){
    dest.searchParams.set('error','login_required');res.writeHead(302,{location:dest.href});return res.end();
   }
   // Interactive authorization establishes the IdP session; silent attempts only reuse it.
   if(url.searchParams.get('prompt')!=='none')res.setHeader('set-cookie',`mock_idp_session=${account}; Path=/; HttpOnly; SameSite=Lax`);
   const code=randomBytes(16).toString('hex');codes.set(code,url.searchParams);
   dest.searchParams.set('code',code);
   res.writeHead(302,{location:dest.href});return res.end();
  }
  if(url.pathname.endsWith('/token')){
   let body='';for await(const chunk of req)body+=chunk;
   const form=new URLSearchParams(body), flow=codes.get(form.get('code'));codes.delete(form.get('code'));
   assert(flow);assert.equal(form.get('redirect_uri'),flow.get('redirect_uri'));
   assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),flow.get('code_challenge'));
   const token=await new SignJWT({sub:flow.get('mock_account')==='2'?'switch-person':'migration-person',email:flow.get('mock_account')==='2'?'switch@example.test':'migration@example.test',email_verified:true,name:flow.get('mock_account')==='2'?'Switch Test':'Migration Test',nonce:flow.get('nonce')})
     .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience('migration').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
   return res.end(JSON.stringify({id_token:token}));
  }
  res.writeHead(404);res.end();
 }catch(error){console.error('[mock-idp]',error);res.writeHead(400);res.end(JSON.stringify({error:'invalid_grant'}));}
});
await new Promise(resolve=>idp.listen(0,'0.0.0.0',resolve));
issuer=`http://idp.test:${idp.address().port}/oidc`;
async function localFetch(input,init){
 const request=new Request(input,init), url=new URL(request.url), headers=new Headers(request.headers);
 assert(['a.test','b.test'].includes(url.hostname),`Unexpected external request: ${url}`);
 headers.set('host',url.host);
 const body=request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
 // Native fetch intentionally rewrites Host on newer Node versions. Use HTTP to simulate
 // the gateway while preserving the exact external authority the SDK is connected to.
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:url.port,path:url.pathname+url.search,method:request.method,headers:Object.fromEntries(headers)},res=>{
   const responseHeaders=new Headers();for(const [key,value]of Object.entries(res.headers))if(value!==undefined)responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);
   resolve(new Response([204,304].includes(res.statusCode)?null:Readable.toWeb(res),{status:res.statusCode,headers:responseHeaders}));
  });
  req.on('error',reject);request.signal.addEventListener('abort',()=>req.destroy(),{once:true});req.end(body);
 });
}

// Test-only gateway: production routing belongs to the deployment platform, not the image.
const discoveryRoutes = new Map([
 ['/.well-known/oauth-authorization-server/artifact-site', '/artifact-site/.well-known/oauth-authorization-server'],
 ['/.well-known/openid-configuration/artifact-site', '/artifact-site/.well-known/openid-configuration'],
 ['/.well-known/oauth-protected-resource/artifact-site', '/artifact-site/.well-known/oauth-protected-resource'],
 ['/.well-known/oauth-protected-resource/artifact-site/mcp', '/artifact-site/.well-known/oauth-protected-resource/mcp'],
]);
const gateway = http.createServer((req,res) => {
 const url = new URL(req.url, `http://${req.headers.host}`);
 if (url.hostname === 'a.test') {
  if (!oldEntryEnabled) { res.writeHead(404); return res.end(); }
  if (!['GET','HEAD'].includes(req.method) || /^\/(api|mcp|oauth|\.well-known)(\/|$)/.test(url.pathname)) { res.writeHead(410); return res.end(); }
  res.writeHead(302, {location:B+url.pathname+url.search}); return res.end();
 }
 if (url.hostname !== 'b.test') { res.writeHead(404); return res.end(); }
 if (url.pathname === '/') { res.writeHead(302, {location:B+'/'+url.search}); return res.end(); }
 const rewritten = discoveryRoutes.get(url.pathname);
 if (rewritten) discoveryRequests.add(url.pathname);
 if (!rewritten && url.pathname !== '/artifact-site' && !url.pathname.startsWith('/artifact-site/')) { res.writeHead(404); return res.end(); }
 const upstream = http.request({hostname:'127.0.0.1',port:appPort,path:(rewritten||url.pathname)+url.search,method:req.method,
  headers:{...req.headers,'x-forwarded-proto':'http','x-forwarded-for':req.socket.remoteAddress}}, response => {
   res.writeHead(response.statusCode,response.headers); response.pipe(res);
  });
 upstream.on('error',()=>{res.writeHead(502);res.end();}); req.pipe(upstream);
});

async function start(){
 await docker('run','-d','--name',app,'--network',network,'--add-host','idp.test:host-gateway','-p','127.0.0.1::4300','-v',`${volume}:/data`,
  '-e',`ARTIFACT_PUBLIC_URL=${B}`,
  '-e',`ARTIFACT_DATABASE_URL=postgres://test:test@${pg}:5432/test?sslmode=disable`,
  '-e',`ARTIFACT_OIDC_ISSUER=${issuer}`,'-e','ARTIFACT_OIDC_CLIENT_ID=migration','-e','ARTIFACT_OIDC_CLIENT_SECRET=test',
  '-e','ARTIFACT_CREATE_POLICY=login','-e','ARTIFACT_DEFAULT_VISIBILITY=private','-e','ARTIFACT_RATE_LIMIT=off',image);
 appPort=Number((await docker('port',app,'4300/tcp')).split(':').at(-1));
 for(let i=0;i<90;i++){
  if(await fetch(`http://127.0.0.1:${appPort}/artifact-site/api/auth/me`).then(r=>r.ok).catch(()=>false))return;
  await sleep(1000);
 }
 throw new Error('Container did not become healthy');
}
async function api(page,base,route,body,method=body===undefined?'GET':'POST',headers={}){
 const result=await page.evaluate(async(url,body,method,headers)=>{
  const res=await fetch(url,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:await res.json()};
 },base+route,body,method,headers);
 assert(result.status<400,JSON.stringify(result));return result.body;
}
class Provider {
 constructor(){this.redirectUrl='http://127.0.0.1:5555/callback';this.stateValue=randomBytes(16).toString('hex');}
 get clientMetadata(){return {client_name:'Migration acceptance',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};}
 state(){return this.stateValue;}clientInformation(){return this.info;}saveClientInformation(info){this.info=info;}
 tokens(){return this.saved;}saveTokens(tokens){this.saved=tokens;}
 redirectToAuthorization(url){this.authorizationUrl=url;}saveCodeVerifier(value){this.verifier=value;}codeVerifier(){return this.verifier;}
}
async function connect(base,page){
 const provider=new Provider(), first=new Client({name:'migration',version:'1'});
 await assert.rejects(first.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:provider,fetch:localFetch})));
 assert(provider.authorizationUrl);assert.equal(provider.authorizationUrl.origin+provider.authorizationUrl.pathname,base+'/oauth/authorize');
 await page.setRequestInterception(true);
 const intercept=req=>{
  if(req.url().startsWith(provider.redirectUrl))return req.respond({status:200,contentType:'text/html',body:'Authorized'});
  return req.continue();
 };
 page.on('request',intercept);
 await page.goto(provider.authorizationUrl.href,{waitUntil:'domcontentloaded'});
 await page.waitForSelector('button[name="decision"][value="allow"]');
 // Use the native form button, independent of the post-login overlay's animation.
 console.log(`Submitting OAuth consent: ${base}`);
 // Next may perform an intermediate navigation before the external callback is requested.
 const [callbackRequest]=await Promise.all([
  page.waitForRequest(req=>req.url().startsWith(provider.redirectUrl),{timeout:30000}),
  page.waitForNavigation({waitUntil:'domcontentloaded'}),
  page.$eval('button[name="decision"][value="allow"]',button=>button.click()),
 ]);
 const callback=new URL(callbackRequest.url());
 assert.equal(callback.searchParams.get('iss'),base);assert.equal(callback.searchParams.get('state'),provider.stateValue);
 page.off('request',intercept);await page.setRequestInterception(false);
 await new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:provider,fetch:localFetch}).finishAuth(callback.searchParams.get('code'));
 const client=new Client({name:'migration',version:'1'});clients.push(client);
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:provider,fetch:localFetch}));
 const result=await client.callTool({name:'artifact_site_connection',arguments:{}});
 assert.equal(JSON.parse(result.content[0].text).baseUrl,base);
 return provider;
}
function pdf(){
 const stream='BT /F1 24 Tf 60 700 Td (Migration PDF) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let out='%PDF-1.4\n';const offsets=[];for(const [i,obj]of objects.entries()){offsets.push(out.length);out+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=out.length;out+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return out;
}
try {
 console.log('Starting disposable Postgres, image and signed IdP');
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));port=gateway.address().port;
 A=`http://a.test:${port}`;B=`http://b.test:${port}/artifact-site`;
 await mkdir('test-results',{recursive:true});
 await docker('network','create',network);await docker('volume','create',volume);
 await docker('run','-d','--name',pg,'--network',network,'--tmpfs','/var/lib/postgresql','-e','POSTGRES_USER=test','-e','POSTGRES_PASSWORD=test','-e','POSTGRES_DB=test','postgres:18-alpine');
 for(let i=0;i<45;i++){try{await docker('exec',pg,'pg_isready','-U','test','-d','test');break;}catch{await sleep(1000);}}
 await start();
 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1, MAP idp.test 127.0.0.1']});
 const page=await browser.newPage();page.setDefaultTimeout(20000);
 const escaped=[],pageErrors=[];
 page.on('request',req=>{const u=new URL(req.url());if(u.hostname==='b.test'&&!u.pathname.startsWith('/artifact-site')&&!u.pathname.startsWith('/.well-known/')){ escaped.push(u.href); console.error('Escaped mount request', {url:u.href, document:req.frame()?.url(), type:req.resourceType(), initiator:req.initiator()}); }});
 page.on('pageerror',error=>pageErrors.push(error.message));
 console.log('Checking gateway redirects and exact discovery rewrites');
 const root = await localFetch(`http://b.test:${port}/?from=root`);
 assert.equal(root.status,302);assert.equal(root.headers.get('location'),B+'/?from=root');
 const old = await localFetch(A+'/s/example?version=42');
 assert.equal(old.status,302);assert.equal(old.headers.get('location'),B+'/s/example?version=42');
 for (const path of ['/mcp','/api/sites','/oauth/token','/api/auth/callback?code=old']) assert.equal((await localFetch(A+path)).status,410);
 assert.equal((await localFetch(`http://b.test:${port}/unrelated`)).status,404);
 for (const [path] of discoveryRoutes) {
  const response=await localFetch(`http://b.test:${port}`+path);assert.equal(response.status,200);
  const metadata=await response.json();assert.equal(metadata.issuer||metadata.resource,metadata.issuer?B:B+'/mcp');
 }
 await page.goto(`http://b.test:${port}/`,{waitUntil:'domcontentloaded'});
 assert.equal(page.url().replace(/\/$/,''),B);
 await page.goto(A+'/',{waitUntil:'domcontentloaded'});
 assert.equal(page.url().replace(/\/$/,''),B);
 escaped.length=0;
 // Chrome can request /favicon.ico when streamed metadata arrives after the shell.
 const shell = await localFetch(B, {headers:{'user-agent':await browser.userAgent()}});
 const initialHead = (await shell.text()).split('</head>')[0];
 assert.match(initialHead, /<link(?=[^>]*rel="icon")(?=[^>]*href="\/artifact-site\/icon\.png")[^>]*>/, 'Initial head must contain the explicit mounted favicon independently of generated metadata');
 console.log('Checking first-time MCP authorization with a fresh browser context');
 for(const base of [B]){
  console.log(`First-time OAuth: ${base}`);
  const context=await browser.createBrowserContext(), fresh=await context.newPage();
  const requests=[];fresh.on('request',req=>requests.push(req.url()));
  await fresh.goto(base+'/',{waitUntil:'networkidle0'});
  assert.equal((await api(fresh,base,'/api/auth/me')).user,null);
  try { await connect(base,fresh); } catch(error) {
   console.error('First-time OAuth failed',base,fresh.url(),await fresh.$eval('body',el=>el.innerText),requests);throw error;
  }
  assert(requests.some(url=>url.startsWith(base+'/api/auth/login?')),'OAuth must pass through login');
  assert(!requests.some(url=>url.includes('/artifact-site/artifact-site/')),'Doubled base path');
  await fresh.goto(base+'/me',{waitUntil:'domcontentloaded'});
  assert((await api(fresh,base,'/api/auth/me')).user);
  await context.close();
 }
 console.log('Checking account switch, cancellation, cross-tab identity and local sign-out');
 {
  const context=await browser.createBrowserContext(), tab=await context.newPage();
  await tab.goto(B+'/api/auth/login?return_to=%2Fme',{waitUntil:'networkidle0'});
  await tab.evaluate(()=>{document.cookie='ah_locale=en; Path=/';});
  await tab.reload({waitUntil:'networkidle0'});
  const accountA=(await api(tab,B,'/api/auth/me')).user;
  const oldCookies=(await context.cookies()).filter(c=>c.name==='ah_session').map(c=>`${c.name}=${c.value}`).join('; ');
  const seedPrivate=async(page,title)=>{
   const created=await api(page,B,'/api/sites',{mode:'paste',html:`<h1>${title}</h1>`,title},'POST',{'idempotency-key':randomBytes(16).toString('hex')});
   await api(page,B,`/api/sites/${created.slug}/sharing`,{visibility:'private'},'PUT');
  };
  await seedPrivate(tab,'Private account A artifact');
  const bContext=await browser.createBrowserContext(), bTab=await bContext.newPage();
  await bTab.goto(B+'/api/auth/login?switch_account=1&return_to=%2Fme',{waitUntil:'networkidle0'});
  await Promise.all([bTab.waitForNavigation({waitUntil:'networkidle0'}),bTab.click('#account-2')]);
  await seedPrivate(bTab,'Private account B artifact one');
  await seedPrivate(bTab,'Private account B artifact two');
  await bContext.close();
  const peer=await context.newPage();await peer.goto(B+'/me',{waitUntil:'networkidle0'});
  await peer.waitForFunction(()=>document.body.innerText.includes('Private account A artifact'));
  assert((await peer.$eval('#me-tab-owned',el=>el.textContent)).includes('1'));
  await peer.evaluate(()=>{
   window.staleAccountDataShown=false;
   new MutationObserver(()=>{
    if(document.querySelector('.auth-chip > button')?.getAttribute('title')==='switch@example.test' && document.body.innerText.includes('Private account A artifact'))window.staleAccountDataShown=true;
   }).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  });
  const startSwitch=async(failLogout=false)=>{
   await tab.bringToFront();
   console.log('Opening switch menu');
   await tab.waitForSelector('.auth-chip > button[title]');
   await tab.waitForSelector('.welcome-burst',{hidden:true});
   await tab.click('.auth-chip > button[title]');
   await tab.waitForFunction(()=>getComputedStyle(document.querySelector('.auth-menu')).opacity==='1');
   const link=await tab.waitForSelector('::-p-text(Switch account)');
   if(failLogout){
    const intercept=request=>request.url().endsWith('/api/auth/logout')
     ? request.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'unavailable'})})
     : request.continue();
    await tab.setRequestInterception(true);tab.on('request',intercept);
    await link.click();await tab.waitForSelector('.auth-menu [role="alert"]');
    await tab.setRequestInterception(false);tab.off('request',intercept);
    assert.equal(new URL(tab.url()).pathname,'/artifact-site/me','Failed logout must not start authorization');
    assert.equal((await api(tab,B,'/api/auth/me')).user.id,accountA.id);
    await tab.click('.auth-chip > button[title]');
    return;
   }
   await Promise.all([tab.waitForFunction(()=>location.hostname==='idp.test' && new URL(location.href).searchParams.get('prompt')==='login'),link.click()]);
   await tab.waitForSelector('#account-cancel');
   assert.equal(new URL(tab.url()).searchParams.get('prompt'),'login',`${tab.url()} ${await tab.$eval('body',el=>el.innerText)}`);
  };
  await startSwitch(true);
  await startSwitch();
  assert.equal((await (await localFetch(B+'/api/auth/me',{headers:{cookie:oldCookies}})).json()).user,null,'Old session must be revoked before IdP interaction');
  // HTTP fixture origins have no crypto.randomUUID; exercise the focus sync fallback.
  await peer.bringToFront();
  await peer.waitForSelector('a[aria-label="Sign in / Sign up"]');
  await tab.bringToFront();
  console.log('Cancelling switch');
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.click('#account-cancel')]);
  assert(await tab.$('a[href*="switch_account=1"]'),'Failed switch must retry in switch mode');
  await tab.goto(B+'/me',{waitUntil:'networkidle0'});
  assert.equal((await api(tab,B,'/api/auth/me')).user,null,'Cancelled switch must stay anonymous');
  assert.equal((await (await localFetch(B+'/api/auth/me',{headers:{cookie:oldCookies}})).json()).user,null,'Switch must revoke old credentials before authentication');
  await tab.reload({waitUntil:'networkidle0'});
  assert.equal((await api(tab,B,'/api/auth/me')).user,null,'Cancelled switch must suppress automatic SSO');
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.click('a[aria-label="Sign in / Sign up"]')]);
  assert.equal(new URL(tab.url()).searchParams.get('prompt'),'login');
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.click('#account-2')]);
  console.log('Switched to account B');
  const accountB=(await api(tab,B,'/api/auth/me')).user;
  assert.notEqual(accountB.id,accountA.id);
  await peer.waitForFunction(()=>document.querySelector('.auth-chip > button')?.getAttribute('title')==='switch@example.test');
  await peer.waitForFunction(()=>document.body.innerText.includes('Private account B artifact one') && document.body.innerText.includes('Private account B artifact two') && !document.body.innerText.includes('Private account A artifact'));
  assert((await peer.$eval('#me-tab-owned',el=>el.textContent)).includes('2'),'Peer count must belong to B');
  assert.equal(await peer.evaluate(()=>window.staleAccountDataShown),false,'A data must never render under B identity');
  assert.equal((await (await localFetch(B+'/api/auth/me',{headers:{cookie:oldCookies}})).json()).user,null,'Old session must be revoked');
  await tab.waitForSelector('.welcome-burst',{hidden:true});
  await tab.click('.auth-chip > button');
  await tab.waitForFunction(()=>getComputedStyle(document.querySelector('.auth-menu')).opacity==='1');
  await tab.screenshot({path:'test-results/account-switch-menu.png'});
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.evaluate(()=>[...document.querySelectorAll('button[role="menuitem"]')].find(b=>b.textContent.includes('Sign out')).click())]);
  await tab.waitForSelector('a[aria-label="Sign in / Sign up"]');
  assert.equal(await tab.$('[aria-label="More sign-in options"]'),null,'Guests have one sign-in entry');
  assert.equal((await api(tab,B,'/api/auth/me')).user,null);
  await tab.reload({waitUntil:'networkidle0'});
  assert.equal((await api(tab,B,'/api/auth/me')).user,null,'Reload after sign-out must stay anonymous');
  await tab.setViewport({width:390,height:844});
  assert(await tab.$eval('.brand img',el=>el.getBoundingClientRect().width>=90),'Mobile brand must remain readable');
  await tab.screenshot({path:'test-results/account-switch-guest-mobile.png'});
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.click('a[aria-label="Sign in / Sign up"]')]);
  assert.equal(new URL(tab.url()).searchParams.get('prompt'),'login');
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.click('#account-1')]);
  assert.equal((await api(tab,B,'/api/auth/me')).user.id,accountA.id);
  await startSwitch();
  await Promise.all([tab.waitForNavigation({waitUntil:'networkidle0'}),tab.click('#account-2')]);
  assert.equal((await api(tab,B,'/api/auth/me')).user.id,accountB.id,'Direct account switch succeeds');
  assert(!(await context.cookies()).some(c=>c.name==='artifact_sso_opt_out'),'Successful sign-in clears suppression');
  await context.close();
 }
 let site,user;
 for(const base of [B]){
  console.log(`Checking browser login, shared data, preview, editing and downloads: ${base}`);
  await page.goto(base+'/api/auth/login?return_to=%2Fme',{waitUntil:'domcontentloaded'});
  assert.equal(new URL(page.url()).pathname,new URL(base).pathname.replace(/\/$/,'')+'/me');
  const me=await api(page,base,'/api/auth/me');assert(me.user);if(user)assert.equal(me.user.id,user);else user=me.user.id;
  console.log('Checking automatic sign-in with an existing IdP session');
  const cookies=await page.browserContext().cookies();
  await page.browserContext().deleteCookie(...cookies.filter(cookie=>cookie.name==='ah_session'||cookie.name==='artifact_sso_retry'));
  await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('artifact-site:sso-attempt:')).forEach(key=>sessionStorage.removeItem(key)));
  const automatic=page.waitForRequest(request=>request.url().startsWith(issuer+'/auth?')&&new URL(request.url()).searchParams.get('prompt')==='none');
  await page.goto(base+'/me?tab=recent#sso-return',{waitUntil:'networkidle0'});
  await automatic;
  assert.equal((await api(page,base,'/api/auth/me')).user.id,user);
  assert.equal(page.url(),base+'/me?tab=recent#sso-return');
  const createBody={mode:'paste',html:'<!doctype html><html><head><title>Migration</title></head><body><h1>Migration content</h1></body></html>',title:'Migration'};
  const createKey=randomBytes(16).toString('hex'), createHeaders={'idempotency-key':createKey};
  site=await api(page,base,'/api/sites',createBody,'POST',createHeaders);
  assert.equal(site.url,new URL(base).pathname+'/s/'+site.slug);
  assert.equal((await api(page,base,'/api/sites',createBody,'POST',createHeaders)).url,site.url);
  assert.equal((await api(page,base,'/api/operations/'+createKey)).result.url,site.url);
  await page.goto(A+`/s/${site.slug}?from=old`,{waitUntil:'domcontentloaded'});
  assert.equal(page.url(),base+`/s/${site.slug}?from=old`);
  const frame=await (await page.waitForSelector('iframe')).contentFrame();assert(frame,'Missing sandbox preview');
  await frame.waitForFunction(()=>document.body.textContent.includes('Migration content'));
  assert(await page.$eval('iframe',el=>el.hasAttribute('sandbox')&&!el.getAttribute('sandbox').includes('allow-same-origin')));
  await page.goto(base+`/s/${site.slug}/comments?thread=migration-thread`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(expected=>location.href===expected,{},base+`/s/${site.slug}?comments=all&thread=migration-thread`);
  assert.equal(page.url(),base+`/s/${site.slug}?comments=all&thread=migration-thread`);
  const info=await api(page,base,`/api/sites/${site.slug}`);
  const editKey=randomBytes(16).toString('hex'), editHeaders={'idempotency-key':editKey};
  const editRoute=`/api/sites/${site.slug}/edit?expected_version=${info.version.id}`;
  const editBody={content:'<!doctype html><html><body><h1>Migration content updated</h1></body></html>'};
  const edited=await api(page,base,editRoute,editBody,'POST',editHeaders);assert(edited.versionId);
  assert.equal(edited.url,site.url);
  assert.equal((await api(page,base,editRoute,editBody,'POST',editHeaders)).url,edited.url);
  assert.equal((await api(page,base,'/api/operations/'+editKey)).result.url,edited.url);
  const downloaded=await page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,size:(await r.arrayBuffer()).byteLength};},base+`/api/sites/${site.slug}/export`);
  assert.equal(downloaded.status,200);assert(downloaded.size>0);
  console.log('Checking mounted return-to-platform links inside the sandbox');
  for (const destination of ['/', '/me', '/explore']) {
   await page.goto(base+`/s/${site.slug}`,{waitUntil:'domcontentloaded'});
   const preview=await (await page.waitForSelector('iframe')).contentFrame();assert(preview);
   await preview.waitForFunction(()=>document.body.textContent.includes('Migration content'));
   const href=destination==='/me'?new URL(base).pathname+destination:base+destination;
   await preview.evaluate(href=>{const a=document.createElement('a');a.id='platform-return';a.href=href;a.textContent='Return to platform';document.body.prepend(a);},href);
   await preview.click('#platform-return');
   await page.waitForSelector('dialog.action-confirmation[open]');
   assert.equal(page.url(),base+`/s/${site.slug}`,'Navigation requires host confirmation');
   await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.click('dialog.action-confirmation button[type="submit"]')]);
   assert.equal(page.url().replace(/\/$/,''),(base+destination).replace(/\/$/,''));
   assert.equal((await api(page,base,'/api/auth/me')).user.id,user);
  }
  const share=await api(page,base,`/api/sites/${site.slug}/shares`,{policy:'passcode',passcode:'migration-test'});assert(share.url.startsWith(B+'/v/'));
  console.log(`Checking recent-history copy links: ${base}`);
  await page.waitForFunction(slug=>JSON.parse(localStorage.getItem('sites:recent:v1')||'{"items":[]}').items.some(item=>item.slug===slug),{},site.slug);
  const recent=await page.evaluate(slug=>JSON.parse(localStorage.getItem('sites:recent:v1')).items.find(item=>item.slug===slug),site.slug);
  for(const binding of [{},{versionId:info.version.id},{shareToken:share.token},{shareToken:share.token,versionId:info.version.id}]){
   await page.evaluate(entry=>localStorage.setItem('sites:recent:v1',JSON.stringify({v:1,items:[entry]})),{...recent,...binding});
   await page.goto(base+'/me?tab=recent',{waitUntil:'networkidle0'});
   await page.waitForSelector('.site-row .row-more');
   await page.evaluate(()=>{window.__copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});});
   await page.click('.site-row .row-more');
   const copy=await page.waitForSelector('[role="menu"]:not([hidden]) button[role="menuitem"]',{visible:true});
   await copy.click();
   const path=binding.shareToken?'/v/'+binding.shareToken:'/s/'+site.slug;
   const expected=base+path+(binding.versionId?'?version='+binding.versionId:'');
   await page.waitForFunction(()=>window.__copied!==null);
   assert.equal(await page.evaluate(()=>window.__copied),expected);
   assert.equal(await page.$eval('.site-row strong a',el=>el.href),expected);
  }
  const guest=await browser.createBrowserContext(), guestPage=await guest.newPage();
  const localShare=base+'/v/'+share.token;
  console.log('Checking anonymous share after silent login fallback');
  const silentReturn=guestPage.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/callback') && new URL(response.url()).searchParams.get('state')?.startsWith('silent.'))
   .then(()=>guestPage.waitForNavigation({waitUntil:'networkidle0'}));
  await guestPage.goto(localShare,{waitUntil:'networkidle0'});
  await silentReturn;
  assert.equal((await api(guestPage,base,'/api/auth/me')).user,null);
  await guestPage.type('input[name="passcode"]','migration-test');
  await Promise.all([guestPage.waitForNavigation({waitUntil:'domcontentloaded'}),guestPage.click('button[type="submit"]')]);
  assert(guestPage.url().startsWith(localShare));await guestPage.waitForSelector('iframe');await guest.close();
 }
 console.log('Checking asynchronous archive processing in the final subpath image');
 const archive=zipSync({
  'reports/index.html':Buffer.from('<!doctype html><h1 id="archive-report">Subpath archive report</h1>'),
  'notes.txt':Buffer.from('Retained package notes'),
 });
 const {versionId:archiveVersion}=await api(page,B,'/api/uploads',{title:'Subpath archive',package:{source:'archive',name:'subpath.zip'}});
 const uploaded=await page.evaluate(async(url,bytes)=>{
  const response=await fetch(url,{method:'PUT',body:new Uint8Array(bytes)});
  return {status:response.status,body:await response.text()};
 },`${B}/api/uploads/${archiveVersion}/files/original`,Array.from(archive));
 assert.equal(uploaded.status,200,uploaded.body);
 const queued=await page.evaluate(async (url,key)=>{
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:'{}'});
  return {status:response.status,body:await response.json()};
 },`${B}/api/uploads/${archiveVersion}/commit?async=1`,randomBytes(16).toString('hex'));
 assert.equal(queued.status,202,JSON.stringify(queued));
 let archiveJob;
 for(let attempt=0;attempt<90;attempt++){
  archiveJob=await api(page,B,`/api/uploads/${archiveVersion}`);
  if(['completed','failed'].includes(archiveJob.status))break;
  await sleep(1000);
 }
 assert.equal(archiveJob.status,'completed',JSON.stringify(archiveJob));
 assert.equal(archiveJob.result.versionId,archiveVersion);
 const archiveSlug=archiveJob.result.slug;
 await page.goto(`${B}/s/${archiveSlug}`,{waitUntil:'domcontentloaded'});
 await page.waitForSelector('iframe.fs-frame');
 const archiveFrame=await (await page.$('iframe.fs-frame')).contentFrame();
 await archiveFrame.waitForSelector('a[href="reports/index.html"]');
 assert((await archiveFrame.$eval('body',el=>el.textContent)).includes('notes.txt'));
 assert.equal(await archiveFrame.$$eval("details[open]", nodes => nodes.length), 0);
 await archiveFrame.click('[data-expand="true"]');
 await Promise.all([archiveFrame.waitForNavigation({waitUntil:'load'}),archiveFrame.click('a[href="reports/index.html"]')]);
 await archiveFrame.waitForSelector('#archive-report');
 const retained=await page.evaluate(async url=>{
  const response=await fetch(url);
  return {status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};
 },`${B}/api/sites/${archiveSlug}/download?version=${archiveVersion}`);
 assert.equal(retained.status,200);
 assert.deepEqual(Buffer.from(retained.bytes),Buffer.from(archive));

 console.log('Checking the current upload hint without historical task cards');
 await page.goto(B+'/',{waitUntil:'domcontentloaded'});
 assert.equal(await page.$('.package-upload-hint'),null);
 await writeFile('test-results/subpath.zip',archive);
 const archivePicker=await page.$('input[type="file"][accept*=".pdf"]');assert(archivePicker);
 await archivePicker.uploadFile(new URL('../test-results/subpath.zip',import.meta.url).pathname);
 await page.waitForSelector('dialog[open]');
 await page.$eval('dialog[open] button.primary, dialog[open] button.solid',button=>button.click());
 await page.waitForSelector('.package-upload-hint a[href="/artifact-site/me?tab=uploads"]');
 assert.equal(await page.$('.package-tasks'),null);
 await page.setViewport({width:1280,height:900});
 await page.screenshot({path:'test-results/upload-hint-desktop.png',fullPage:true});
 await page.setViewport({width:390,height:844});
 await page.screenshot({path:'test-results/upload-hint-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Upload hint must fit narrow screens');
 await page.setViewport({width:1280,height:900});
 await page.click('.package-upload-hint a[href="/artifact-site/me?tab=uploads"]');
 await page.waitForSelector('#me-tab-uploads[aria-selected="true"]');

 console.log('Checking upload task tabs, unread receipts, retries and responsive layout');
 const noticeJob=(versionId,status,attempts=3)=>({generation:'round-one',versionId,title:versionId==='ver_notice_running'?'项目资料.zip':versionId==='ver_notice_failed'?'VerifiedLab-Local (1).zip':'设计规范.zip',targetSlug:null,status,stage:status,attempts,retryable:true,expiresAt:Date.now()+3600000,processedFiles:0,totalFiles:null,...(status==='completed'?{result:{slug:archiveSlug,versionId:archiveVersion}}:{})});
 let noticeJobs=[noticeJob('ver_notice_running','processing'),noticeJob('ver_notice_failed','failed'),noticeJob('ver_notice_completed','completed')];
 let rejectRetry=true;
 const taskRequests=req=>{
  if(req.url()===B+'/api/uploads/jobs')return req.respond({status:200,contentType:'application/json',body:JSON.stringify({jobs:noticeJobs})});
  if(req.url()===B+'/api/uploads/ver_notice_failed/retry'){
   if(rejectRetry)return req.respond({status:503,contentType:'application/json',body:'{"error":"Temporary failure"}'});
   noticeJobs=noticeJobs.map(job=>job.versionId==='ver_notice_failed'?{...job,status:'queued',stage:'queued',attempts:0,generation:'round-two'}:job);
   return req.respond({status:202,contentType:'application/json',body:JSON.stringify(noticeJobs[1])});
  }
  return req.continue();
 };
 await page.setRequestInterception(true);page.on('request',taskRequests);
 await page.goto(B+'/me',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('#me-tab-uploads .job-dot-failed');
 assert.equal(await page.$('.package-tasks'),null,'Tasks must not precede the library');
 const taskPeer=await browser.newPage();
 await taskPeer.setRequestInterception(true);taskPeer.on('request',taskRequests);
 await taskPeer.goto(B+'/me',{waitUntil:'domcontentloaded'});
 await taskPeer.waitForSelector('#me-tab-uploads .job-dot-failed');
 await page.bringToFront();
 const tabLabels=await page.$$eval('.work-tabs > [role="tab"]',nodes=>nodes.map(node=>node.id));
 assert(tabLabels.indexOf('me-tab-uploads')>tabLabels.indexOf('me-tab-recent'));
 await page.click('#me-tab-uploads');
 await page.waitForSelector('[data-job-id="ver_notice_failed"]');
 await page.waitForSelector('#me-tab-uploads .job-dot-running');
 await taskPeer.waitForSelector('#me-tab-uploads .job-dot-running');
 await taskPeer.close();
 assert(await page.$('[data-job-id="ver_notice_failed"] .job-dot-failed'),'Read failures retain their row status');
 await page.click('[data-job-id="ver_notice_failed"] .package-task-actions button');
 await page.waitForSelector('.package-task-error');
 rejectRetry=false;
 await page.click('[data-job-id="ver_notice_failed"] .package-task-actions button');
 await page.waitForSelector('[data-job-id="ver_notice_failed"] .job-dot-running');
 await page.click('#me-tab-owned');
 noticeJobs=noticeJobs.map(job=>job.versionId==='ver_notice_failed'?{...job,status:'failed',stage:'failed',attempts:3}:job);
 await page.evaluate(()=>window.dispatchEvent(new Event('package-job-submitted')));
 await page.waitForSelector('#me-tab-uploads .job-dot-failed');
 await page.click('#me-tab-uploads');
 await page.waitForSelector('#me-tab-uploads .job-dot-running');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForSelector('#me-tab-uploads .job-dot-running');
 await page.screenshot({path:'test-results/upload-tasks-desktop.png',fullPage:true});
 await page.setViewport({width:390,height:844});
 await page.screenshot({path:'test-results/upload-tasks-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Tasks must fit narrow screens');
 await page.setViewport({width:1280,height:900});
 await page.click('#me-tab-owned');
 noticeJobs=noticeJobs.map(job=>job.status==='processing'?{...job,status:'completed',stage:'completed',result:{slug:archiveSlug,versionId:archiveVersion}}:job);
 await page.evaluate(()=>window.dispatchEvent(new Event('package-job-submitted')));
 await page.waitForSelector('#me-tab-uploads .job-dot-completed');
 await page.click('#me-tab-uploads');
 await page.waitForSelector('#me-tab-uploads .job-dot',{hidden:true});
 page.off('request',taskRequests);await page.setRequestInterception(false);

 console.log('Checking browser UI upload and PDF resources under the subpath');
 await page.goto(B+'/',{waitUntil:'domcontentloaded'});
 await writeFile('test-results/migration.pdf',pdf());
 const picker=await page.$('input[type="file"][accept*=".pdf"]');assert(picker);
 await picker.uploadFile(process.cwd()+'/test-results/migration.pdf');
 // Publishing asks whether the first version is official.
 await page.waitForSelector('dialog[open]');
 const confirm=await page.$('dialog[open] button.primary, dialog[open] button.solid');
 if(confirm)await confirm.click();else {const buttons=await page.$$('dialog[open] button');await buttons.at(-1).click();}
 await page.waitForFunction(()=>location.pathname.includes('/s/'));
 const pdfFrame=await (await page.waitForSelector('iframe')).contentFrame();assert(pdfFrame);
 await pdfFrame.waitForFunction(()=>[...document.querySelectorAll('#stage canvas')].some(el=>el.width>0 && !(el.width===300 && el.height===150)),{timeout:45000});
 const pdfUrl=page.url().split('?')[0];
 await page.goto(pdfUrl+'/edit',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(expected=>location.href===expected,{},pdfUrl);assert.equal(page.url(),pdfUrl);
 const vendor=await localFetch(B+'/vendor/pdfjs/pdf.min.mjs');assert.equal(vendor.status,200, (await vendor.text()).slice(0,400));
 console.log('Checking real MCP SDK authorization and removal of the old gateway entry');
 const b=await connect(B,page);
 for(const client of clients.splice(0))await client.close();
 oldEntryEnabled=false;
 assert.equal((await localFetch(A+'/')).status,404);
 await page.goto(B+'/me',{waitUntil:'domcontentloaded'});assert.equal((await api(page,B,'/api/auth/me')).user.id,user);
 const refreshed=await localFetch(B+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:b.saved.refresh_token,client_id:b.info.client_id,resource:B+'/mcp'})});assert.equal(refreshed.status,200);
 b.saved=await refreshed.json();const client=new Client({name:'after-cutover',version:'1'});clients.push(client);
 await client.connect(new StreamableHTTPClientTransport(new URL(B+'/mcp'),{authProvider:b,fetch:localFetch}));
 assert((await client.listTools()).tools.length>0);
 await api(page,B,'/api/auth/logout',{});assert.equal((await api(page,B,'/api/auth/me')).user,null);
 await page.goto(B+'/api/auth/login?return_to=%2Fme',{waitUntil:'networkidle0'});
 assert.equal(new URL(page.url()).searchParams.get('prompt'),'login');
 await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('#account-1')]);
 assert.equal((await api(page,B,'/api/auth/me')).user.id,user);
 assert.deepEqual(escaped,[],'B requests escaped its mount');assert.deepEqual(pageErrors,[],'Browser JavaScript errors');
 assert(discoveryRequests.has('/.well-known/oauth-authorization-server/artifact-site'));
 assert.equal((await fetch(`http://127.0.0.1:${appPort}/artifact-site/api/auth/me`)).status,200);
 console.log('PASS: canonical subpath, gateway redirects, login, edit/download, share unlock, UI upload/PDF, async archive preview/original, SDK OAuth/refresh and old-entry removal');
}finally{
 for(const client of clients)await client.close().catch(()=>{});
 if(browser){
  const child=browser.process();
  await browser.close();
  // Chrome descendants can retain these log pipes after the browser has exited on macOS.
  child?.stdout?.destroy();child?.stderr?.destroy();
 }
 await writeFile('test-results/migration-server.log',await docker('logs',app).catch(()=>''));
 await docker('rm','-f',app,pg).catch(()=>{});await docker('volume','rm',volume).catch(()=>{});await docker('network','rm',network).catch(()=>{});
 gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));
 idp.closeAllConnections();await new Promise(resolve=>idp.close(resolve));

}
