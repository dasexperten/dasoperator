// Node-side transport guard for local Miniflare only. The Worker has a separate
// outboundService that rejects every fetch. Never preload this in production.
import { Socket } from 'node:net';
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // Node may normalize the public arguments before reaching Socket.connect.
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = typeof first === 'object' && first !== null ? first : null;
  const host = options?.host ?? (typeof normalized[1] === 'string' ? normalized[1] : 'localhost');
  if (options?.path || typeof first === 'string' && !/^\d+$/.test(first)) {
    throw Error('Local Miniflare checks forbid Unix socket connections');
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw Error(`Local Miniflare checks forbid outbound sockets: ${host}`);
  }
  return connect.apply(this, args);
};
