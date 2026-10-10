'use strict';

const GATEWAYS = { snapshot:null, refreshing:null, dialog:null, busy:false, revision:0, message:'', error:null, connectionError:null };
function gatewaysConfigured() {
  return !!(BR && BR.modelGateways && LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.gateways && LIVE_CONFIG.localModels.gateways.length);
}
function gatewayMainModel() {
  const snapshot=GATEWAYS.snapshot;
  if(!snapshot || !snapshot.main) return null;
  const host=snapshot.hosts.find(row=>row.gateway.id===snapshot.main.hostId);
  const model=host && host.models.find(row=>row.id===snapshot.main.modelId);
  return model ? {host,model} : null;
}
function gatewayComposerHtml() {
  const selected=gatewayMainModel();
  const label=selected ? selected.model.name : 'Models';
  const host=selected ? selected.host.gateway.name : 'Model gateways';
  return '<button class="cchip modelchip" data-gateway-open title="Choose a model" aria-label="Choose a model">'
    +ic('server')+'<span class="cval">'+esc(label)+'</span>'+ic('chevD','chev')+'</button>'
    +'<span class="cchip"><span class="cval">'+esc(host)+'</span></span>'
    +(GATEWAYS.snapshot && GATEWAYS.snapshot.mode==='fusion' ? '<button class="cchip" data-gateway-open>Fusion</button>' : '');
}
async function refreshGateways() {
  if(!gatewaysConfigured()) return;
  if(GATEWAYS.refreshing) return GATEWAYS.refreshing;
  GATEWAYS.refreshing=(async()=>{
    try {
      const result=await BR.modelGateways();
      if(!result.ok) throw new Error(result.error || 'Model controls are unavailable');
      const next=result.data;
      for(const host of next.hosts) {
        if(!host.online && !host.models.length && GATEWAYS.snapshot) {
          host.models=GATEWAYS.snapshot.hosts.find(old=>old.gateway.id===host.gateway.id)?.models || [];
        }
      }
      const changed=JSON.stringify(next)!==JSON.stringify(GATEWAYS.snapshot);
      GATEWAYS.snapshot=next;
      GATEWAYS.connectionError=null;
      if(changed) render();
    } catch(error) {
      GATEWAYS.connectionError=error.message;
    } finally {
      paintGatewayDialog(); GATEWAYS.refreshing=null;
    }
  })();
  return GATEWAYS.refreshing;
}
function openGatewayDialog() {
  if(GATEWAYS.dialog) { void refreshGateways(); return; }
  const dialog=document.createElement('dialog'); dialog.className='gateway-dialog';
  dialog.setAttribute('aria-label','Model gateways');
  GATEWAYS.dialog=dialog;
  dialog.addEventListener('close',()=>{dialog.remove();GATEWAYS.dialog=null;});
  dialog.addEventListener('click',event=>{
    const close=event.target.closest('[data-gateway-close]');
    if(close) {dialog.close();return;}
    const button=event.target.closest('[data-gateway-action]');
    if(!button) return;
    void runGatewayAction(button.dataset.gatewayAction,button.dataset.host,button.dataset.model);
  });
  document.body.append(dialog); paintGatewayDialog(); dialog.showModal(); void refreshGateways();
}
function paintGatewayDialog() {
  const dialog=GATEWAYS.dialog;if(!dialog)return;
  const scrollTop=dialog.querySelector('.gateway-hosts')?.scrollTop || 0;
  const snapshot=GATEWAYS.snapshot;
  const hosts=snapshot ? snapshot.hosts : [];
  const row=(host,model)=>{
    const main=snapshot.main && snapshot.main.hostId===host.gateway.id && snapshot.main.modelId===model.id;
    const worker=snapshot.worker && snapshot.worker.hostId===host.gateway.id && snapshot.worker.modelId===model.id;
    const mainModel=gatewayMainModel();
    const workerConflict=mainModel && mainModel.host.gateway.id===host.gateway.id && mainModel.model.id!==model.id && model.group && model.group===mainModel.model.group;
    const conflict=model.group && host.models.find(other=>other.id!==model.id && other.group===model.group && ['ready','starting','stopping'].includes(other.state));
    const disabled=!host.online || GATEWAYS.busy || !!conflict;
    const running=model.state!=='stopped';
    const status=host.online ? ({ready:'Ready',starting:'Loading',stopping:'Stopping',failed:'Failed',stopped:'Stopped'}[model.state] || model.state) : 'Offline';
    const facts=[model.kind,model.sizeBytes ? (model.sizeBytes/1024**3).toFixed(1)+' GiB' : '',model.contextSize?Math.round(model.contextSize/1024)+'K context':'',model.parallelSlots>1?model.parallelSlots+' worker slots':'',model.supportsVision?'Vision':'',model.ttlSeconds?'Unloads after '+Math.round(model.ttlSeconds/60)+' idle minutes':''].filter(Boolean).join(' · ');
    const startText=model.kind==='llm' ? (model.state==='ready'?'Use':'Start & use') : 'Start';
    const button=(action,label,off)=>'<button class="btn" data-gateway-action="'+action+'" data-host="'+esc(host.gateway.id)+'" data-model="'+esc(model.id)+'"'+(off?' disabled':'')+'>'+label+'</button>';
    return '<article class="gateway-model'+(main?' main':'')+'"><div class="gateway-model-copy"><div class="gateway-model-name">'+esc(model.name)
      +(main?'<span class="gateway-tag">Main</span>':'')+(worker?'<span class="gateway-tag">'+(snapshot.mode==='fusion'?'Worker':'Worker off')+'</span>':'')+'</div>'
      +'<div class="gateway-facts">'+esc(facts)+'</div>'+(conflict?'<div class="gateway-facts">Stop '+esc(conflict.name)+' to use this model.</div>':'')
      +'</div><span class="gateway-state '+(host.online?model.state:'offline')+'">'+esc(status)+'</span><div class="gateway-actions">'
      +button('start',startText,disabled)+(model.kind==='llm'?button('worker','Worker',disabled || !snapshot.main || workerConflict):'')
      +button('stop','Stop',!host.online || !running)
      +(model.state==='ready' && model.workspacePath ? button('workspace','Open',!host.online) : '')+'</div></article>';
  };
  dialog.innerHTML='<header><div><h2>Models</h2><p>Start models on their hosts. Status checks keep stopped models unloaded.</p></div><button class="btn icon" data-gateway-close aria-label="Close model controls">'+ic('x')+'</button></header>'
    +'<div class="gateway-mode"><span>'+((snapshot && snapshot.mode==='fusion')?'Fusion · main model and worker':'Solo · main model')+(snapshot?.externalWorkers?.active?' · '+snapshot.externalWorkers.active+' external worker jobs':'')+'</span><div>'
    +'<button class="btn" data-gateway-action="mode"'+(GATEWAYS.busy?' disabled':'')+'>'+((snapshot && snapshot.mode==='fusion')?'Use Solo':'Enable Fusion')+'</button>'
    +'<button class="btn" data-gateway-action="refresh">Refresh</button><button class="btn danger" data-gateway-action="stop-all">Stop all</button></div></div>'
    +'<div class="gateway-notice" role="status">'+esc(GATEWAYS.error || GATEWAYS.connectionError || GATEWAYS.message || '')+'</div>'
    +'<div class="gateway-hosts">'+(hosts.length ? hosts.map(host=>'<section><h3>'+esc(host.gateway.name)+'<span>'+ (host.online?'Online':'Offline')+'</span></h3>'
      +(host.error?'<p class="gateway-facts">'+esc(host.error)+'</p>':'')+host.models.map(model=>row(host,model)).join('')+'</section>').join('') : '<p>Loading model gateways…</p>')+'</div>';
  dialog.querySelector('.gateway-hosts').scrollTop=scrollTop;
}
function gatewayResult(result) {
  if(!result || !result.ok) throw new Error(result?.error || 'The model action failed');
  if(result.data && result.data.ok===false) throw new Error((result.data.errors || []).join('; ') || 'The model action failed');
  return result.data === undefined ? result : result.data;
}
async function runGatewayAction(action,hostId,modelId) {
  if(action==='refresh') { await refreshGateways();return; }
  if(action==='workspace') {
    const model=GATEWAYS.snapshot?.hosts.find(host=>host.gateway.id===hostId)?.models.find(row=>row.id===modelId);
    if(model?.workspacePath) await BR.openExternal(model.workspacePath); return;
  }
  if(GATEWAYS.busy && action!=='stop' && action!=='stop-all') return;
  const revision=++GATEWAYS.revision;GATEWAYS.busy=true;GATEWAYS.error=null;
  GATEWAYS.message=action==='stop-all'?'Stopping tasks and models…':action==='stop'?'Stopping model…':'Updating models…';paintGatewayDialog();
  try {
    if(action==='mode') {
      if(GATEWAYS.snapshot.mode==='fusion') {
        gatewayResult(await BR.modelGatewayAction({action:'solo'}));
      } else {
        const worker=GATEWAYS.snapshot.worker;
        if(!worker) throw new Error('Choose a model on another host with the Worker button first.');
        gatewayResult(await BR.modelGatewayAction({action:'start',role:'worker',hostId:worker.hostId,modelId:worker.modelId}));
      }
    } else {
      const result=gatewayResult(await BR.modelGatewayAction({action:action==='worker'?'start':action,hostId,modelId,role:action==='worker'?'worker':'main'}));
      if(result.cancelled || revision!==GATEWAYS.revision)return;
    }
    if(revision===GATEWAYS.revision) GATEWAYS.message=action==='stop-all'?'All reachable models are stopped.':action==='stop'?'Model stopped.':'Model selection updated.';
    await refreshLiveConfig();
  } catch(error) {if(revision===GATEWAYS.revision)GATEWAYS.error=error.message;}
  finally {if(revision===GATEWAYS.revision)GATEWAYS.busy=false;await refreshGateways();paintGatewayDialog();}
}
function startGatewayUi() {
  if(!BR || !BR.modelGateways)return;
  document.addEventListener('click',event=>{if(event.target.closest('[data-gateway-open]'))openGatewayDialog();});
  BR.onGatewayStopAll(()=>{
    S.queued=[];QUEUES.clear();STEER.ahead=0;DRAIN_OWED=false;QUEUES_KEPT=null;render();
  });
  BR.onStatus(status=>{if(status.state==='connected')void refreshGateways();});
  setInterval(()=>{if(gatewaysConfigured())void refreshGateways();},3000);
}
