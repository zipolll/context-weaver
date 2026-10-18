import { defineContentScript } from 'wxt/utils/define-content-script';
import { adapterFor } from '../src/adapters';
import { PLATFORM_MATCHES } from '../src/adapters/platforms';
import { createSendController } from '../src/adapters/send';
import { mountQuestionRail } from '../src/ui/QuestionRail';
import { CHANNEL, type ContentCommand, type Reply, type SelectionSnapshot } from '../src/core/types';
export default defineContentScript({matches:PLATFORM_MATCHES,runAt:'document_idle',main(ctx){
  const adapter=adapterFor(location.href);if(!adapter)return;
  const rail=mountQuestionRail(adapter),send=createSendController(adapter);
  let lastSelection:SelectionSnapshot|undefined,lastSnapshot='',lastUrl=location.href,timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
  const publish=async()=>{timer=undefined;if(disposed)return;rail.refresh();try{const snapshot=adapter.readSnapshot();const key=JSON.stringify(snapshot);if(key!==lastSnapshot){lastSnapshot=key;const response=await chrome.runtime.sendMessage({channel:CHANNEL,event:{type:'cw.updated',snapshot}});if(!disposed&&lastUrl===location.href&&key===lastSnapshot&&response?.labels)rail.refresh(response.labels);}}catch{}};
  const schedule=()=>{if(!timer&&!disposed)timer=setTimeout(()=>void publish(),400);};
  const selectionChanged=()=>{const selection=adapter.readSelection();if(selection.text)lastSelection=selection;};
  const listener=(message:unknown,sender:chrome.runtime.MessageSender,respond:(reply:Reply)=>void)=>{
    if(sender.id!==chrome.runtime.id||!message||typeof message!=='object')return false;
    const envelope=message as {channel?:string;command?:ContentCommand};if(envelope.channel!==CHANNEL||!envelope.command)return false;
    const command=envelope.command;
    void (async()=>{switch(command.type){
      case 'cw.labels':rail.refresh(command.labels);return true;
      case 'cw.snapshot':return adapter.readSnapshot();case 'cw.composer':return adapter.readComposer();
      case 'cw.fill':if(typeof command.text!=='string'||!['append','replace'].includes(command.mode))throw new Error('无效输入请求。');adapter.fillComposer(command.text,command.mode);return true;
      case 'cw.send':if(typeof command.requestId!=='string'||typeof command.text!=='string'||typeof command.expectedComposer!=='string')throw new Error('无效发送请求。');try{return await send(command.requestId,command.text,command.expectedComposer);}catch(error){return {status:'failed',error:error instanceof Error?error.message:'发送失败'};}
      case 'cw.locate':return adapter.locateTurn(command.turnId);
      case 'cw.selection':{const current=adapter.readSelection();return current.text?current:lastSelection?.url===location.href?lastSelection:current;}
    }})().then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error instanceof Error?error.message:'页面操作失败。'}));return true;
  };
  chrome.runtime.onMessage.addListener(listener);for(const event of ['mouseup','contextmenu','keyup'])document.addEventListener(event,selectionChanged);
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-message-id','aria-hidden','hidden']});
  const routeTimer=setInterval(()=>{if(location.href!==lastUrl){lastUrl=location.href;lastSnapshot='';lastSelection=undefined;rail.refresh({});schedule();}},600);
  window.addEventListener('popstate',schedule);schedule();
  ctx.onInvalidated(()=>{disposed=true;if(timer)clearTimeout(timer);clearInterval(routeTimer);observer.disconnect();rail.destroy();chrome.runtime.onMessage.removeListener(listener);for(const event of ['mouseup','contextmenu','keyup'])document.removeEventListener(event,selectionChanged);window.removeEventListener('popstate',schedule);});
}});
