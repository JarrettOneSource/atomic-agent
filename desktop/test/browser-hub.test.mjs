import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { get } from 'node:http';
const { BrowserHub } = createRequire(import.meta.url)('../out/main/browser-hub.js');

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-browser-'));
  const calls = [];
  await writeFile(join(root, 'index.html'), '<html><body><script src="renderer.js"></script></body></html>');
  await writeFile(join(root, 'renderer.js'), 'window.live = !!window.atomic;');
  await writeFile(join(root, 'browser-channels.json'), JSON.stringify({ invoke:['agent:status'], send:[], sendSync:[], events:['agent:chat'] }));
  const hub = new BrowserHub({ port:0, origin:'https://hub.example', rendererDir:root, platform:'darwin', freshAtBoot:false,
    queues: () => ({a:['</script><script>bad()</script>']}), downloadRoots: () => [root],
    call: async (...args) => { calls.push(args); return { state:'connected' }; },
  });
  await hub.start();
  const url = `http://127.0.0.1:${hub.port}`;
  const page = await fetch(url);
  const html = await page.text();
  const bootstrap = JSON.parse(html.match(/type="application\/json">(.*?)<\/script>/s)[1]);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  try { await run({hub,root,url,calls,page,html,bootstrap,cookie}); }
  finally { await hub.close(); await rm(root,{recursive:true,force:true}); }
}

test('the real bridge loads before the original GUI and bootstrap data cannot inject scripts', async () => fixture(async ({html,bootstrap,page}) => {
  assert.deepEqual(bootstrap.scripts,['renderer.js']);
  assert.equal(bootstrap.queues.a[0],'</script><script>bad()</script>');
  assert.ok(!html.includes('<script>bad()'));
  assert.ok(!html.includes('<script src="renderer.js">'));
  assert.match(html,/type="module" src="browser-bridge.js"/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(page.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
}));

test('RPC requires the session, token, allowed origin, and a public GUI method', async () => fixture(async ({url,cookie,bootstrap,calls}) => {
  const send = (headers,channel='agent:status') => fetch(url+'/hub/rpc',{ method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({kind:'invoke',channel,args:[]}) });
  const auth = {cookie,'X-Atomic-Hub-Token':bootstrap.token,origin:'https://hub.example'};
  assert.equal((await send({})).status,403);
  assert.equal((await send({...auth,origin:'https://elsewhere.example'})).status,403);
  assert.equal((await send({...auth,'X-Atomic-Hub-Token':'wrong'})).status,403);
  assert.equal((await send(auth,'private:method')).status,403);
  assert.equal(calls.length,0);
  const response=await send(auth); assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{value:{state:'connected'}});
  assert.deepEqual(calls,[['invoke','agent:status',[]]]);
}));

test('SSE forwards real application events and disconnecting one viewer leaves the hub usable', async () => fixture(async ({hub,url,cookie,bootstrap}) => {
  assert.equal((await fetch(url+'/hub/events')).status,403);
  const controller=new AbortController();
  const response=await fetch(url+'/hub/events',{headers:{cookie},signal:controller.signal});
  const reader=response.body.getReader(); await reader.read();
  hub.broadcast('private:event',{secret:true}); hub.broadcast('agent:chat',{kind:'delta',text:'hello'});
  const frame=new TextDecoder().decode((await reader.read()).value);
  assert.match(frame,/hello/); assert.ok(!frame.includes('secret'));
  controller.abort();
  const next=await fetch(url+'/hub/rpc',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Atomic-Hub-Token':bootstrap.token},body:JSON.stringify({kind:'invoke',channel:'agent:status',args:[]})});
  assert.equal(next.status,200);
}));

test('file delivery is authenticated and downloads rather than executing HTML', async () => fixture(async ({root,url,cookie}) => {
  const path=join(root,'result.html'); await writeFile(path,'<script>bad()</script>');
  const address=url+'/hub/file?path='+encodeURIComponent(path);
  assert.equal((await fetch(address)).status,403);
  const response=await fetch(address,{headers:{cookie}});
  assert.equal(response.status,200); assert.match(response.headers.get('content-disposition'),/^attachment/);
  assert.equal(response.headers.get('content-type'),'application/octet-stream');
  assert.equal(await response.text(),'<script>bad()</script>');
  assert.equal((await fetch(url+'/hub/file?path='+encodeURIComponent('/etc/hosts'),{headers:{cookie}})).status,403);
}));

test('reconnect renews the session and rejects an unrelated host or origin', async () => fixture(async ({url,bootstrap}) => {
  const response=await fetch(url+'/hub/connect');
  assert.equal(response.status,200);
  assert.equal((await response.json()).token,bootstrap.token);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await fetch(url+'/hub/connect',{headers:{origin:'https://elsewhere.example'}})).status,403);
  const status=await new Promise((resolve,reject)=>{
    get(url+'/',{headers:{host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);
  });
  assert.equal(status,403);
}));

test('oversized RPC bodies never invoke an application action', async () => fixture(async ({url,cookie,bootstrap,calls}) => {
  const response=await fetch(url+'/hub/rpc',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Atomic-Hub-Token':bootstrap.token},body:JSON.stringify({kind:'invoke',channel:'agent:status',args:['x'.repeat(4*1024*1024)]})});
  assert.equal(response.status,413);
  assert.equal(calls.length,0);
}));
