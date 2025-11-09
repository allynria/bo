export type Message = {
  role?: 'system' | 'memory' | 'context' | 'user' | 'tool_result' | 'policy' | 'assistant' | string;
  text?: string;
  content?: string[];
  conv_id?: string;
  turn?: number;
  id?: string;
  ts?: number;
};

export type CompileRequest = {
  messages: Message[];
  persona_v?: string;
  prompt_v?: string;
};

export type CompileResponse = {
  ok: boolean;
  hash: string;
  bytes_b64: string;
};

export type ReplyMessage = {
  role?: string;
  conv_id?: string;
  turn?: number;
  content?: string[];
};

export type MessageRequest = {
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
};

export type MessageResponse = {
  ok: boolean;
  reply: ReplyMessage;
  model: string;
  provider: string;
  resolved_model: string;
  variant_v?: string;
  engine_source?: 'explicit' | 'ctx' | 'heuristic' | 'default' | 'replay';
  hash: string;
  bytes_b64: string;
  request_id?: string;
  idempotent_replay?: boolean;
};

export type JSONResponse<T> = {
  status: number;
  headers: Record<string, string | string[]>;
  json: T;
};

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
  request_id?: string;
}

export interface SSEDeltaPayload { text: string }

export interface SSEHedgeSwitchPayload {
  from_provider?: string;
  from_resolved_model?: string;
  to_provider?: string;
  to_resolved_model?: string;
  reason?: 'hedge' | string;
}

export interface SSEEndPayload { final: string; idempotent_replay?: boolean; request_id?: string }

export type StreamEvent =
  | { event: 'start'; payload: SSEStartPayload }
  | { event: 'delta'; payload: SSEDeltaPayload }
  | { event: 'hedge.switch'; payload: SSEHedgeSwitchPayload }
  | { event: 'end'; payload: SSEEndPayload }
  | { event: 'error'; payload: unknown };

export { postV1ConvMessage, postV1ConvCompile, subscribeV1ConvStream, iterateV1ConvStream, computeClientTs, computeClientMac, iterateV1ConvStreamAutoReplay } from '../js/client.mjs';
