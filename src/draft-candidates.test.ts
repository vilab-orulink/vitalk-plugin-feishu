import {expect,it,vi} from 'vitest';
import {readDraftCandidates} from './draft-candidates';
it('uses qualified cached candidates and current aliases without a directory sync',async()=>{
 const refresh=vi.fn();const read=async()=>({catalog:{recipients:[{id:'ou_bing',name:'小冰',kind:'person',active:true,external:false}]},entries:[{query:'冰哥',recipientId:'ou_bing'}]});
 expect(await readDraftCandidates(read,refresh)).toEqual([{id:'ou_bing',name:'小冰',kind:'person',active:true,external:false,aliases:['冰哥']}]);expect(refresh).not.toHaveBeenCalled();
});
it('refreshes unqualified legacy caches and stops on cancellation',async()=>{
 const refresh=vi.fn().mockResolvedValue([]);const read=async()=>({catalog:{recipients:[{id:'ou_old',name:'旧联系人',kind:'person'}]},entries:[]});
 await readDraftCandidates(read,refresh);expect(refresh).toHaveBeenCalledTimes(1);
 const c=new AbortController();c.abort();await expect(readDraftCandidates(read,refresh,c.signal)).rejects.toThrow();expect(refresh).toHaveBeenCalledTimes(1);
});
it('strips UI-only fields while preserving required candidate fields',async()=>{
 const refresh=vi.fn();
 const read=async()=>({accountId:'ou_me',catalog:{recipients:[{id:'ou_me',name:'本人',kind:'person',active:true,external:false,isContact:false,avatarUrl:'https://example.com/a.png',detail:'部门A'},{id:'oc_team',name:'研发群',kind:'group',active:true,external:false,avatarUrl:'https://example.com/g.png',detail:'群聊'}]},entries:[{query:'小群',recipientId:'oc_team'}]});
 const candidates=await readDraftCandidates(read,refresh);
 expect(candidates).toEqual([
  {id:'ou_me',name:'本人',kind:'person',active:true,external:false,isContact:false,aliases:['我','自己','本人','我自己','我本人']},
  {id:'oc_team',name:'研发群',kind:'group',active:true,external:false,aliases:['小群']},
 ]);
 for(const c of candidates){
  expect(c).not.toHaveProperty('avatarUrl');
  expect(c).not.toHaveProperty('detail');
 }
});
