import {createRoot} from 'react-dom/client';
import {App} from './App';
import {isTemporarilyUnavailable} from './cli-bootstrap';
import {dispose,ensureCliBackgroundInstall,getClient,getMessageService,getWorkspaceState,readVoiceMessageContext} from './client';
import {createReportedVoiceWorkflow} from './voice-workflow';
import {createWorkspaceItem} from './workspace-create-service';
import {runWorkspaceVoiceOperation} from './voice-operation-service';
import {confirmVoiceMessage} from './voice-message-confirmation';
import {createMessageNotice} from './message-notice';
import {PreparationError} from './person-context';
import './style.css';
const root=createRoot(document.getElementById('root')!);
root.render(<App/>);
const client=getClient();
const confirmMessageDialog=createMessageNotice((form,options)=>client.notice.present(form,options));
const ensureVoiceEnabled=async(signal:AbortSignal)=>{
  signal.throwIfAborted();
  const state=await getWorkspaceState().read();
  signal.throwIfAborted();
  if(state.config.feishuTools===false){
    throw new PreparationError('飞书语音指令已关闭，请在飞书插件设置中开启后再试');
  }
};
const showMessage=async(draftId:string)=>{
  await client.host.openPlugin();
  window.dispatchEvent(new CustomEvent('feishu-message-draft-ready',{detail:{draftId}}));
};
let voiceReadyTimer:number|undefined;
let voiceDisposed=false;
let voiceReadyRetries=0;
const handleVoiceReadyError=(error:unknown):void=>{
  if(voiceDisposed)return;
  if(isTemporarilyUnavailable(error)&&voiceReadyRetries<3){
    voiceReadyRetries+=1;
    window.clearTimeout(voiceReadyTimer);
    voiceReadyTimer=window.setTimeout(()=>{
      if(voiceDisposed)return;
      void client.request('voice.ready',{}).catch(handleVoiceReadyError);
    },850);
    return;
  }
  window.dispatchEvent(new CustomEvent('feishu-voice-error',{detail:String(error instanceof Error?error.message:error)}));
};
void client.voice.handle(createReportedVoiceWorkflow({
  diagnostic:entry=>{
    if(entry.status==='failed'&&(entry.code==='dependency_not_installed'||entry.causeCodes?.includes('dependency_not_installed'))){
      ensureCliBackgroundInstall();
    }
    console.info('[feishu-voice-stage]',JSON.stringify(entry));
  },
  create:input=>createWorkspaceItem({...input,requireVoiceEnabled:true}),
  progress:(requestId,result)=>client.voice.progress({requestId,result},{timeoutMs:5000}),
  operation:async input=>{
    await ensureVoiceEnabled(input.signal);
    return runWorkspaceVoiceOperation(input);
  },
  prepareMessage:(prompt,signal,attachments)=>getMessageService().prepare({prompt,attachments,requireVoiceEnabled:true},{signal}),
  showMessage,
  confirmMessage:(requestId,draft,signal)=>confirmVoiceMessage({
    context:()=>readVoiceMessageContext(draft.id,signal),
    confirm:input=>confirmMessageDialog(input,signal),
    send:input=>getMessageService().send(input),
    show:showMessage,
  },requestId,draft,signal),
})).catch(handleVoiceReadyError);
window.addEventListener('pagehide',()=>{voiceDisposed=true;window.clearTimeout(voiceReadyTimer);root.unmount();dispose();},{once:true});
