// Stand-in for the "server-only" package outside Next's own bundler (see
// vitest.config.ts and tsconfig.scripts.json, its two consumers). Next
// no-ops "server-only" inside Server Components; plain Node/Vite/tsx have
// no equivalent notion, so tests and the ai:enrich CLI script need an
// inert substitute rather than the real package's unconditional throw.
export {};
