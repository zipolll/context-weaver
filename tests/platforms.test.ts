import { describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter } from '../src/adapters/chatgpt';
import { GeminiAdapter } from '../src/adapters/gemini';
import { DeepSeekAdapter } from '../src/adapters/deepseek';
import { platformFor, PLATFORM_MATCHES } from '../src/adapters/platforms';
import { createSendController } from '../src/adapters/send';
import { questionTitle } from '../src/core/questions';
import { createInitialState, validateBackup, bindDraft, applyCommand } from '../src/core/state';
import { renderPrompt } from '../src/core/context';
import type { Draft } from '../src/core/types';
import type { SiteAdapter } from '../src/adapters/types';

const fixtures: { id:string; url:string; make:()=>SiteAdapter; html:string }[] = [
  { id:'deepseek', url:'https://chat.deepseek.com/a/chat/s/test', make:()=>new DeepSeekAdapter(document,()=>fixtures[0]!.url), html:'<div data-message-author-role="user" data-message-id="u1">问题一</div><div data-message-author-role="assistant">答案一</div><textarea id="chat-input"></textarea><button data-testid="send-button">发送</button>' },
  { id:'chatgpt', url:'https://chatgpt.com/c/test', make:()=>new ChatGPTAdapter(document,()=>fixtures[1]!.url), html:'<div data-message-author-role="user" data-message-id="u1">问题一</div><div data-message-author-role="assistant"><p>答案一</p><details>隐藏思考</details><button>复制</button></div><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">发送</button>' },
  { id:'gemini', url:'https://gemini.google.com/app/test', make:()=>new GeminiAdapter(document,()=>fixtures[2]!.url), html:'<user-query id="user-query-1"><div class="query-text">问题一</div></user-query><model-response><message-content><p>答案一</p><model-thoughts>隐藏思考</model-thoughts></message-content></model-response><rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea><button class="send-button">发送</button>' },
];
describe('registered platforms',()=>{
  it('limits automatic access to the three HTTPS origins',()=>{
    expect(PLATFORM_MATCHES).toHaveLength(3);
    for(const f of fixtures) expect(platformFor(f.url)?.id).toBe(f.id);
    for(const url of ['http://chatgpt.com/c/1','https://chatgpt.com.evil.test','https://example.com'])expect(platformFor(url)).toBeUndefined();
  });
  for(const f of fixtures) it(f.id+' extracts, locates and submits only the confirmed content',()=>{
    document.body.innerHTML='<aside><a href="'+f.url+'"><span class="conversation-title">网页侧栏的真实对话标题</span><button title="更多">操作</button></a></aside>'+f.html;const adapter=f.make();const snapshot=adapter.readSnapshot();
    expect(snapshot.title).toBe('网页侧栏的真实对话标题');
    expect(snapshot.turns).toHaveLength(1);expect(snapshot.turns[0]).toMatchObject({user:'问题一',assistant:'答案一'});
    const anchor=adapter.navigationAnchors()[0]!;anchor.element.scrollIntoView=vi.fn();expect(adapter.locateTurn(anchor.turnId)).toBe(true);expect(anchor.element.scrollIntoView).toHaveBeenCalledOnce();
    const range=document.createRange();range.selectNodeContents(anchor.element);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);expect(adapter.readSelection()).toMatchObject({text:'问题一',turnId:anchor.turnId});
    const button=[...document.querySelectorAll('button')].at(-1)!;
    const click=vi.fn();button.addEventListener('click',click);
    adapter.fillComposer('继续提问','replace');expect(click).not.toHaveBeenCalled();
    expect(()=>adapter.submitComposer('其他内容')).toThrow('变化');expect(click).not.toHaveBeenCalled();
    adapter.submitComposer('继续提问');expect(click).toHaveBeenCalledOnce();
    button.setAttribute('disabled','');expect(adapter.composerState()).toBe('unavailable');
  });
});
describe('send confirmation and deduplication',()=>{
  function setup(render=true){
    document.body.innerHTML=fixtures[0]!.html;const adapter=fixtures[0]!.make();let clock=0;
    const send=createSendController(adapter,()=>fixtures[0]!.url,async ms=>{clock+=ms;},()=>clock);
    const clicks=vi.fn(()=>{if(render){const message=document.createElement('div');message.setAttribute('data-message-author-role','user');message.setAttribute('data-message-id','new');message.textContent=adapter.readComposer();document.body.append(message);}});
    document.querySelector('button')!.addEventListener('click',clicks);return {send,adapter,clicks};
  }
  it('a double click shares one result and confirms the new user message',async()=>{
    const {send,clicks}=setup();const first=send('request','确认后的问题','');const duplicate=send('request','确认后的问题','');
    expect(duplicate).toBe(first);expect(await first).toMatchObject({status:'sent',turnId:'test:message:new'});expect(clicks).toHaveBeenCalledOnce();
  });
  it('stops when the input has changed since confirmation',async()=>{
    const {send,adapter,clicks}=setup();adapter.fillComposer('新的手写内容','replace');await expect(send('request','问题','')).rejects.toThrow('变化');expect(clicks).not.toHaveBeenCalled();expect(adapter.readComposer()).toBe('新的手写内容');
  });
  it('keeps an uncertain result without clicking again',async()=>{
    const {send,clicks}=setup(false);expect(await send('request','问题','')).toEqual({status:'uncertain'});expect(await send('request','问题','')).toEqual({status:'uncertain'});expect(clicks).toHaveBeenCalledOnce();
  });
});
describe('question labels and compatible drafts',()=>{
  const state=createInitialState(),prompt=renderPrompt(state.templates[0]!,'实际的问题',[],'followup');
  const draft:Draft={id:'test',question:'实际的问题',prompt,action:'followup',templateId:'followup',sources:[],destination:'new',status:'preview',createdAt:1};
  it('uses saved questions and removes only the recognized legacy wrapper',()=>{
    expect(questionTitle(prompt,'保存的真实问题')).toBe('保存的真实问题');expect(questionTitle(prompt)).toBe('实际的问题');
    expect(questionTitle('任务：整理资料\n用户问题：你好')).toBe('任务：整理资料\n用户问题：你好');
  });
  it('reads old drafts, preserves new metadata and resets imported sends',()=>{
    const old=validateBackup({...state,drafts:[draft]});expect(old.drafts[0]!.targetSite).toBeUndefined();
    const current=validateBackup({...state,drafts:[{...draft,targetSite:'gemini',status:'submitting'}]});expect(current.drafts[0]!.targetSite).toBe('gemini');
    const imported=applyCommand(state,{type:'backup.import',data:current});expect(imported.drafts[0]!.status).toBe('preview');
  });
  it('binds provenance while submission is still waiting for acknowledgment',()=>{
    const current={...state,drafts:[{...draft,targetSite:'gemini' as const,status:'submitting' as const}]};
    const snapshot={site:'gemini',externalId:'new',url:'https://gemini.google.com/app/new',title:'问题',turns:[{id:'new:1',user:prompt,assistant:'',index:0,fingerprint:'x'}],complete:false};
    const bound=bindDraft(current,'test',snapshot);expect(bound.drafts[0]).toMatchObject({status:'bound',sentTurnId:'new:1'});expect(bindDraft(bound,'test',snapshot)).toBe(bound);
  });
});
