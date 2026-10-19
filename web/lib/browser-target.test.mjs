import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceTargets } from './browser-target.mjs';
test('Windows computer → PC only', () => assert.deepEqual(deviceTargets('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141', 'Win32'), ['pc']));
test('Mac computer → Mac only', () => assert.deepEqual(deviceTargets('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141', 'MacIntel', 0), ['mac']));
test('phone → both', () => { assert.deepEqual(deviceTargets('Mozilla/5.0 (Linux; Android 14) Mobile Safari', 'Linux armv8l'), ['pc', 'mac']); assert.deepEqual(deviceTargets('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 'iPhone'), ['pc', 'mac']); });
test('iPad that says Mac → both', () => assert.deepEqual(deviceTargets('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 'MacIntel', 5), ['pc', 'mac']));
