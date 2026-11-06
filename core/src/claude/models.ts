/**
 * The claude CLI's own model picker list, obtained over its stream-json
 * control channel (`list_models`). Pear renders exactly what the installed
 * CLI offers — including entries it disables with an "update to …" hint —
 * instead of a hardcoded lineup that goes stale.
 */
export interface ClaudeModelInfo {
  /** What to pass as --model ('default', 'opus[1m]', 'sonnet', …). */
  value: string;
  displayName: string;
  description?: string;
  /** Concrete model id the alias resolves to, when the CLI says. */
  resolvedModel?: string;
  /** Listed but not selectable (e.g. needs a newer CLI). */
  disabled?: boolean;
}

/** The stdin line that asks for the list; `requestId` ties the reply back. */
export function listModelsRequest(requestId: string): string {
  return (
    JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'list_models' },
    }) + '\n'
  );
}

/**
 * Decode a `control_response` message for a `list_models` request. Returns
 * null when the message is not that reply (other request ids, other types),
 * throws when the CLI answered with an error.
 */
export function parseModelList(msg: unknown, requestId: string): ClaudeModelInfo[] | null {
  const m = (msg ?? {}) as Record<string, any>;
  if (m['type'] !== 'control_response') return null;
  const response = (m['response'] ?? {}) as Record<string, any>;
  if (response['request_id'] !== requestId) return null;
  if (response['subtype'] !== 'success') {
    throw new Error(String(response['error'] ?? 'list_models failed'));
  }
  const models = (response['response'] ?? {})['models'];
  if (!Array.isArray(models)) return [];
  const out: ClaudeModelInfo[] = [];
  for (const raw of models) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r['value'] !== 'string') continue;
    const info: ClaudeModelInfo = {
      value: r['value'],
      displayName: typeof r['displayName'] === 'string' ? r['displayName'] : r['value'],
    };
    if (typeof r['description'] === 'string') info.description = r['description'];
    if (typeof r['resolvedModel'] === 'string') info.resolvedModel = r['resolvedModel'];
    if (r['disabled'] === true) info.disabled = true;
    out.push(info);
  }
  return out;
}
