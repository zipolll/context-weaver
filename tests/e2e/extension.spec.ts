import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Optional full-browser smoke test. All AI requests are replaced with local HTML.
test('library, question directory and one explicitly confirmed new-chat send', async () => {
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'context-weaver-e2e-'));
  const extensionPath=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args:['--disable-extensions-except='+extensionPath,'--load-extension='+extensionPath],
    viewport:{width:1280,height:900},
  });
  try{
    const fixture=fs.readFileSync(path.resolve('tests/fixtures/deepseek.html'),'utf8');
    const submitScript=`<script>window.submitCount=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submitCount++;const text=document.querySelector('textarea').value;if(location.pathname==='/')history.pushState({},'','/a/chat/s/new-chat');const user=document.createElement('div');user.setAttribute('data-role','user');user.setAttribute('data-message-id','sent-'+window.submitCount);user.textContent=text;document.querySelector('main').append(user);document.querySelector('textarea').value='';});</script>`;
    await context.route('https://chat.deepseek.com/**',route=>{
      const isNew=new URL(route.request().url()).pathname==='/';
      const html=isNew?'<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek</title></head><body><main></main><form><textarea id="chat-input"></textarea><button data-testid="send-button" type="submit">发送</button></form></body></html>':fixture.replace('<button type="submit">','<button data-testid="send-button" type="submit">');
      return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html.replace('</body>',submitScript+'</body>')});
    });
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    const site=await context.newPage();await site.goto('https://chat.deepseek.com/a/chat/s/source');
    const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://chat.deepseek.com/a/chat/s/source'}))[0]!.id!);
    await worker.evaluate(async id=>chrome.storage.session.set({lastWebTab:id}),tabId);
    const ui=await context.newPage();await ui.goto('chrome-extension://'+new URL(worker.url()).host+'/sidepanel.html');
    async function command(c:object):Promise<any>{const reply=await ui.evaluate(async cmd=>chrome.runtime.sendMessage({channel:'context-weaver',command:cmd}),c);expect(reply.ok,reply.error).toBe(true);return reply.data;}
    await ui.getByRole('button',{name:'收纳当前对话',exact:true}).click();
    await expect(ui.locator('.conversation-title')).toHaveText('线性代数');
    const rail=site.locator('#context-weaver-question-rail');await expect(rail.locator('nav button')).toHaveCount(2);
    await rail.locator('nav button').last().click();await expect(site.locator('[data-virtual-list-item-key="u2"] .fbb737a4')).toHaveCSS('outline-style','solid');
    expect(await site.evaluate(()=>(window as any).submitCount)).toBe(0);
    const state=await command({type:'state.get'}),conversation=state.conversations[0];
    const draft={id:'smoke-send',question:'为什么方向不变？',action:'followup',templateId:'followup',prompt:'请解释为什么方向不变。',destination:'new',targetSite:'deepseek',status:'preview',createdAt:Date.now(),sources:[{id:'source',conversationId:conversation.id,title:conversation.title,url:conversation.url,turnIds:[conversation.turns[0].id],text:'冻结的来源文本',capturedAt:Date.now()}]};
    await command({type:'draft.save',draft});
    await Promise.all([command({type:'draft.send',id:draft.id}),command({type:'draft.send',id:draft.id})]);
    await expect.poll(async()=> (await command({type:'state.get'})).drafts.find((d:any)=>d.id===draft.id).status).toBe('bound');
    const next=await command({type:'state.get'});expect(next.relations).toHaveLength(1);expect(next.conversations).toHaveLength(2);
    const target=context.pages().find(p=>p.url().endsWith('/a/chat/s/new-chat'))!;expect(await target.evaluate(()=>(window as any).submitCount)).toBe(1);
    // Wait for the explicit command to finish persisting before importing a backup.
    await expect(ui.locator('.pending-status')).toHaveCount(0);
  }finally{
    await context.close();fs.rmSync(profile,{recursive:true,force:true});
  }
});
