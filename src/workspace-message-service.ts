import {uploadMessageAttachments,validateMessageAttachments} from './message-attachments';
import type {createPluginClient,JsonValue} from '@vitalk/plugin-sdk';
import type {CliAuthStatus} from './cli-auth';
import {createFeishuRuntime} from './feishu-runtime';
import {createIntentModel} from './intent-model';
import {createMessageWorkflow,type MessageDraft} from './message-workflow';
import type {MessageRecipient} from './message-intent';
import {MessageNotSubmittedError} from './person-context';
import type {FeishuMessageDraft} from './original-workspace/FeishuMessagePanel';
type Request=ReturnType<typeof createPluginClient>['request'];
type Params=Record<string,unknown>;
type WorkspaceMessageServiceOptions={
 readAllRecipients?:(signal?:AbortSignal,verifiedAccount?:CliAuthStatus)=>Promise<MessageRecipient[]>;
 readRecipient?:(id:string,signal?:AbortSignal,verifiedAccount?:CliAuthStatus,skipPostAccountCheck?:boolean)=>Promise<MessageRecipient|undefined>;
 readDraftRecipients?:(signal?:AbortSignal,verifiedAccount?:CliAuthStatus)=>Promise<MessageRecipient[]>;
 readRecipients:(signal?:AbortSignal,verifiedAccount?:CliAuthStatus)=>Promise<MessageRecipient[]>;
 searchRecipients?:(query:string,signal?:AbortSignal,verifiedAccount?:CliAuthStatus)=>Promise<MessageRecipient[]>;
 readPreference:(signal?:AbortSignal,verifiedAccount?:CliAuthStatus,requireVoiceEnabled?:boolean)=>Promise<string>;
 onDraftPrepared?:(draftId:string,accountId:string)=>void;
};
/** One instance per plugin session, shared by voice and workspace confirmation.
 * The caller supplies fresh contact evidence with the user's aliases/corrections.
 * Do not pass legacy host-owned drafts into this plugin-owned store. */
