import { createAtomicApi } from './atomic-api.js';

const bootstrap = JSON.parse(document.getElementById('atomic-hub-bootstrap').textContent);
const listeners = new Map();
let refreshInFlight = null;
async function refreshSession() {
  if (!refreshInFlight) refreshInFlight = fetch('/hub/connect').then(async response => {
    if (!response.ok) throw new Error('The hub is unavailable');
    const next=await response.json(); bootstrap.token=next.token;
    if(next.stopVersion!==bootstrap.stopVersion) {
      bootstrap.stopVersion=next.stopVersion;
      emit('agent:gatewayStopAll',{version:next.stopVersion});
    }
  }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
const emit = (channel, value) => {
  for (const listener of listeners.get(channel) ?? []) listener(undefined, value);
};
async function rpc(kind, channel, args, renewed = false) {
  const response = await fetch('/hub/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atomic-Hub-Token': bootstrap.token },
    body: JSON.stringify({ kind, channel, args }),
  });
  const result = await response.json();
  if (response.status === 403 && result.code === 'session_expired' && !renewed) {
    await refreshSession(); return rpc(kind, channel, args, true);
  }
  if (!response.ok) throw new Error(result.error ?? 'The hub request failed');
  return result.value;
}
const transport = {
  invoke: async (channel, ...args) => {
    if (channel === 'app:openExternal') {
      const url = new URL(String(args[0]));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be opened');
      window.open(url.href, '_blank', 'noopener,noreferrer'); return {ok:true};
    }
    if (channel === 'app:windowGround') { document.documentElement.style.backgroundColor = String(args[0]); return; }
    if (channel === 'app:chromeTheme') { document.documentElement.style.colorScheme = args[0] ? 'dark' : 'light'; return; }
    if (channel === 'app:chooseWorkspace') {
      const status = await rpc('invoke','agent:status',[]);
      const path = window.prompt('Workspace folder on the hub',status.workingDir);
      return path ? rpc('invoke',channel,[path]) : null;
    }
    if (channel === 'app:openPath' || channel === 'app:openReplyPath') return download(args[0]);
    if (channel === 'app:sessionMenu') {
      const {id,pinned,unread}=args[0];
      showMenu([
        {label:'Mark as unread',disabled:unread,action:()=>emit('app:menu','unread:'+id)},
        {label:pinned?'Unpin':'Pin',action:()=>emit('app:menu',(pinned?'unpin:':'pin:')+id)},
        {label:'Delete…',action:()=>emit('app:menu','delask:'+id)},
      ]); return;
    }
    if (channel === 'app:fileMenu') {
      showMenu([
        {label:'Download file',action:()=>download(args[0])},
        {label:'Copy path',action:()=>navigator.clipboard.writeText(String(args[0]))},
      ]); return;
    }
    if (channel === 'app:quit') { window.close(); return; }
    return rpc('invoke', channel, args);
  },
  send: (channel, ...args) => { void rpc('send', channel, args).catch(error => console.error(error.message)); },
  sendSync: (channel) => {
    if (channel === 'app:voiceSupported') return false;
    if (channel === 'app:queuesTake') {
      const queues = bootstrap.queues; bootstrap.queues = {}; return queues;
    }
    throw new Error('This synchronous application message is not available in the browser');
  },
  on: (channel, listener) => {
    const current = listeners.get(channel) ?? new Set(); current.add(listener); listeners.set(channel, current);
  },
  removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
};

window.atomic = createAtomicApi(transport, {
  platform: bootstrap.platform, freshAtBoot: bootstrap.freshAtBoot,
  voiceSupported: false, bootPaint: () => ({ views: [], frames: 0, input: null, done: true }),
});
document.body.classList.add('platform-browser');

let stream, reconnectTimer;
function connectEvents() {
  stream?.close();
  stream = new EventSource('/hub/events');
  stream.onmessage = event => {
    const {channel,payload}=JSON.parse(event.data);
    if(channel==='agent:gatewayStopAll') bootstrap.stopVersion=payload.version;
    emit(channel,payload);
  };
  stream.onerror = () => {
    stream.close();
    emit('agent:status',{state:'disconnected',error:'Reconnecting to the hub…'});
    clearTimeout(reconnectTimer);
    reconnectTimer=setTimeout(async () => {
      try { await refreshSession(); } catch { /* The status remains disconnected until the next attempt. */ }
      connectEvents();
    },2000);
  };
  stream.onopen = () => {
    void window.atomic.status().then(status=>emit('agent:status',status));
    void window.atomic.replayApprovals();
  };
}
connectEvents();

function download(path) {
  const link=document.createElement('a'); link.href='/hub/file?path='+encodeURIComponent(String(path));
  link.download=''; document.body.append(link); link.click(); link.remove();
  return {ok:true};
}
let pointer={x:20,y:60};
document.addEventListener('pointerdown',event=>{pointer={x:event.clientX,y:event.clientY};},true);
function showMenu(items) {
  document.querySelector('.hub-context-menu')?.remove();
  const menu=document.createElement('dialog'); menu.className='hub-context-menu';
  menu.style.left=Math.min(pointer.x,window.innerWidth-230)+'px';
  menu.style.top=Math.min(pointer.y,window.innerHeight-180)+'px';
  for (const item of items) {
    const button=document.createElement('button'); button.type='button'; button.textContent=item.label; button.disabled=!!item.disabled;
    button.onclick=()=>{menu.close();void item.action();}; menu.append(button);
  }
  menu.onclose=()=>menu.remove();
  menu.onclick=event=>{
    if(event.target!==menu)return;
    const box=menu.getBoundingClientRect();
    if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)menu.close();
  };
  document.body.append(menu); menu.showModal();
}

// The original classic scripts share globals. Load them in their original order,
// after the real bridge exists, so the GUI never enters its demo mode.
for (const source of bootstrap.scripts) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = source;
    script.onload = resolve; script.onerror = () => reject(new Error(`Could not load ${source}`));
    document.body.append(script);
  });
}
