import {expect,it,vi} from 'vitest';
import {createReportedVoiceWorkflow} from './voice-workflow';
import {CliNotAuthenticatedError} from './cli-auth';
import {createIntentModel} from './intent-model';
import {runCalendarCreation} from './calendar-workflow';
import {runTaskCreation} from './task-workflow';
import {PreparationError} from './person-context';
it('reports a rejected task plan as not submitted and explains the actual controlled reason',async()=>{
 const run=createReportedVoiceWorkflow({prepareMessage:vi.fn(),create:vi.fn().mockRejectedValue(new PreparationError('任务负责人未能确定')),showMessage:vi.fn()});
 const result=await run({requestId:'r',actionId:'task',transcript:'给小冰创一个任务',sessionId:'s'},new AbortController().signal);
 expect(result.text).toContain('任务负责人未能确定');expect(result.text).toContain('未执行发送或创建');expect(result.text).not.toContain('操作结果尚未确认');
});
it('reports a closed confirmation as unsent cancellation rather than generic failure',async()=>{
 const run=createReportedVoiceWorkflow({prepareMessage:vi.fn().mockResolvedValue({id:'d'}),confirmMessage:vi.fn().mockRejectedValue(Object.assign(Error('cancel'),{code:'MESSAGE_CONFIRMATION_CANCELLED'})),create:vi.fn(),showMessage:vi.fn()});
 const result=await run({requestId:'r',actionId:'message',transcript:'x',sessionId:'s'},new AbortController().signal);
 expect(result).toEqual({title:'消息已取消',text:'消息尚未发送，草稿已保留。'});
});
it('correlates stages and preserves safe nested failure codes',async()=>{
 const diagnostic=vi.fn();
 const cause=Object.assign(Error('private secret'),{code:'NATIVE_TIMEOUT'});
 const run=createReportedVoiceWorkflow({diagnostic,prepareMessage:vi.fn().mockRejectedValue(Object.assign(Error('wrapper'),{code:'MESSAGE_NOTICE_FAILED',cause})),create:vi.fn(),showMessage:vi.fn()});
 await run({requestId:'r',actionId:'message',transcript:'private',sessionId:'s'},new AbortController().signal);
 expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({requestId:'r',stage:'message.prepare',status:'started'}));
 expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({requestId:'r',status:'failed',causeCodes:['NATIVE_TIMEOUT']}));
 expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private');
});
it('reports numeric upstream errors without exposing the raw response',async()=>{
 const diagnostic=vi.fn();
 const run=createReportedVoiceWorkflow({diagnostic,prepareMessage:vi.fn().mockRejectedValue(Object.assign(Error('private response'),{code:'CLI_REJECTED',upstreamCode:99991672})),create:vi.fn(),showMessage:vi.fn()});
 const result=await run({requestId:'r',actionId:'message',transcript:'x',sessionId:'s'},new AbortController().signal);
 expect(result.text).toContain('99991672');
 expect(result.text).not.toContain('private response');
 expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({upstreamCode:99991672}));
});
it('returns a useful failure instead of allowing the SDK to discard the cause',async()=>{
 const prepareMessage=vi.fn().mockRejectedValue(Object.assign(Error('secret provider response'),{code:'MODEL_TIMEOUT'}));
 const run=createReportedVoiceWorkflow({prepareMessage,create:vi.fn(),showMessage:vi.fn()});
 const result=await run({requestId:'r',actionId:'message',transcript:'private text',sessionId:'s'},new AbortController().signal);
 expect(result.title).toBe('消息处理失败');
 expect(result.text).toContain('整理消息');expect(result.text).toContain('MODEL_TIMEOUT');
 expect(result.text).toContain('耗时');expect(result.text).not.toContain('secret');expect(result.text).not.toContain('private text');
 expect(prepareMessage).toHaveBeenCalledTimes(1);
});
it('preserves cancellation instead of showing failure after dismissal',async()=>{
 const c=new AbortController();c.abort();
 const run=createReportedVoiceWorkflow({prepareMessage:vi.fn(),create:vi.fn(),showMessage:vi.fn()});
 await expect(run({requestId:'r',actionId:'task',transcript:'x',sessionId:'s'},c.signal)).rejects.toThrow();
});
it('does not claim no mutation when task operation fails after a possible edit',async()=>{
 const run=createReportedVoiceWorkflow({prepareMessage:vi.fn(),create:vi.fn(),showMessage:vi.fn(),operation:vi.fn().mockRejectedValue(Error('lost receipt'))});
 const result=await run({requestId:'r',actionId:'task',transcript:'x',sessionId:'s'},new AbortController().signal);
 expect(result.text).toContain('操作结果尚未确认');
 expect(result.text).not.toContain('未执行发送或创建');
});

