/**
 * @peculiar/x509 (test-only) uses tsyringe, which insists on a Reflect metadata polyfill. Only the
 * `@peculiar/x509` dev dependency may be added, so this is a minimal in-memory stand-in for
 * `reflect-metadata`. Must be imported before @peculiar/x509.
 */
type Target = object;
const store = new WeakMap<Target, Map<string | symbol | undefined, Map<unknown, unknown>>>();

function table(target: Target, prop: string | symbol | undefined, create: boolean) {
  let byProp = store.get(target);
  if (!byProp) {
    if (!create) return undefined;
    byProp = new Map();
    store.set(target, byProp);
  }
  let t = byProp.get(prop);
  if (!t && create) {
    t = new Map();
    byProp.set(prop, t);
  }
  return t;
}

const R = Reflect as unknown as Record<string, unknown>;
if (typeof R.getMetadata !== 'function') {
  const getOwn = (key: unknown, target: Target, prop?: string | symbol) =>
    table(target, prop, false)?.get(key);
  const get = (key: unknown, target: Target, prop?: string | symbol): unknown => {
    for (let t: Target | null = target; t; t = Object.getPrototypeOf(t)) {
      const v = getOwn(key, t, prop);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  R.defineMetadata = (key: unknown, value: unknown, target: Target, prop?: string | symbol) => {
    table(target, prop, true)?.set(key, value);
  };
  R.getOwnMetadata = getOwn;
  R.getMetadata = get;
  R.hasOwnMetadata = (key: unknown, target: Target, prop?: string | symbol) =>
    getOwn(key, target, prop) !== undefined;
  R.hasMetadata = (key: unknown, target: Target, prop?: string | symbol) =>
    get(key, target, prop) !== undefined;
  R.metadata = (key: unknown, value: unknown) => (target: Target, prop?: string | symbol) => {
    table(target, prop, true)?.set(key, value);
  };
}
