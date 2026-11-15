/**
 * The utility process gets only what it needs from the environment, never the
 * whole shell environment (which may hold API keys such as GOOGLE_API_KEY or
 * AWS credentials that the voice engine has no use for).
 */
export function workerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL'];
  return Object.fromEntries(keep.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
}