it('reports a dialog failure as unsent, not an uncertain send',async()=>{
 const run=createReportedVoiceWorkflow({prepareMessage:vi.fn().mockResolvedValue({id:'d'}),confirmMessage:vi.fn().mockRejectedValue(Object.assign(Error('private'),{code:'MESSAGE_NOTICE_FAILED'})),create:vi.fn(),showMessage:vi.fn()});
 const result=await run({requestId:'r',actionId:'message',transcript:'x',sessionId:'s'},new AbortController().signal);
 expect(result.text).toContain('消息尚未发送');
 expect(result.text).not.toContain('操作结果尚未确认');
});

it('reports missing native CLI dependency during voice task creation as unsent rather than uncertain remote mutation', async () => {
  const run = createReportedVoiceWorkflow({
    prepareMessage: vi.fn(),
    create: vi.fn().mockRejectedValue(Object.assign(Error('本机运行组件尚未安装'), { code: 'dependency_not_installed' })),
    showMessage: vi.fn(),
  });
  const result = await run({ requestId: 'r', actionId: 'task', transcript: '给小冰建个任务', sessionId: 's' }, new AbortController().signal);
  expect(result.text).toContain('飞书运行组件尚未安装');
  expect(result.text).toContain('未执行发送或创建');
  expect(result.text).not.toContain('操作结果尚未确认');
});

it('reports controlled PreparationError during message.confirm as unsent with the actual reason', async () => {
  const run = createReportedVoiceWorkflow({
    prepareMessage: vi.fn().mockResolvedValue({ id: 'd' }),
    confirmMessage: vi.fn().mockRejectedValue(Object.assign(new PreparationError('消息对象已不可用，请重新选择'), { code: 'message_not_submitted' })),
    create: vi.fn(),
    showMessage: vi.fn(),
  });
  const result = await run({ requestId: 'r', actionId: 'message', transcript: '给聪聪发消息', sessionId: 's' }, new AbortController().signal);
  expect(result.text).toContain('消息对象已不可用，请重新选择');
  expect(result.text).toContain('未执行发送或创建');
  expect(result.text).not.toContain('操作结果尚未确认');
});

it('reports non-PreparationError message_not_submitted during confirm as unsent without leaking raw details', async () => {
  const run = createReportedVoiceWorkflow({
    prepareMessage: vi.fn().mockResolvedValue({ id: 'd' }),
    confirmMessage: vi.fn().mockRejectedValue(Object.assign(Error('secret sqlite detail'), { code: 'message_not_submitted' })),
    create: vi.fn(),
    showMessage: vi.fn(),
  });
  const result = await run({ requestId: 'r', actionId: 'message', transcript: '给聪聪发消息', sessionId: 's' }, new AbortController().signal);
  expect(result.text).toContain('消息尚未发送，草稿已保留');
  expect(result.text).not.toContain('操作结果尚未确认');
  expect(result.text).not.toContain('secret sqlite detail');
});

it('reports CliNotAuthenticatedError during voice requests as not connected and unsent', async () => {
  const run = createReportedVoiceWorkflow({
    prepareMessage: vi.fn(),
    create: vi.fn().mockRejectedValue(new CliNotAuthenticatedError()),
    showMessage: vi.fn(),
  });
  const result = await run({ requestId: 'r', actionId: 'task', transcript: '建个任务', sessionId: 's' }, new AbortController().signal);
  expect(result.text).toContain('请先在飞书插件中连接飞书账号后再使用');
  expect(result.text).toContain('未执行发送或创建');
  expect(result.text).not.toContain('操作结果尚未确认');
});