export function createWorkspaceMessageService(request:Request,options:WorkspaceMessageServiceOptions){
 const runtime=createFeishuRuntime((m,p,o)=>request(m,p,o));
 const save=async(key:string,value:unknown,req:Request=request)=>{const result=await req('storage.set',{key,value:value as JsonValue});if(result.ok!==true)throw Error('消息草稿保存失败，未确认操作结果');};
 const load=async(id:string,req:Request=request)=>{
  if(!/^[0-9a-f-]{36}$/i.test(id))throw new MessageNotSubmittedError('消息草稿标识无效');
  return (await req('storage.get',{key:`message-draft.${id}`})).value as unknown as MessageDraft|undefined;
 };
 function buildWorkflow(req:Request=request,signal?:AbortSignal,skipRecipientPostCheck=false){
  const localRuntime=createFeishuRuntime((m,p,o)=>req(m,p,o));
  let verified:CliAuthStatus|undefined;
  const readAccount=async()=>{const account=await localRuntime.readAccount();verified=account;return account;};
  const workflow=createMessageWorkflow({
   contentArgs:async(d,check)=>{if(d.attachments?.length){const a=await readAccount();if(a.accountId!==d.accountId||!a.scopes.includes('im:resource'))throw Error('飞书缺少图片权限，请重新授权');}return uploadMessageAttachments(req,localRuntime.cli,d.id,d.content,d.attachments??[],check);},
   cli:localRuntime.cli,
   readAccount,
   readRecipient:options.readRecipient?id=>options.readRecipient!(id,signal,verified,skipRecipientPostCheck):undefined,
   readAllRecipients:options.readAllRecipients?()=>options.readAllRecipients!(signal,verified):undefined,
   readRecipients:()=>options.readRecipients(signal,verified),
   readDraftRecipients:options.readDraftRecipients?()=>options.readDraftRecipients!(signal,verified):undefined,
   searchRecipients:options.searchRecipients?query=>options.searchRecipients!(query,signal,verified):undefined,
   model:createIntentModel(p=>req('ai.generate',p,{timeoutMs:120000})),
   store:{read:id=>load(id,req),write:d=>save(`message-draft.${d.id}`,d,req)},
  });
  return {workflow,localRuntime,getVerified:()=>verified};
 }
 const dto=(d:MessageDraft):FeishuMessageDraft=>({id:d.id,awaitingRecipient:d.awaitingRecipient,recipientQuery:d.recipientQuery,recipientCandidates:d.recipientCandidates,attachments:d.attachments,prompt:d.prompt,content:d.content,recipient:d.recipient,status:d.status==='cancelled'?'unknown':d.status,receipt:d.messageId,error:d.status==='unknown'?(d.recipientScope==='allContacts'?`已确认 ${Object.keys(d.messageIds??{}).length}/${d.recipientIds?.length??0} 人发送成功，其余结果待核实；不会自动重发。`:'发送结果待核实，请在飞书确认，勿重复发送。'):undefined});
 function attachmentSelection(p:Params,d:MessageDraft){if(p.attachmentIds===undefined)return d.attachments??[];if(!Array.isArray(p.attachmentIds)||new Set(p.attachmentIds).size!==p.attachmentIds.length||p.attachmentIds.some(id=>!d.attachments?.some(a=>a.id===id)))throw new MessageNotSubmittedError('图片必须来自当前草稿');return (d.attachments??[]).filter(a=>(p.attachmentIds as unknown[]).includes(a.id));}
 return {
  async read(verifiedAccount?:CliAuthStatus){const id=(await request('storage.get',{key:'message-latest-draft'})).value;if(typeof id!=='string')return null;const d=await load(id);if(!d||d.status==='cancelled')return null;const account=verifiedAccount??await runtime.readAccount();return d.accountId===account.accountId?dto(d):null;},
  async prepare(p:Params,execution:{signal?:AbortSignal}={}):Promise<FeishuMessageDraft>{
   const signal=execution.signal;
   signal?.throwIfAborted();
   const scoped:Request=signal?(m,params,o)=>{signal.throwIfAborted();return request(m,params,{...o,signal});}:request;
   const {workflow,localRuntime,getVerified}=buildWorkflow(scoped,signal,false);
   let attachments=validateMessageAttachments(p.attachments);
   if(p.sourceDraftId||p.recipientSourceDraftId){
    const source=await load(String(p.sourceDraftId??p.recipientSourceDraftId),scoped);
    const account=await localRuntime.readAccount();
    if(!source||source.accountId!==account.accountId||source.status!=='ready')throw new MessageNotSubmittedError('只有当前账号待确认草稿可以重新生成');
    if(p.attachments===undefined)attachments=attachmentSelection(p,source);
    if(p.recipientSourceDraftId){if(typeof p.recipientId!=='string')throw new MessageNotSubmittedError('请选择联系人');return dto(await workflow.edit(source.id,{recipientId:p.recipientId,content:source.content}));}
   }
   if(typeof p.prompt!=='string')throw new MessageNotSubmittedError('请输入消息内容');
   const d=await workflow.prepare(p.prompt,()=>options.readPreference(signal,getVerified(),p.requireVoiceEnabled===true),attachments);
   await save('message-latest-draft',d.id,scoped);
   options.onDraftPrepared?.(d.id,d.accountId);
   return dto(d);
  },
  async send(p:Params){if(typeof p.id!=='string'||typeof p.content!=='string')throw new MessageNotSubmittedError('消息草稿参数无效');const existing=await load(p.id);if(!existing)throw new MessageNotSubmittedError('图片或消息草稿不存在');const attachments=attachmentSelection(p,existing);return dto(await buildWorkflow(request,undefined,true).workflow.confirm(p.id,{content:p.content,attachments,recipientId:typeof p.recipientId==='string'?p.recipientId:undefined}));},
  async dismiss(p:Params){if(typeof p.id!=='string')throw Error('消息草稿标识无效');const existing=await load(p.id);const account=await runtime.readAccount();if(!existing||existing.accountId!==account.accountId)throw Error('草稿所属账号已变化或草稿不存在');if(existing.status==='ready')await buildWorkflow().workflow.cancel(p.id);const latest=(await request('storage.get',{key:'message-latest-draft'})).value;if(latest===p.id)await save('message-latest-draft',null);return {ok:true};},
  async recall(p:Params){if(typeof p.id!=='string')throw Error('消息草稿标识无效');return dto(await buildWorkflow().workflow.recall(p.id,p.confirmed===true));},
 };
}

