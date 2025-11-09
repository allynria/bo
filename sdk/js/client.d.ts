/// <reference types="node" />

export interface Message {
  role?: 'system' | 'memory' | 'context' | 'user' | 'tool_result' | 'policy' | 'assistant' | string;
  text?: string;
  content?: string[];
  conv_id?: string;
  turn?: number;
  id?: string;
  ts?: number;
}

export type ErrorCode =
  | 'unsupported_media_type'
  | 'header_too_large'
  | 'payload_too_large'
  | 'schema_invalid'
  | 'bad_request'
  | 'invalid_alert_name'
  | 'auth_required'
  | 'replay_window_exceeded'
  | 'idem_mac_missing'
  | 'idem_mac_invalid'
  | 'forbidden'
  | 'cors_forbidden'
  | 'duplicate_message'
  | 'duplicate_stream'
  | 'replay_unavailable'
  | 'rate_limited'
  | 'budget_limited'
  | 'soft_drop'
  | 'draining'
  | 'tenant_wipe_failed'
  | 'idem_purge_failed'
  | 'heap_snapshot_failed'
  | 'export_failed'
  | 'not_found'
  | 'ts_required';

export type SchemaInvalidError = { error: 'schema_invalid'; errors: { path: string; message: string }[] };
export type RateLimitedError = {
  error: 'rate_limited';
  reason?: 'internal_error' | 'client' | 'policy' | 'backpressure' | 'tenant' | 'conversation' | string;
  scope?: string;
  retry_after_s?: number;
  wait_s?: number;
  conv_id?: string;
};
export type BudgetLimitedError = {
  error: 'budget_limited';
  reason: 'tenant_dollars' | 'tenant_dollars_monthly' | 'tenant_dollars_rolling' | 'tenant_tokens' | 'tenant_tokens_monthly' | 'tenant_tokens_rolling' | string;
  scope: string;
  window_ms?: number;
};
export type ReplayUnavailableError = { error: 'replay_unavailable'; reason: 'exhausted' | 'ttl_or_missing' | string };
export type DuplicateMessageError = { error: 'duplicate_message'; ttl_ms: number };
export type DuplicateStreamError = { error: 'duplicate_stream'; ttl_ms: number };
export type AuthRequiredError = { error: 'auth_required' };
export type ReplayWindowExceededError = { error: 'replay_window_exceeded'; skew_ms: number };
export type IdemMacMissingError = { error: 'idem_mac_missing' };
export type IdemMacInvalidError = { error: 'idem_mac_invalid' };
export type CorsForbiddenError = { error: 'cors_forbidden' };
export type ForbiddenError = { error: 'forbidden' };
export type UnsupportedMediaTypeError = { error: 'unsupported_media_type'; expected?: string };
export type SoftDropError = { error: 'soft_drop'; reason?: 'cpu_overload' | 'rss_overload' | string; retry_after_ms?: number };
export type DrainingError = { error: 'draining' };
export type BadRequestError = { error: 'bad_request' };
export type TsRequiredError = { error: 'ts_required' };
export type InvalidAlertNameError = { error: 'invalid_alert_name' };
export type HeaderTooLargeError = { error: 'header_too_large' };
export type PayloadTooLargeError = { error: 'payload_too_large' };
export type TenantWipeFailedError = { error: 'tenant_wipe_failed'; detail?: string };
export type IdemPurgeFailedError = { error: 'idem_purge_failed'; detail?: string };
export type HeapSnapshotFailedError = { error: 'heap_snapshot_failed'; msg?: string };
export type ExportFailedError = { error: 'export_failed' };
export type NotFoundError = { error: 'not_found' };
export type ErrorResponse =
  | SchemaInvalidError
  | RateLimitedError
  | BudgetLimitedError
  | ReplayUnavailableError
  | DuplicateMessageError
  | DuplicateStreamError
  | AuthRequiredError
  | ReplayWindowExceededError
  | IdemMacMissingError
  | IdemMacInvalidError
  | CorsForbiddenError
  | ForbiddenError
  | UnsupportedMediaTypeError
  | SoftDropError
  | DrainingError
  | BadRequestError
  | TsRequiredError
  | InvalidAlertNameError
  | HeaderTooLargeError
  | PayloadTooLargeError
  | TenantWipeFailedError
  | IdemPurgeFailedError
  | HeapSnapshotFailedError
  | ExportFailedError
  | NotFoundError;

export interface CompileRequest {
  messages: Message[];
  persona_v?: string;
  prompt_v?: string;
}

export interface CompileResponse {
  ok: boolean;
  hash: string;
  bytes_b64: string;
}

export interface ReplyMessage {
  role?: string;
  conv_id?: string;
  turn?: number;
  content?: string[];
}

export interface MessageRequest {
  text?: string;
  content?: string[];
  conv_id?: string;
  turn?: number;
  engine: 'echo' | 'urga' | 'dreams';
  persona_v?: string;
  prompt_v?: string;
  id?: string;
  ts?: number;
  ctx?: { vars?: Record<string, unknown> };
}

export interface MessageResponse {
  ok: boolean;
  reply: ReplyMessage;
  model: string;
  provider: string;
  resolved_model: string;
  variant_v?: string;
  engine_source?: 'explicit' | 'ctx' | 'heuristic' | 'default' | 'replay';
  hash: string;
  bytes_b64: string;
  idempotent_replay?: boolean;
}

export interface JSONResponse<T> {
  status: number;
  headers: Record<string, string | string[]>;
  json: T;
}

export function postV1ConvMessage(baseUrl: string, body: MessageRequest): Promise<JSONResponse<MessageResponse | ErrorResponse>>;

export function postV1ConvCompile(baseUrl: string, body: CompileRequest): Promise<JSONResponse<CompileResponse | ErrorResponse>>;

export function subscribeV1ConvStream(
  baseUrl: string,
  opts: { conv_id: string; turn: number; engine: string; text?: string; persona_v?: string; prompt_v?: string }
): import('events').EventEmitter;

export interface SSEStartPayload {
  model?: string;
  provider?: string;
  provider_primary?: string;
  provider_used?: string;
  hedge_triggered?: boolean;
  resolved_model?: string;
  engine_source?: string;
  variant_v?: string;
  conv_id?: string;
  tool_call_id?: string;
  tenant?: string;
}

export interface SSEDeltaPayload { text: string }

export interface SSEHedgeSwitchPayload {
  from_provider?: string;
  from_resolved_model?: string;
  to_provider?: string;
  to_resolved_model?: string;
  reason?: 'hedge' | string;
}

export interface SSEEndPayload { final: string; idempotent_replay?: boolean }

export type StreamEvent =
  | { event: 'start'; payload: SSEStartPayload }
  | { event: 'delta'; payload: SSEDeltaPayload }
  | { event: 'hedge.switch'; payload: SSEHedgeSwitchPayload }
  | { event: 'end'; payload: SSEEndPayload }
  | { event: 'error'; payload: ErrorResponse };

export function iterateV1ConvStream(
  baseUrl: string,
  opts: { conv_id: string; turn: number; engine: string; text?: string; persona_v?: string; prompt_v?: string }
): AsyncIterable<StreamEvent> & { close(): void };
