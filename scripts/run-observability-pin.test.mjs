import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPin } from './run-observability-checkPin.mjs';

test('rule 27: the vendored run-observability files match their pin (an edited copy fails CI)', () => {
  assert.deepEqual(checkPin(process.cwd()), []);
});
