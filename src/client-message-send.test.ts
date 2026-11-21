// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  ledger: new Map<string, string>(),
  generate: vi.fn(),
  nativeCalls: [] as { operationId: string; args: string[] }[],
  onNative: vi.fn(),
}));

vi.mock('@vitalk/plugin-sdk', () => ({
  createWindowTransport: () => ({}),
  createPluginClient: () => ({
    dispose() {},
    request: async (method: string, params: any) => {
      if (method === 'storage.get') {
        return { value: structuredClone(mocks.values.get(params.key) ?? null) };
      }
      if (method === 'storage.set') {
        mocks.values.set(params.key, structuredClone(params.value));
        return { ok: true };
      }
      if (method === 'ai.generate') {
        return mocks.generate(params);
      }
      if (method === 'native.execute') {
        const key = `${params.dependencyId}:${params.operationId}`;
        const signature = JSON.stringify(params.args);
        const existing = mocks.ledger.get(key);
        if (existing && existing !== signature) {
          throw Object.assign(Error('本机组件操作编号与既有记录冲突，请先核对结果。'), {
            code: 'native_outcome_unknown',
          });
        }
        mocks.ledger.set(key, signature);
        mocks.nativeCalls.push({ operationId: params.operationId, args: params.args });
        return mocks.onNative(params.args, params.operationId);
      }
      throw Object.assign(Error('unsupported'), { code: 'unsupported_method' });
    },
  }),
}));

import { dispose, getMessageService, readVoiceMessageContext } from './client';
import { PreparationError } from './person-context';

afterEach(() => {
  dispose();
  mocks.values.clear();
  mocks.ledger.clear();
  mocks.nativeCalls.length = 0;
  vi.clearAllMocks();
});

const authOk = {
  exitCode: 0,
  stdout: JSON.stringify({
    ok: true,
    data: {
      identities: {
        user: {
          openId: 'ou_me',
          status: 'ready',
          tokenStatus: 'valid',
          scope: 'contact:user:search contact:user.base:readonly im:chat:read im:message.send_as_user im:message',
        },
      },
    },
  }),
};

it('uses unique operation IDs across compact-profile revalidation steps when sending to a colleague', async () => {
  (window as any).__VITALK_PLUGIN_TOKEN__ = 'test';
  mocks.values.set('workspace.ou_me', {
    accountId: 'ou_me',
    config: { feishuTools: true, feishuRecipientModel: 'llm', feishuMessageStyle: '' },
    entries: [],
    enabled: false,
    catalog: {
      recipients: [{ id: 'ou_cong', name: '张聪聪', kind: 'person', active: true, external: false }],
      partial: true,
      lastSync: 123,
    },
  });
  const draftId = '11111111-1111-4111-8111-111111111111';
  mocks.values.set(`message-draft.${draftId}`, {
    id: draftId,
    accountId: 'ou_me',
    prompt: '给聪聪发消息今天把SOP发给他',
    recipient: { id: 'ou_cong', name: '张聪聪', aliases: [], kind: 'person', active: true, external: false },
    content: '今天我会把内容运营的 SOP 文档发给你。',
    status: 'ready',
  });

  mocks.onNative.mockImplementation(async (args: string[]) => {
    if (args[0] === 'auth') return authOk;
    if (args[0] === 'api' && args[2] === '/open-apis/contact/v3/users/batch') {
      // Compact directory read omits full lifecycle flags, forcing both +search-user steps.
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { items: [{ open_id: 'ou_cong', name: '张聪聪' }] } }) };
    }
    if (args[0] === 'contact' && args[1] === '+search-user' && args.includes('--left-organization')) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { has_more: false, users: [] } }) };
    }
    if (args[0] === 'contact' && args[1] === '+search-user') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { has_more: false, users: [{ open_id: 'ou_cong', localized_name: '张聪聪', is_activated: true, is_cross_tenant: false }] },
        }),
      };
    }
    if (args[0] === 'im' && args[1] === '+messages-send') {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_sent_cong' } }) };
    }
    throw Error(`unexpected cli: ${args.join(' ')}`);
  });

  const result = await getMessageService().send({
    id: draftId,
    recipientId: 'ou_cong',
    content: '今天我会把内容运营的 SOP 文档发给你。',
  });

  expect(result).toMatchObject({ id: draftId, status: 'sent', receipt: 'om_sent_cong' });
  const contactReads = mocks.nativeCalls.filter((call) => call.operationId.startsWith('contact-'));
  expect(contactReads).toHaveLength(3);
  expect(new Set(contactReads.map((call) => call.operationId)).size).toBe(3);
  const sendCall = mocks.nativeCalls.find((call) => call.args[1] === '+messages-send');
  expect(sendCall?.operationId).toBe(`message-${draftId}`);
});

