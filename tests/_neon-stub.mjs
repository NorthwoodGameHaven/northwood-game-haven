// tests/_neon-stub.mjs — NGH-BUILD 2026-09-12t
//
// Stubs ONLY the '@netlify/neon' driver, so the REAL netlify/functions/_shared/db.mjs
// loads and can be tested.
//
// This exists because of a blind spot that cost the shop a working delete
// button. tests/_mock-hooks.mjs replaces db.mjs wholesale with an in-memory
// copy — which is right for testing the functions that use it, but means the
// real db.mjs is never executed by anything. Its noContent() built a 204 with
// an empty-string body, which the Response constructor rejects outright, and
// so every delete endpoint in the codebase threw. Reverting that bug did not
// turn a single test red, because the only version of the code under test was
// the mock's copy.
//
// A mock that shadows the module it is standing in for cannot protect it.
// Anything in db.mjs that is pure logic gets tested here, against the real file.
import { pathToFileURL } from 'node:url';

const STUB = `
  // The tagged-template query function. Nothing here touches a network.
  export function neon() {
    const q = (strings, ...values) => Promise.resolve([]);
    return q;
  }
  export default { neon };
`;

export async function resolve(specifier, context, next) {
  if (specifier === '@netlify/neon') return { url: 'neon-stub:main', shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'neon-stub:main') return { format: 'module', shortCircuit: true, source: STUB };
  return next(url, context);
}