it('reports malformed model output, missing task/calendar grants, and calendar conflicts as unsent', async () => {
  const model = createIntentModel(vi.fn().mockResolvedValue({ text: 'not-json' }));
  const badModelRun = createReportedVoiceWorkflow({
    prepareMessage: vi.fn(),
    operation: vi.fn().mockImplementation(() => model({}, 'test') as never),
    create: vi.fn(),
    showMessage: vi.fn(),
  });
  const badModelRes = await badModelRun({ requestId: 'r1', actionId: 'task', transcript: '完成任务', sessionId: 's' }, new AbortController().signal);
  expect(badModelRes.text).toContain('模型未返回有效的意图结果');
  expect(badModelRes.text).toContain('未执行发送或创建');
  expect(badModelRes.text).not.toContain('操作结果尚未确认');

  const missingTaskGrantRun = createReportedVoiceWorkflow({
    prepareMessage: vi.fn(),
    create: ({ prompt, operationId }) => runTaskCreation({ source: prompt, operationId, referenceTime: '2026-11-20T10:00:00+08:00' }, {
      readAccount: vi.fn().mockResolvedValue({ accountId: 'ou_me', scopes: [] }),
      readPeople: vi.fn(),
      model: vi.fn(),
      cli: vi.fn(),
    }) as never,
    showMessage: vi.fn(),
  });
  const taskGrantRes = await missingTaskGrantRun({ requestId: 'r2', actionId: 'task', transcript: '建任务', sessionId: 's' }, new AbortController().signal);
  expect(taskGrantRes.text).toContain('飞书缺少任务权限');
  expect(taskGrantRes.text).toContain('未执行发送或创建');
  expect(taskGrantRes.text).not.toContain('操作结果尚未确认');

  const busyCalendarRun = createReportedVoiceWorkflow({
    prepareMessage: vi.fn(),
    create: ({ prompt, operationId }) => runCalendarCreation({ source: prompt, operationId, referenceTime: '2026-11-20T10:00:00+08:00' }, {
      readAccount: vi.fn().mockResolvedValue({
        accountId: 'ou_me',
        scopes: ['calendar:calendar.calendar:readonly', 'calendar:calendar.event:create', 'calendar:calendar.event:update', 'calendar:calendar.free_busy:read'],
      }),
      readPeople: vi.fn().mockResolvedValue([{ id: 'ou_ice', name: '小冰', aliases: [], active: true, external: false }]),
      model: vi.fn()
        .mockResolvedValueOnce({
          action: 'create',
          participantScope: 'named',
          participantIds: ['ou_ice'],
          scopeEvidence: '',
          summary: '同步方案',
          description: '',
          start: '2026-11-21T15:00:00+08:00',
          end: '2026-11-21T15:30:00+08:00',
          allowConflict: false,
        })
        .mockResolvedValueOnce({ supported: true, complete: true, recipientSupported: true, timeSupported: true, scopeSupported: true }),
      rosterRequest: vi.fn(),
      cli: vi.fn()
        .mockResolvedValueOnce({ calendars: [{ calendar: { role: 'owner', calendar_id: 'cal_1' } }] })
        .mockResolvedValueOnce({ freebusy_list: [{}] }),
    }) as never,
    showMessage: vi.fn(),
  });
  const busyRes = await busyCalendarRun({ requestId: '13bf963b-8419-41e0-9a83-83f1330c5799', actionId: 'calendar', transcript: '明天下午3点跟小冰开会半小时', sessionId: 's' }, new AbortController().signal);
  expect(busyRes.text).toContain('该时段有参与人已有日程，尚未预约');
  expect(busyRes.text).toContain('未执行发送或创建');
  expect(busyRes.text).not.toContain('操作结果尚未确认');
});