it('falls back to directory search when preparing a message for an uncached colleague', async () => {
  (window as any).__VITALK_PLUGIN_TOKEN__ = 'test';
  mocks.values.set('workspace.ou_me', {
    accountId: 'ou_me',
    config: { feishuTools: true, feishuRecipientModel: 'llm', feishuMessageStyle: '' },
    entries: [],
    enabled: false,
    catalog: {
      recipients: [{ id: 'ou_bing', name: '阳晓冰', kind: 'person', active: true, external: false }],
      partial: true,
      lastSync: 123,
    },
  });

  mocks.generate
    .mockResolvedValueOnce({
      text: JSON.stringify({
        action: 'clarify',
        recipientQuery: '聪聪',
        content: '今天我会把内容运营的 SOP 文档发给你。',
      }),
    })
    .mockResolvedValueOnce({
      text: JSON.stringify({
        action: 'send',
        recipientId: 'ou_cong',
        content: '今天我会把内容运营的 SOP 文档发给你。',
      }),
    });

  mocks.onNative.mockImplementation(async (args: string[]) => {
    if (args[0] === 'auth') return authOk;
    if (args[0] === 'contact' && args[1] === '+search-user' && args.includes('--query')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { has_more: false, users: [{ open_id: 'ou_cong', localized_name: '张聪聪', is_activated: true, is_cross_tenant: false }] },
        }),
      };
    }
    if (args[0] === 'api' && args[2] === '/open-apis/contact/v3/users/batch') {
      const parsedParams = JSON.parse(args[args.indexOf('--params') + 1]);
      const profiles: Record<string, unknown> = {
        ou_cong: {
          open_id: 'ou_cong',
          name: '张聪聪',
          is_external: false,
          status: { is_resigned: false, is_exited: false, is_unjoin: false, is_frozen: false, is_activated: true },
        },
        ou_bing: {
          open_id: 'ou_bing',
          name: '阳晓冰',
          is_external: false,
          status: { is_resigned: false, is_exited: false, is_unjoin: false, is_frozen: false, is_activated: true },
        },
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            items: (parsedParams.user_ids as string[]).map((id) => profiles[id]).filter(Boolean),
          },
        }),
      };
    }
    if (args[0] === 'im' && args[1] === '+messages-send') {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_sent_after_search' } }) };
    }
    throw Error(`unexpected cli: ${args.join(' ')}`);
  });

  const draft = await getMessageService().prepare({ prompt: '给聪聪发消息今天把内容运营的SOP文档发给他' });
  expect(draft.awaitingRecipient).toBeFalsy();
  expect(draft.recipient).toMatchObject({ id: 'ou_cong', name: '张聪聪' });

  const sent = await getMessageService().send({
    id: draft.id,
    recipientId: 'ou_cong',
    content: draft.content,
  });
  expect(sent).toMatchObject({ status: 'sent', receipt: 'om_sent_after_search' });
});

it('prepares voice draft + notice context with 2 auth checks, sends plain text with 2 auth checks, and enforces requireVoiceEnabled', async () => {
  (window as any).__VITALK_PLUGIN_TOKEN__ = 'test';
  mocks.values.set('workspace.ou_me', {
    accountId: 'ou_me',
    config: { feishuTools: true, feishuRecipientModel: 'llm', feishuMessageStyle: '自然直接' },
    entries: [],
    enabled: false,
    catalog: {
      recipients: [{ id: 'ou_bing', name: '阳晓冰', kind: 'person', active: true, external: false }],
      partial: true,
      lastSync: 123,
    },
  });
  mocks.values.set('workspace-history.ou_me', [
    { id: 'hist-1', prompt: '历史消息', text: '已发送', status: 'completed' },
  ]);

  mocks.generate.mockResolvedValueOnce({
    text: JSON.stringify({ action: 'send', recipientId: 'ou_bing', content: '下午三点开会。' }),
  });

  mocks.onNative.mockImplementation(async (args: string[]) => {
    if (args[0] === 'auth') return authOk;
    if (args[0] === 'api' && args[2] === '/open-apis/contact/v3/users/batch') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            items: [{
              open_id: 'ou_bing',
              name: '阳晓冰',
              is_external: false,
              status: { is_resigned: false, is_exited: false, is_unjoin: false, is_frozen: false, is_activated: true },
            }],
          },
        }),
      };
    }
    if (args[0] === 'im' && args[1] === '+messages-send') {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_fast_send' } }) };
    }
    throw Error(`unexpected cli: ${args.join(' ')}`);
  });

  const draft = await getMessageService().prepare({
    prompt: '给小冰说下午三点开会',
    requireVoiceEnabled: true,
  });
  const ctx = await readVoiceMessageContext(draft.id, new AbortController().signal);
  expect(ctx.recipients).toHaveLength(1);
  expect(ctx.history).toHaveLength(1);

  const authCallsDuringPrepare = mocks.nativeCalls.filter((call) => call.args[0] === 'auth');
  expect(authCallsDuringPrepare).toHaveLength(2);

  const beforeSendCalls = mocks.nativeCalls.length;
  const sent = await getMessageService().send({
    id: draft.id,
    recipientId: 'ou_bing',
    content: draft.content,
  });
  expect(sent).toMatchObject({ status: 'sent', receipt: 'om_fast_send' });
  const authCallsDuringSend = mocks.nativeCalls.slice(beforeSendCalls).filter((call) => call.args[0] === 'auth');
  expect(authCallsDuringSend).toHaveLength(2);

  // When feishuTools is disabled, requireVoiceEnabled must fail with PreparationError after 1 auth check and 0 LLM calls.
  mocks.values.set('workspace.ou_me', {
    accountId: 'ou_me',
    config: { feishuTools: false, feishuRecipientModel: 'llm', feishuMessageStyle: '' },
    entries: [],
    enabled: false,
    catalog: {
      recipients: [{ id: 'ou_bing', name: '阳晓冰', kind: 'person', active: true, external: false }],
      partial: true,
      lastSync: 123,
    },
  });
  const beforeDisabled = mocks.nativeCalls.length;
  mocks.generate.mockClear();
  await expect(
    getMessageService().prepare({ prompt: '给小冰说好', requireVoiceEnabled: true }),
  ).rejects.toThrow(PreparationError);
  expect(mocks.nativeCalls.slice(beforeDisabled).filter((call) => call.args[0] === 'auth')).toHaveLength(1);
  expect(mocks.generate).not.toHaveBeenCalled();
});
