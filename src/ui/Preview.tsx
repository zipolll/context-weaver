import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Minimize2, Trash2, X } from 'lucide-react';
import type { Action, ActivePage, ApiSettings, AppState, Draft, SourceSnapshot } from '../core/types';
import { ACTION_LABELS, renderPrompt, uid } from '../core/context';
import { request } from '../core/client';
import { compressContext } from '../core/compression';
import { ensureApiPermission } from './Settings';
import { PLATFORMS, platformName, type PlatformId } from '../adapters/platforms';
export function Preview({initial,state,currentPage,close,report:reportParent,refresh}:{initial:Draft;state:AppState;currentPage:ActivePage|null;close:()=>void;report:(text:string)=>void;refresh:()=>Promise<void>}){
  const [localError,setLocalError]=useState(''),[draft,setDraft]=useState(initial),[sources,setSources]=useState<SourceSnapshot[]>(structuredClone(initial.editedSources??initial.sources));
  const [prompt,setPrompt]=useState(initial.prompt),[previous,setPrevious]=useState(''),[mode,setMode]=useState<'append'|'replace'>('append'),[composerReady,setComposerReady]=useState(initial.destination!=='current');
  const [busy,setBusy]=useState(false),[compressionOpen,setCompressionOpen]=useState(false),[compressing,setCompressing]=useState(false),[summary,setSummary]=useState(''),[settings,setSettings]=useState<ApiSettings|null>(null),[status,setStatus]=useState('');
  const abort=useRef<AbortController|null>(null),lastComposed=useRef<string|null>(null),saveLock=useRef(false);
  const report=(text:string)=>{setLocalError(text);reportParent(text);};
  const template=state.templates.find(t=>t.id===draft.templateId)??state.templates[0]!;
  const composed=renderPrompt(template,draft.question,sources,draft.action);
  const record=state.drafts.find(d=>d.id===draft.id)??draft;
  const locked=['waiting','submitting','sent','bound','uncertain'].includes(record.status);
  const tabId=draft.tabId??(currentPage?.supported?currentPage.tabId:undefined);
  useEffect(()=>{if(lastComposed.current===null){lastComposed.current=composed;if(!initial.prompt)setPrompt(composed);}else if(lastComposed.current!==composed){lastComposed.current=composed;setPrompt(composed);setSummary('');}},[composed]);
  useEffect(()=>{request<ApiSettings>({type:'settings.get'}).then(setSettings).catch(e=>report(e.message));return()=>abort.current?.abort();},[]);
  useEffect(()=>{let cancelled=false;if(draft.destination==='current'){setComposerReady(false);request<string>({type:'page.composer',tabId}).then(text=>{if(!cancelled){setPrevious(text);setComposerReady(true);}}).catch(e=>{if(!cancelled)report(e.message);});}else{setPrevious('');setComposerReady(true);}return()=>{cancelled=true;};},[draft.destination,tabId]);
  async function save(send:boolean){
    if(saveLock.current||locked)return;saveLock.current=true;setBusy(true);setLocalError('');setStatus('');
    try{
      if(send&&draft.destination==='current'){const current=await request<string>({type:'page.composer',tabId});if(current!==previous){setPrevious(current);throw new Error('原页面输入已变化，合并内容已更新，请再次确认。');}}
      const retry=record.status==='failed';
      const next:Draft={...draft,id:retry?uid():draft.id,tabId,destination:draft.destination,targetSite:draft.destination==='current'?currentPage?.site??draft.targetSite:draft.targetSite??currentPage?.site??'deepseek',prompt,sources:sources.map(s=>initial.sources.find(original=>original.id===s.id)??s),editedSources:structuredClone(sources),status:'preview',error:undefined};
      await request({type:'draft.save',draft:next});setDraft(next);
      if(send){await request({type:'draft.send',id:next.id,mode,tabId:next.tabId,expectedComposer:previous});setStatus('正在发送…');}
      else setStatus('草稿已保存。');await refresh();
    }catch(e){report((e as Error).message);}finally{saveLock.current=false;setBusy(false);}
  }
  async function compress(){if(!settings)return;setCompressing(true);abort.current=new AbortController();try{await ensureApiPermission(settings.endpoint);const text=sources.map((s,i)=>'['+(i+1)+'] '+s.title+'\n'+s.text+'\n来源：'+s.url).join('\n\n');setSummary(await compressContext(settings,text,abort.current.signal));}catch(e){report((e as Error).message);}finally{setCompressing(false);}}
  const mergedPrompt=previous.trim()&&mode==='append'&&draft.destination==='current'?previous.trimEnd()+'\n\n'+prompt:prompt;
  const statusText=({waiting:'正在打开目标页面…',submitting:'正在发送…',sent:'已发送。',bound:'已发送，并记录上下文来源。',uncertain:'已尝试发送，请查看原页面确认结果。为避免重复，插件不会自动重发。',failed:record.error??'未发送，请检查后重试。'} as Partial<Record<Draft['status'],string>>)[record.status]??status;
  const changeSource=(index:number,text:string)=>setSources(sources.map((s,i)=>i===index?{...s,text}:s));
  function move(index:number,direction:number){const next=[...sources],item=next.splice(index,1)[0]!;next.splice(index+direction,0,item);setSources(next);}
  return <div className="modal-backdrop"><section className="preview" role="dialog" aria-modal="true" aria-labelledby="preview-title"><header className="modal-header"><h2 id="preview-title">{ACTION_LABELS[draft.action]}</h2><button className="icon" aria-label="关闭追问" onClick={close}><X size={20}/></button></header>
    <div className="preview-content">{localError&&<div className="banner error" role="alert">{localError}</div>}
      <label>你的问题<textarea autoFocus rows={4} disabled={locked} value={draft.question} onChange={e=>setDraft({...draft,question:e.target.value})} placeholder="想继续了解什么？"/></label>
      {sources.length>0&&<div className="source-summary"><strong>引用 {sources.length} 个来源</strong><span>{sources.map(s=>s.title).join('、')}</span></div>}
      <label>发送到<select disabled={locked} value={draft.destination==='current'?'current':draft.targetSite??'deepseek'} onChange={e=>setDraft({...draft,destination:e.target.value==='current'?'current':'new',targetSite:e.target.value==='current'?currentPage?.site:e.target.value as PlatformId})}>{tabId!==undefined&&<option value="current">当前 {platformName(currentPage?.site??draft.targetSite??'deepseek')} 对话</option>}{PLATFORMS.map(p=><option key={p.id} value={p.id}>{p.name} 新对话</option>)}</select></label>
      {draft.destination==='new'&&<label>打开方式<select disabled={locked} value={draft.openMode??state.openMode??'split'} onChange={e=>setDraft({...draft,openMode:e.target.value as 'split'|'tab'})}><option value="split">Chrome 分栏（默认）</option><option value="tab">新标签页</option></select></label>}
      {draft.destination==='current'&&previous.trim()&&<div className="notice existing-input"><strong>输入框已有文字，请确认实际发送内容</strong><div className="row wrap"><label className="checkbox-label"><input type="radio" disabled={locked} checked={mode==='append'} onChange={()=>setMode('append')}/>保留并追加</label><label className="checkbox-label"><input type="radio" disabled={locked} checked={mode==='replace'} onChange={()=>setMode('replace')}/>替换</label></div><pre>{mergedPrompt}</pre></div>}
      <details className="advanced-options"><summary>高级选项</summary><fieldset disabled={locked}>
        <div className="two-columns"><label>追问方式<select value={draft.action} onChange={e=>{const action=e.target.value as Action;setDraft({...draft,action,templateId:state.templates.find(t=>t.action===action)?.id??draft.templateId});}}>{Object.entries(ACTION_LABELS).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>提示词模板<select value={draft.templateId} onChange={e=>setDraft({...draft,templateId:e.target.value})}>{state.templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
        <div className="section-heading"><h3>引用内容</h3><button className="text-button" disabled={!sources.length} onClick={()=>setCompressionOpen(!compressionOpen)}><Minimize2 size={14}/>压缩</button></div>
        {sources.map((s,i)=>{const available=initial.sources.find(x=>x.id===s.id)?.turns??[];return <details className="source-block" key={s.id}><summary>{s.title}<span className="muted">　{s.text.length.toLocaleString()} 字</span></summary><div className="source-body"><p className="source-url">{s.url}</p><div className="row"><button className="icon small" disabled={i===0} aria-label="来源上移" onClick={()=>move(i,-1)}><ArrowUp size={14}/></button><button className="icon small" disabled={i===sources.length-1} aria-label="来源下移" onClick={()=>move(i,1)}><ArrowDown size={14}/></button><button className="text-button danger" onClick={()=>setSources(sources.filter(x=>x.id!==s.id))}><Trash2 size={13}/>移除</button></div>{available.length>0&&<details><summary>按轮次选择</summary>{available.map(t=><label className="checkbox-label" key={t.id}><input type="checkbox" checked={s.turnIds.includes(t.id)} onChange={e=>{const ids=e.target.checked?[...s.turnIds,t.id]:s.turnIds.filter(id=>id!==t.id);setSources(sources.map((item,j)=>j===i?{...item,turnIds:ids,text:available.filter(turn=>ids.includes(turn.id)).map(turn=>'用户：'+turn.user+'\n助手：'+turn.assistant).join('\n\n')}:item));}}/>{t.question??t.user.slice(0,80)}</label>)}</details>}<textarea aria-label={'编辑引用 '+s.title} rows={5} value={s.text} onChange={e=>changeSource(i,e.target.value)}/></div></details>;})}
        {compressionOpen&&<section className="compression-box"><h3>压缩引用内容</h3><p>确认将引用文本与链接发送至 {settings?(()=>{try{return new URL(settings.endpoint).host;}catch{return '未配置接口';}})():'未配置接口'}。</p><div className="row"><button disabled={compressing||!sources.length} onClick={()=>void compress()}>{compressing?'压缩中…':'确认压缩'}</button>{compressing&&<button onClick={()=>abort.current?.abort()}>取消</button>}</div>{summary&&<><label>摘要<textarea rows={5} value={summary} onChange={e=>setSummary(e.target.value)}/></label><button onClick={()=>setPrompt(renderPrompt(template,draft.question,[{...sources[0]!,text:summary}],draft.action)+'\n\n原始来源：\n'+sources.map(s=>s.url).join('\n'))}>采用摘要</button><button onClick={()=>{setPrompt(composed);setSummary('');}}>撤销压缩</button></>}</section>}
        <label>完整提示词<textarea className="prompt-editor" rows={8} value={prompt} onChange={e=>setPrompt(e.target.value)}/></label><button className="text-button" onClick={()=>void navigator.clipboard.writeText(mergedPrompt).then(()=>setStatus('已复制。')).catch(()=>report('复制失败。'))}><Copy size={14}/>复制发送内容</button>
      </fieldset></details>
      {statusText&&<div className={record.status==='failed'||record.status==='uncertain'?'notice':'success'} role="status">{statusText}</div>}
    </div><footer className="preview-footer"><button disabled={busy||locked} onClick={()=>void save(false)}>保存草稿</button><button className="primary" disabled={busy||locked||!composerReady||!prompt.trim()||(!draft.question.trim()&&!sources.length)} onClick={()=>void save(true)}>{['waiting','submitting'].includes(record.status)||busy?'发送中…':['sent','bound'].includes(record.status)?'已发送':'发送'}</button></footer>
  </section></div>;
}
