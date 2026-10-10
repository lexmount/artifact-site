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
   const code=randomBytes(16).toString('hex');codes.set(code,url.searchParams);
   const dest=new URL(url.searchParams.get('redirect_uri'));dest.searchParams.set('code',code);dest.searchParams.set('state',url.searchParams.get('state'));
   res.writeHead(302,{location:dest.href});return res.end();
  }
  if(url.pathname.endsWith('/token')){
   let body='';for await(const chunk of req)body+=chunk;
   const form=new URLSearchParams(body), flow=codes.get(form.get('code'));codes.delete(form.get('code'));
   assert(flow);assert.equal(form.get('redirect_uri'),flow.get('redirect_uri'));
   assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),flow.get('code_challenge'));
   const token=await new SignJWT({sub:'migration-person',email:'migration@example.test',email_verified:true,name:'Migration Test',nonce:flow.get('nonce')})
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
 page.on('request',req=>{const u=new URL(req.url());if(u.hostname==='b.test'&&!u.pathname.startsWith('/artifact-site')&&!u.pathname.startsWith('/.well-known/'))escaped.push(u.href);});
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
 console.log('Checking first-time MCP authorization with a fresh browser context');
 for(const base of [B]){
  console.log(`First-time OAuth: ${base}`);
  const context=await browser.createBrowserContext(), fresh=await context.newPage();
  const requests=[];fresh.on('request',req=>requests.push(req.url()));
  await fresh.goto(base+'/',{waitUntil:'domcontentloaded'});
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
 let site,user;
 for(const base of [B]){
  console.log(`Checking browser login, shared data, preview, editing and downloads: ${base}`);
  await page.goto(base+'/api/auth/login?return_to=%2Fme',{waitUntil:'domcontentloaded'});
  assert.equal(new URL(page.url()).pathname,new URL(base).pathname.replace(/\/$/,'')+'/me');
  const me=await api(page,base,'/api/auth/me');assert(me.user);if(user)assert.equal(me.user.id,user);else user=me.user.id;
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
  await guestPage.goto(localShare,{waitUntil:'domcontentloaded'});
  await guestPage.type('input[name="passcode"]','migration-test');
  await Promise.all([guestPage.waitForNavigation({waitUntil:'domcontentloaded'}),guestPage.click('button[type="submit"]')]);
  assert(guestPage.url().startsWith(localShare));await guestPage.waitForSelector('iframe');await guest.close();
 }
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
 await page.goto(B+'/api/auth/login?return_to=%2Fme',{waitUntil:'domcontentloaded'});assert.equal((await api(page,B,'/api/auth/me')).user.id,user);
 assert.deepEqual(escaped,[],'B requests escaped its mount');assert.deepEqual(pageErrors,[],'Browser JavaScript errors');
 assert(discoveryRequests.has('/.well-known/oauth-authorization-server/artifact-site'));
 assert.equal((await fetch(`http://127.0.0.1:${appPort}/artifact-site/api/auth/me`)).status,200);
 console.log('PASS: canonical subpath, gateway redirects, login, edit/download, share unlock, UI upload/PDF, SDK OAuth/refresh and old-entry removal');
}finally{
 for(const client of clients)await client.close().catch(()=>{});
 if(browser)await browser.close();
 await writeFile('test-results/migration-server.log',await docker('logs',app).catch(()=>''));
 await docker('rm','-f',app,pg).catch(()=>{});await docker('volume','rm',volume).catch(()=>{});await docker('network','rm',network).catch(()=>{});
 gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));
 await new Promise(resolve=>idp.close(resolve));
}
