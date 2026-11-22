// Node-only optional test preload. Never import this from a Worker entrypoint.
// Tests may install explicit fetch mocks. Unmocked sockets remain denied.
import { Socket } from 'node:net';
globalThis.fetch = async () => { throw Error('Network disabled for isolated pilot checks'); };
Socket.prototype.connect = function () { throw Error('Sockets disabled for isolated pilot checks'); };
