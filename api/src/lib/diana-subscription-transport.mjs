// Service binding only. The bound service must run the unmodified native CLI
// with subscription authentication; this adapter never calls a model API.
export async function subscriptionInference(messages, { binding, requestId, operation, model = 'gpt-6-luna', schema }) {
  if (!binding || typeof binding.fetch !== 'function') throw Error('subscription_runner_not_configured');
  if (!['context', 'image'].includes(operation)) throw Error('invalid_subscription_operation');
  if (typeof requestId !== 'string' || !requestId.trim()) throw Error('subscription_request_id_required');
  const response = await binding.fetch('https://subscription.internal/infer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, operation, messages, model, schema }),
  });
  if (!response.ok) throw Error(`subscription_runner_http_${response.status}`);
  const result = await response.json();
  if (result?.receipt?.transport !== 'codex-native'
      || result.receipt.auth !== 'subscription'
      || !['gpt-6-luna','gpt-6.1-terra'].includes(result.receipt.model) || result.receipt.model !== model
      || result.receipt.requestId !== requestId
      || result.receipt.operation !== operation
      || typeof result.text !== 'string' || !result.text.trim())
    throw Error('invalid_subscription_receipt');
  return result;
}
