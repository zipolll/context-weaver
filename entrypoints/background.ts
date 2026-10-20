import { openPage } from '../src/core/navigation';
import { defineBackground } from 'wxt/utils/define-background';
import { CHANNEL, type ActivePage, type ApiSettings, type AppCommand, type ContentCommand, type Draft, type PageSnapshot, type Reply, type SelectionSnapshot, type UiIntent, type SendResult, type AppState, type TurnLocation } from '../src/core/types';
import { mutateState, readState } from '../src/core/repository';
import { applyCommand, bindDraft, captureSnapshot, exportBackup, safeUrl, updateCaptured } from '../src/core/state';
import { uid } from '../src/core/context';
import { normalizePrompt, questionFromDraft } from '../src/core/questions';
import { conversationIdentity, platformConversation, platformFor, platformById, type PlatformId } from '../src/adapters/platforms';
import { createTurnLocation, navigationFailure } from '../src/core/turnLocation';
import type { TurnNavigationStatus } from '../src/core/types';
import { matchTurnHistory } from '../src/core/history';
import { selectionSource } from '../src/core/sources';
export default defineBackground(()=>{
  const inflight=new Set<string>();
  const locating = new Map<number,string>();
  let intentClaim: Promise<unknown> = Promise.resolve();
  const notify=()=>chrome.runtime.sendMessage({channel:CHANNEL,changed:true}).catch(()=>undefined);
  const trustedPage=(sender:chrome.runtime.MessageSender)=>sender.id===chrome.runtime.id&&sender.url?.startsWith(chrome.runtime.getURL(''));
  const defaultSettings:ApiSettings={endpoint:'https://api.deepseek.com/chat/completions',model:'',apiKey:''};
  async function targetTab(tabId?:number):Promise<chrome.tabs.Tab>{
    if(tabId!==undefined)return chrome.tabs.get(tabId);
    const current=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
    if(current?.url?.startsWith('http')){await chrome.storage.session.set({lastWebTab:current.id});return current;}
    const stored=await chrome.storage.session.get('lastWebTab');if(typeof stored.lastWebTab==='number')try{return await chrome.tabs.get(stored.lastWebTab);}catch{}
    throw new Error('请先打开要整理的网页，然后点击扩展图标。');
  }
  async function content<T>(tabId:number,command:ContentCommand):Promise<T>{
    let reply:Reply<T>;try{reply=await chrome.tabs.sendMessage(tabId,{channel:CHANNEL,command});}catch{throw new Error('页面连接中断，请刷新目标网页后重试。');}
    if(!reply?.ok)throw new Error(reply&&!reply.ok?reply.error:'页面没有响应。');return reply.data;
  }
  function locationFor(state: AppState, url: string, turnId: string) {
    const identity = platformConversation(url), key = identity && JSON.stringify([identity.site, identity.externalId]);
    const saved = state.conversations.find(c => key ? conversationIdentity(c) === key : c.url === url);
    return saved ? createTurnLocation(saved, turnId) : undefined;
  }
  async function locatePage(tabId: number, turnId: string, location?: TurnLocation): Promise<Exclude<TurnNavigationStatus,'pending'>|'superseded'> {
    const requestId = uid(), deadline = Date.now() + 10000; locating.set(tabId, requestId);
    try {
      while (Date.now() < deadline) {
        if (locating.get(tabId) !== requestId) return 'superseded';
        try {
          const result=await content<TurnNavigationStatus|boolean>(tabId,{type:'cw.locate',turnId,location,requestId});
          if(locating.get(tabId)!==requestId)return 'superseded';
          // Accept booleans from an older content script until the page is refreshed.
          if(result===true||result==='found')return 'found';
          if(result==='ambiguous'||result==='missing'||result==='wrong-page')return result;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      return 'missing';
    } finally {
      if (locating.get(tabId) === requestId) locating.delete(tabId);
      try { await content(tabId,{type:'cw.locate.cancel',requestId}); } catch {}
    }
  }
  async function active():Promise<ActivePage>{const t=await targetTab();if(t.id===undefined||!t.url)throw new Error('无法读取当前页面。');const site=platformFor(t.url)?.id;const page:ActivePage={tabId:t.id,url:t.url,title:t.title??'未命名页面',supported:!!site,site};if(site){try{page.snapshot=await content(t.id,{type:'cw.snapshot'});}catch{}try{page.selection=await content(t.id,{type:'cw.selection'});}catch{}}return page;}
  function decorate(s:AppState,snapshot:PageSnapshot,tabId?:number){
    const saved=s.conversations.find(c=>conversationIdentity(c)===conversationIdentity(snapshot));
    const matches=matchTurnHistory(saved?.turns??[],snapshot.turns);
    const turns=snapshot.turns.map((t,index)=>{
      const stored=matches.get(t.id)?.question;
      const draft=s.drafts.find(d=> d.targetSite===snapshot.site && ['submitting','sent','bound','uncertain','filled'].includes(d.status) && normalizePrompt(d.prompt)===normalizePrompt(t.user) && ((d.targetExternalId===snapshot.externalId&&d.sentTurnId===t.id)||(d.tabId===tabId&&d.destination==='new'&&index===0)));
      const question=draft?questionFromDraft(draft):stored;return question?{...t,question}:t;
    });
    const first=turns[0];
    return {...snapshot,turns,title:first?.question&&snapshot.title===first.user.slice(0,60)?first.question.slice(0,60):snapshot.title};
  }
  async function mark(id:string,patch:Partial<Draft>){await mutateState(s=>{const d=s.drafts.find(x=>x.id===id);if(d&&d.status!=='bound')Object.assign(d,patch);return s;});notify();}
  async function executeSend(id:string,mode:'append'|'replace',expected?:string){
    let dispatched=false;
    try{
      let draft=(await readState()).drafts.find(d=>d.id===id)!;let previous='';
      const tabId=draft.tabId!;
      if(draft.destination==='new'){
        let ready=false;
        for(let attempt=0;attempt<30;attempt++){
          const tab=await chrome.tabs.get(tabId);
          if(platformFor(tab.url)?.id===draft.targetSite){try{previous=await content<string>(tabId,{type:'cw.composer'});ready=true;}catch{}}
          if(ready)break;await new Promise(resolve=>setTimeout(resolve,500));
        }
        if(!ready)throw new Error('新对话尚未就绪，请登录目标平台后重新确认。');
        if(previous.trim())throw new Error('新对话输入框已有内容，请在网页检查后重试。');
      }else{
        const tab=await chrome.tabs.get(tabId);if(platformFor(tab.url)?.id!==draft.targetSite)throw new Error('目标页面已切换，请重新选择发送目标。');
        previous=await content<string>(tabId,{type:'cw.composer'});
        if(expected===undefined||previous!==expected)throw new Error('输入框内容已变化，请重新打开预览并确认。');
      }
      const prompt=mode==='append'&&previous.trim()?previous.trimEnd()+'\n\n'+draft.prompt:draft.prompt;
      await mark(id,{prompt,status:'submitting',error:undefined});draft={...draft,prompt};
      dispatched=true;
      const result=await content<SendResult>(tabId,{type:'cw.send',requestId:id,text:prompt,expectedComposer:previous});
      if(result.status==='failed'){await mark(id,{status:'failed',error:result.error??'发送失败，请重新确认。'});return;}
      if(result.status==='uncertain'){await mark(id,{status:'uncertain',error:'已尝试发送，尚未确认结果。请查看原页面；为避免重复，不会自动重发。'});return;}
      await mutateState(s=>{
        const current=s.drafts.find(d=>d.id===id);if(!current)return s;
        current.sentTurnId=result.turnId;current.targetExternalId=result.snapshot?.externalId;current.error=undefined;if(current.status!=='bound')current.status='sent';
        if(!result.snapshot)return s;
        const snapshot=decorate(s,result.snapshot,tabId);
        let next=updateCaptured(s,snapshot);if(current.destination==='new')next=bindDraft(next,id,snapshot);return next;
      });
      // Re-read metadata after the send result to label the new question immediately.
      if(result.snapshot){const state=await readState();const labeled=decorate(state,result.snapshot,tabId);void content(tabId,{type:'cw.labels',labels:Object.fromEntries(labeled.turns.filter(t=>t.question).map(t=>[t.id,t.question!]))}).catch(()=>undefined);}
      notify();
    }catch(error){await mark(id,{status:dispatched?'uncertain':'failed',error:(error instanceof Error?error.message:'发送失败。')+(dispatched?' 请先检查原页面，插件不会自动重发。':'')});}
    finally{inflight.delete(id);}
  }
  async function recover(){return mutateState(s=>{for(const d of s.drafts)if(!inflight.has(d.id)&&['waiting','submitting'].includes(d.status)){d.status=d.status==='submitting'?'uncertain':'preview';d.error=d.status==='uncertain'?'发送过程已中断，请检查原页面。不会自动重新发送。':undefined;}return s;});}
  async function install(){
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});await recover();
    await chrome.contextMenus.removeAll();for(const [id,title]of [['current','UniFAI：在当前对话追问'],['new','UniFAI：在新对话追问'],['stage','UniFAI：添加到暂存'],['explain','UniFAI：解释所选内容'],['example','UniFAI：举例说明'],['check','UniFAI：检查所选内容']])chrome.contextMenus.create({id:'cw-'+id,title:title!,contexts:['selection']});
  }
  chrome.runtime.onInstalled.addListener(()=>void install());chrome.runtime.onStartup.addListener(()=>void install());
  chrome.tabs.onActivated.addListener(({tabId})=>{chrome.tabs.get(tabId).then(t=>{if(t.url?.startsWith('http'))return chrome.storage.session.set({lastWebTab:tabId});}).then(notify).catch(()=>undefined);});
  chrome.contextMenus.onClicked.addListener((info,tab)=>{
    if(!String(info.menuItemId).startsWith('cw-')||tab?.id===undefined)return;const tabId=tab.id,key=String(info.menuItemId).slice(3);void chrome.sidePanel.open({tabId}).catch(()=>undefined);
    void(async()=>{let selection:SelectionSnapshot={text:info.selectionText??'',title:tab.title??'选中片段',url:info.pageUrl??tab.url??''};if(platformFor(selection.url))try{const captured=await content<SelectionSnapshot>(tabId,{type:'cw.selection'});if(captured.text.trim()===selection.text.trim())selection=captured;}catch{}
      safeUrl(selection.url);if(platformFor(selection.url))try{const snapshot=await content<PageSnapshot>(tabId,{type:"cw.snapshot"});await mutateState(s=>captureSnapshot(s,decorate(s,snapshot,tabId)).state);}catch{}
      if(key==='stage'||key==='snippet'){
        await mutateState(s=>applyCommand(s,{type:'stage.save',item:{id:uid(),source:selectionSource(s,selection),selected:true,createdAt:Date.now()}}));
        await chrome.storage.session.set({lastWebTab:tabId});notify();return;
      }
      const intent:UiIntent={action:['explain','example','check'].includes(key)?key as UiIntent['action']:'followup',destination:key!=='new'&&!!platformFor(selection.url)?'current':'new',selection,tabId,nonce:uid()};await chrome.storage.session.set({intent,lastWebTab:tabId});notify();})().catch(()=>undefined);
  });
  async function handle(command:AppCommand):Promise<unknown>{switch(command.type){
    case 'state.get':return recover();
    case 'page.active':return active();
    case 'page.composer':{const tab=await targetTab(command.tabId);return content(tab.id!,{type:'cw.composer'});}
    case 'page.locate':{const tab=await targetTab(command.tabId), state=await readState();const result=await locatePage(tab.id!,command.turnId,locationFor(state,tab.url??'',command.turnId));if(result!=='found'&&result!=='superseded')throw new Error(navigationFailure(result));return true;}
    case 'page.open': {
      const current=await readState(); const blocked=current.drafts.filter(d=>inflight.has(d.id)&&d.tabId!==undefined).map(d=>d.tabId!);
      let anchor:number|undefined;try{anchor=(await targetTab()).id;}catch{}
      const result=await openPage(safeUrl(command.url),command.mode??current.openMode??'split',anchor,blocked);
      if(!command.turnId&&result.tab.id!==undefined)locating.delete(result.tab.id);
      if(command.turnId&&result.tab.id!==undefined){const found=await locatePage(result.tab.id,command.turnId,locationFor(current,command.url,command.turnId));if(found!=='found'&&found!=='superseded'){result.notice='已打开对话。'+navigationFailure(found);result.noticeLevel='warning';}}
      return result;
    }
    case 'platform.last':return (await chrome.storage.local.get('lastPlatform')).lastPlatform??'deepseek';
    case 'conversation.capture':{
      const tab=await targetTab(command.tabId);if(!tab.id||!tab.url)throw new Error('无法读取当前页面。');let snapshot:PageSnapshot;
      if(platformFor(tab.url)){snapshot=await content(tab.id,{type:'cw.snapshot'});}else snapshot={site:new URL(tab.url).hostname,externalId:tab.url,url:tab.url,title:tab.title??'网页',turns:[],complete:false};
      const next=await mutateState(s=>{const captured=captureSnapshot(s,decorate(s,snapshot,tab.id),command.containerId);const graph=captured.state.graphs?.find(g=>g.id===captured.state.activeGraphId);if(graph&&!graph.conversationIds.includes(captured.conversation.id)){graph.conversationIds.push(captured.conversation.id);graph.updatedAt=Date.now();}return captured.state;});notify();return next;
    }
    case 'draft.save':{const previous=(await readState()).drafts.find(d=>d.id===command.draft.id);if(previous&&(['waiting','submitting','sent','bound','uncertain'].includes(previous.status)||inflight.has(previous.id)))throw new Error('此消息已提交或正在处理，请查看原页面。');break;}
    case 'draft.send':{
      if(inflight.has(command.id))return {pending:true};inflight.add(command.id);
      let accepted=false;
      try{
        const draft=(await readState()).drafts.find(d=>d.id===command.id);if(!draft)throw new Error('草稿不存在。');
        if(!['preview','failed','filled'].includes(draft.status))throw new Error('此消息已提交或正在处理，请查看原页面，避免重复发送。');if(!draft.prompt.trim())throw new Error('请输入问题。');
        accepted=true;
        let tab:chrome.tabs.Tab;let targetSite:PlatformId;
        if(draft.destination==='new'){targetSite=platformById(draft.targetSite).id;const current=await readState();let anchor:number|undefined;try{anchor=(await targetTab(draft.tabId)).id;}catch{}const blocked=current.drafts.filter(d=>d.id!==draft.id&&inflight.has(d.id)&&d.tabId!==undefined).map(d=>d.tabId!);tab=(await openPage('about:blank',draft.openMode??current.openMode??'split',anchor,blocked)).tab;}
        else{tab=await targetTab(command.tabId??draft.tabId);const p=platformFor(tab.url);if(!p)throw new Error('请打开受支持的 AI 对话页面。');targetSite=p.id;}
        await mark(draft.id,{tabId:tab.id,targetSite,status:'waiting',error:undefined});await chrome.storage.local.set({lastPlatform:targetSite});
        if(draft.destination==='new')await chrome.tabs.update(tab.id!,{url:platformById(targetSite).newUrl});
        void executeSend(draft.id,command.mode??'append',command.expectedComposer);return {pending:true};
      }catch(error){inflight.delete(command.id);if(accepted)await mark(command.id,{status:'failed',error:error instanceof Error?error.message:'发送失败'});throw error;}
    }
    case 'settings.get':return (await chrome.storage.local.get('apiSettings')).apiSettings??defaultSettings;
    case 'settings.save':{const s=command.settings,u=new URL(s.endpoint);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new Error('接口须使用 HTTPS，本机服务可使用 HTTP。');if(u.username||u.password||u.hash||s.apiKey.length>10000||s.model.length>500)throw new Error('API 设置无效。');await chrome.storage.local.set({apiSettings:{endpoint:s.endpoint,model:s.model.trim(),apiKey:s.apiKey.trim()}});return true;}
    case 'backup.export':return exportBackup(await readState());
    case 'backup.import':if(inflight.size)throw new Error('请等待当前发送结束后导入备份。');break;
    case 'intent.get':return (await chrome.storage.session.get('intent')).intent??null;
    case 'intent.claim': {
      const claim = intentClaim.then(async()=>{const {intent}=await chrome.storage.session.get('intent');if(intent)await chrome.storage.session.remove('intent');return intent??null;});
      intentClaim=claim.catch(()=>undefined);return claim;
    }
    case 'intent.clear':{const {intent}=await chrome.storage.session.get('intent');if(intent?.nonce===command.nonce)await chrome.storage.session.remove('intent');return true;}
    case 'data.clear':if(inflight.size)throw new Error('请等待当前发送结束后清空数据。');await chrome.storage.local.remove(['apiSettings','lastPlatform']);await chrome.storage.session.remove(['intent','lastWebTab']);break;
  }const next=await mutateState(s=>applyCommand(s,command));notify();return next;}
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||message?.channel!==CHANNEL)return false;
    if(message.event&&sender.tab?.id!==undefined&&platformFor(sender.url)){
      if(message.event.type!=='cw.updated')return false;const snapshot=message.event.snapshot as PageSnapshot,platform=platformFor(sender.url);
      if(!snapshot||snapshot.site!==platform?.id||platformFor(snapshot.url)?.id!==platform.id||!snapshot.externalId||typeof snapshot.externalId!=='string'||!Array.isArray(snapshot.turns)||snapshot.turns.length>50000||snapshot.turns.some(t=>typeof t.id!=='string'||typeof t.user!=='string'||typeof t.assistant!=='string'||t.user.length+t.assistant.length>2000000))return false;
      const tabId=sender.tab.id;
      void mutateState(s=>{const labeled=decorate(s,snapshot,tabId);let next=updateCaptured(s,labeled);for(const d of next.drafts.filter(d=>d.tabId===tabId&&d.targetSite===platform.id&&d.destination==='new'&&['submitting','filled','sent','uncertain'].includes(d.status)))next=bindDraft(next,d.id,labeled);return next;}).then(s=>{const labeled=decorate(s,snapshot,tabId);respond({labels:Object.fromEntries(labeled.turns.filter(t=>t.question).map(t=>[t.id,t.question!]))});notify();}).catch(()=>respond({labels:{}}));return true;
    }
    if(!trustedPage(sender)||!message.command||typeof message.command.type!=='string')return false;
    handle(message.command).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error instanceof Error?error.message:'操作失败，请重试。'}));return true;
  });
});
