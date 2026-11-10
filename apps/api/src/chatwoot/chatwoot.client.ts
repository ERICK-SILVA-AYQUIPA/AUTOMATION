import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

export class ChatwootApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Estados de mensaje que acepta Chatwoot para buzones API */
export type ChatwootMessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Cliente HTTP de Chatwoot v4.19. Rutas y cuerpos verificados contra la documentación
 * oficial y la instancia local (docs/integrations/chatwoot.md).
 * - Platform API (/platform/api/v1): token de la Platform App.
 * - Application API (/api/v1/accounts/:id): token del usuario de integración de cada empresa.
 */
@Injectable()
export class ChatwootClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured() {
    return !!this.env.CHATWOOT_PLATFORM_TOKEN;
  }

  async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, token: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) };
      if (body !== undefined) {
        init.headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      res = await fetch(`${this.env.CHATWOOT_BASE_URL.replace(/\/$/, '')}${path}`, init);
    } catch (e) {
      throw new ChatwootApiError(0, `Sin conexión con Chatwoot: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        msg = j.message ?? j.error ?? msg;
      } catch {
        /* cuerpo no JSON */
      }
      throw new ChatwootApiError(res.status, `Chatwoot ${res.status}: ${msg}`, res.status >= 500 || res.status === 429);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  platform<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    return this.call<T>(method, `/platform/api/v1${path}`, this.env.CHATWOOT_PLATFORM_TOKEN, body);
  }

  // ------------------------------------------------------------- Platform API
  createAccount(name: string) {
    return this.platform<{ id: number; name: string }>('POST', '/accounts', { name, locale: 'es' });
  }
  createUser(u: { name: string; email: string; password: string }) {
    return this.platform<{ id: number; email: string }>('POST', '/users', u);
  }
  addAccountUser(accountId: number, userId: number, role: 'administrator' | 'agent') {
    return this.platform<{ id: number }>('POST', `/accounts/${accountId}/account_users`, { user_id: userId, role });
  }
  /** Quita al usuario de la cuenta; Chatwoot lo saca también de los buzones y desasigna sus conversaciones */
  removeAccountUser(accountId: number, userId: number) {
    return this.platform<unknown>('DELETE', `/accounts/${accountId}/account_users`, { user_id: userId });
  }
  userToken(userId: number) {
    return this.platform<{ access_token: string }>('POST', `/users/${userId}/token`);
  }
  ssoLink(userId: number) {
    return this.platform<{ url: string }>('GET', `/users/${userId}/login`);
  }

  // ---------------------------------------------------------- Application API
  createApiInbox(accountId: number, token: string, name: string, webhookUrl: string) {
    return this.call<{ id: number; inbox_identifier?: string }>('POST', `/api/v1/accounts/${accountId}/inboxes`, token, {
      name,
      enable_auto_assignment: false,
      channel: { type: 'api', webhook_url: webhookUrl },
    });
  }
  /** El secreto con el que Chatwoot firma los webhooks solo lo ve un administrador de la cuenta */
  getInbox(accountId: number, token: string, inboxId: number) {
    return this.call<{ id: number; secret?: string; inbox_identifier?: string; webhook_url?: string }>('GET', `/api/v1/accounts/${accountId}/inboxes/${inboxId}`, token);
  }
  addInboxMembers(accountId: number, token: string, inboxId: number, userIds: number[]) {
    return this.call('POST', `/api/v1/accounts/${accountId}/inbox_members`, token, { inbox_id: inboxId, user_ids: userIds });
  }
  createContact(accountId: number, token: string, c: { inboxId: number; name: string; phone?: string | null; identifier: string }) {
    return this.call<{ payload: { contact: { id: number }; contact_inbox?: { source_id: string }; contact_inboxes?: { source_id: string; inbox?: { id: number } }[] } }>(
      'POST',
      `/api/v1/accounts/${accountId}/contacts`,
      token,
      { inbox_id: c.inboxId, name: c.name, identifier: c.identifier, ...(c.phone ? { phone_number: `+${c.phone}` } : {}) },
    );
  }
  createContactInbox(accountId: number, token: string, contactId: number, inboxId: number) {
    return this.call<{ source_id: string }>('POST', `/api/v1/accounts/${accountId}/contacts/${contactId}/contact_inboxes`, token, { inbox_id: inboxId });
  }
  createConversation(accountId: number, token: string, c: { sourceId: string; inboxId: number; contactId: number }) {
    return this.call<{ id: number }>('POST', `/api/v1/accounts/${accountId}/conversations`, token, { source_id: c.sourceId, inbox_id: c.inboxId, contact_id: c.contactId, status: 'open' });
  }
  createMessage(accountId: number, token: string, conversationId: number, m: { content: string; type: 'incoming' | 'outgoing' }) {
    return this.call<{ id: number }>('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, token, { content: m.content, message_type: m.type, private: false });
  }
  updateMessageStatus(accountId: number, token: string, conversationId: number, messageId: number, status: ChatwootMessageStatus, externalError?: string) {
    return this.call('PATCH', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages/${messageId}`, token, {
      status,
      ...(status === 'failed' && externalError ? { external_error: externalError.slice(0, 250) } : {}),
    });
  }
}
