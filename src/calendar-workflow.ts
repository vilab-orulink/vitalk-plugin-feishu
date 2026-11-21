import {prepareCalendar,type CalendarModel} from './calendar-intent';
import {createCalendar,type CalendarReceipt} from './calendar-service';
import type {CliAuthStatus} from './cli-auth';
import {readEmployeeRoster,type RosterRequest} from './employee-roster';
import {PreparationError} from './person-context';
import type {Person} from './task-intent';
import type {Cli} from './task-service';
import {notifyCalendar} from './calendar-notification';

export type CalendarWorkflowDependencies = {
  readAccount: () => Promise<CliAuthStatus>;
  readPeople: () => Promise<readonly Person[]>;
  model: CalendarModel;
  rosterRequest: RosterRequest;
  cli: Cli;
  beforeSubmit?: (phase:'create'|'invite') => void | Promise<void>;
  onCreated?: (receipt:CalendarReceipt,plan:Awaited<ReturnType<typeof prepareCalendar>>) => void | Promise<void>;
  shareCard?: boolean;
  verifyAllContacts?:()=>void|Promise<void>;
};

const grants = [
  ['calendar:calendar.calendar:readonly','calendar:calendar:readonly','calendar:calendar:read'],
  ['calendar:calendar.event:create','calendar:calendar'],
  ['calendar:calendar.event:update','calendar:calendar'],
  ['calendar:calendar.free_busy:read','calendar:calendar:readonly','calendar:calendar'],
];

function requireCalendarGrant(account: CliAuthStatus, preMutation = true) {
  const wrap = (message: string) => (preMutation ? new PreparationError(message) : new Error(message));
  if (!/^ou_[A-Za-z0-9_]{1,125}$/.test(account.accountId)) throw wrap('飞书账号未确认，请重新检查连接。');
  if (grants.some(group => !group.some(scope => account.scopes.includes(scope)))) {
    throw wrap('飞书缺少日历权限，请重新授权。');
  }
}

/** Live account reads and directory requests must use the same plugin CLI configuration. */
export async function runCalendarCreation(input: {source:string;operationId:string;referenceTime:string}, deps: CalendarWorkflowDependencies) {
  const initial = await deps.readAccount();
  requireCalendarGrant(initial);
  const accountId = initial.accountId;
  const verifyAccount = async (preMutation = true) => {
    const current = await deps.readAccount();
    requireCalendarGrant(current, preMutation);
    if (current.accountId !== accountId) {
      const message = '飞书账号已切换，已停止日程操作。';
      throw preMutation ? new PreparationError(message) : new Error(message);
    }
    return current.accountId;
  };

  // A missing named directory cannot establish a recipient. Personal and
  // company intent still have their own independent scope checks.
  const people = await deps.readPeople().catch(() => []);
  const plan = await prepareCalendar(input.source,people,input.referenceTime,deps.model);
  if(plan.participantScope==='allContacts')await deps.verifyAllContacts?.();
  await verifyAccount();
  let participantIds = plan.participantIds;
  let rosterReadAt: number | undefined;
  if (plan.participantScope === 'allCurrentEmployees') {
    const roster = await readEmployeeRoster({request:deps.rosterRequest,readAccount:()=>verifyAccount(true)}).catch(error => {
      throw error instanceof PreparationError ? error : new PreparationError(error instanceof Error ? error.message : String(error));
    });
    participantIds = roster.recipients.map(recipient => recipient.id);
    rosterReadAt = performance.now();
  }
  const receipt = await createCalendar(deps.cli,{...plan,participantIds},input.operationId,{
    beforeSubmit:async phase => {
      await verifyAccount(phase === 'create');
      await deps.beforeSubmit?.(phase);
      if (rosterReadAt !== undefined && performance.now() - rosterReadAt > 300_000) {
        const message = '全公司员工名册已过期，请重新核验。';
        throw phase === 'create' ? new PreparationError(message) : new Error(message);
      }
    },
    onCreated:receipt=>deps.onCreated?.(receipt,{...plan,participantIds}),
  });
  const notification = deps.shareCard ? await notifyCalendar(deps.cli,{...plan,participantIds},receipt,input.operationId,async()=>{
    const current = await deps.readAccount();
    if(current.accountId!==accountId||!current.scopes.includes('im:message.send_as_user'))throw new Error('消息授权已变化');
  }) : undefined;
  return {receipt,plan:{...plan,participantIds},participantCount:receipt.participantCount,notification};
}
