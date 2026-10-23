export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value === '')
    throw new Error(`missing required environment variable ${name}`);
  return value;
}

export function optionalEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function intEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = optionalEnv(name, env);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
