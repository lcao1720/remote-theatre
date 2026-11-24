// Entry point so `node --test test/` works on Node 22+, where a directory argument is
// resolved as a module path (test/index.js) instead of being scanned for test files.
import './sync.test.mjs';
