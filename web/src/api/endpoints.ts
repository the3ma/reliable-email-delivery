import { apiRequest } from './client';
import type {
  Category,
  DeliveryDetail,
  DeliveryStatus,
  DeliverySummary,
  DigestRequest,
  DigestResult,
  FeedbackRequest,
  FeedbackResult,
  Health,
  Kind,
  MailMessage,
  MailSummary,
  Overview,
  Page,
  Scenario,
  ScenarioRun,
  ScenarioRunStatus,
  Suppression,
  ToggleUpdate,
  ToggleValue,
} from './types';

type Signal = AbortSignal | undefined;

export interface DeliveryQuery {
  status?: DeliveryStatus | undefined;
  category?: Category | undefined;
  kind?: Kind | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface MailQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
}

const enc = encodeURIComponent;

export const api = {
  health: (signal?: Signal) => apiRequest<Health>('/health', { signal, acceptStatus: [503] }),
  overview: (signal?: Signal) => apiRequest<Overview>('/overview', { signal }),
  scenarios: (signal?: Signal) => apiRequest<Scenario[]>('/scenarios', { signal }),
  runScenario: (id: string) =>
    apiRequest<ScenarioRun>(`/scenarios/${enc(id)}/run`, { method: 'POST', body: {} }),
  scenarioRun: (runId: string, signal?: Signal) =>
    apiRequest<ScenarioRunStatus>(`/scenarios/runs/${enc(runId)}`, { signal }),
  deliveries: (query: DeliveryQuery, signal?: Signal) =>
    apiRequest<Page<DeliverySummary>>('/deliveries', { query: { ...query }, signal }),
  delivery: (id: string, signal?: Signal) =>
    apiRequest<DeliveryDetail>(`/deliveries/${enc(id)}`, { signal }),
  suppressions: (signal?: Signal) => apiRequest<Page<Suppression>>('/suppressions', { signal }),
  feedback: (body: FeedbackRequest) =>
    apiRequest<FeedbackResult>('/feedback', { method: 'POST', body }),
  setSendEmails: (value: ToggleValue) =>
    apiRequest<ToggleUpdate>('/toggles/send-emails', { method: 'PUT', body: { value } }),
  runDigest: (body: DigestRequest) =>
    apiRequest<DigestResult>('/digest/run', { method: 'POST', body }),
  reset: () => apiRequest<unknown>('/reset', { method: 'POST', body: {} }),
  mail: (query: MailQuery, signal?: Signal) =>
    apiRequest<Page<MailSummary>>('/mail', { query: { ...query }, signal }),
  mailMessage: (id: string, signal?: Signal) =>
    apiRequest<MailMessage>(`/mail/${enc(id)}`, { signal }),
};
