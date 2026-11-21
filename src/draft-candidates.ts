import {eligibleMessageRecipient,type MessageRecipient} from './message-intent';
import {personContext} from './person-context';
type CandidateState={accountId?:string;catalog:{recipients:{id:string;name:string;kind:string;active?:boolean;external?:boolean;isContact?:boolean}[]};entries:{query:string;recipientId:string}[]};
/** Cached contacts are suggestions only. Send/edit still require fresh evidence. */
export async function readDraftCandidates(read:()=>Promise<CandidateState>,refresh:(signal?:AbortSignal)=>Promise<MessageRecipient[]>,signal?:AbortSignal):Promise<MessageRecipient[]>{
 signal?.throwIfAborted();const state=await read();signal?.throwIfAborted();
 const candidates=state.catalog.recipients.filter(r=>(r.kind==='person'||r.kind==='group')&&r.active===true&&r.external===false).map(r=>({id:r.id,name:r.name,kind:r.kind as 'person'|'group',active:true,external:false,aliases:state.entries.filter(e=>e.recipientId===r.id).map(e=>e.query),...(r.isContact===false?{isContact:false}:{})})).filter(eligibleMessageRecipient);
 return candidates.length?[...personContext(candidates.filter(r=>r.kind==='person'),state.accountId??'',state.entries).map(p=>({...p,kind:'person' as const})),...candidates.filter(r=>r.kind==='group')]:refresh(signal);
}
