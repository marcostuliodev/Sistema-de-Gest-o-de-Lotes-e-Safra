// Express 4 não captura rejeições de handlers async; este wrapper garante que
// o erro chegue ao middleware de erro (e retorne 500 em vez de travar em 502).
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
