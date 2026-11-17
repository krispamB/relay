import { readFileSync } from 'node:fs';

/** Intake definitions. See sos-relay-PRD.md §6.2. */
export interface Nature {
  id: string;
  label: string;
}

export interface Intake {
  code: string;
  displayName: string;
  emergencyPhone: string;
  natures: Nature[];
  enabled: boolean;
  demo: boolean;
}

export class IntakeConfigError extends Error {}

export class Intakes {
  private readonly byCode: Map<string, Intake>;
  constructor(public readonly all: Intake[]) {
    this.byCode = new Map(all.map((i) => [i.code, i]));
  }
  get(code: string): Intake | undefined {
    return this.byCode.get(code);
  }
}

export function parseIntakes(raw: unknown): Intakes {
  const fail = (msg: string): never => {
    throw new IntakeConfigError(`Invalid intakes file: ${msg}`);
  };
  if (!Array.isArray(raw) || raw.length === 0) fail('expected a non-empty array');
  const intakes: Intake[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of (raw as unknown[]).entries()) {
    const at = `intake[${i}]`;
    if (typeof entry !== 'object' || entry === null) fail(`${at} must be an object`);
    const e = entry as Record<string, unknown>;
    const str = (key: string, max: number): string => {
      const v = e[key];
      if (typeof v !== 'string' || v.trim() === '' || v.length > max)
        fail(`${at}.${key} must be a non-empty string up to ${max} characters`);
      return (v as string).trim();
    };
    const code = str('code', 32);
    if (!/^[A-Za-z0-9-]{6,32}$/.test(code))
      fail(`${at}.code must be 6 to 32 characters of A-Z, a-z, 0-9 or "-"`);
    if (seen.has(code)) fail(`${at}.code "${code}" is used twice`);
    seen.add(code);
    if (e.requireVerifiedPhone === true) fail(`${at}.requireVerifiedPhone is not supported in this version`);
    if (!Array.isArray(e.natures) || e.natures.length === 0) fail(`${at}.natures must be a non-empty array`);
    const natureIds = new Set<string>();
    const natures = (e.natures as unknown[]).map((n, j) => {
      const nn = n as Record<string, unknown> | null;
      if (
        typeof nn !== 'object' ||
        nn === null ||
        typeof nn.id !== 'string' ||
        typeof nn.label !== 'string'
      ) {
        fail(`${at}.natures[${j}] must be { id, label }`);
      }
      const id = (nn!.id as string).trim();
      const label = (nn!.label as string).trim();
      if (!/^[a-z0-9_-]{1,40}$/.test(id))
        fail(`${at}.natures[${j}].id must be 1 to 40 characters of a-z, 0-9, "_" or "-"`);
      if (label === '' || label.length > 60) fail(`${at}.natures[${j}].label must be 1 to 60 characters`);
      if (natureIds.has(id)) fail(`${at}.natures[${j}].id "${id}" is used twice`);
      natureIds.add(id);
      return { id, label };
    });
    for (const key of ['enabled', 'demo'] as const) {
      if (e[key] !== undefined && typeof e[key] !== 'boolean') fail(`${at}.${key} must be a boolean`);
    }
    intakes.push({
      code,
      displayName: str('displayName', 100),
      emergencyPhone: str('emergencyPhone', 30),
      natures,
      enabled: e.enabled !== false,
      demo: e.demo === true,
    });
  }
  if (intakes.filter((i) => i.demo).length > 1) fail('at most one intake may be marked demo');
  if (intakes.filter((i) => !i.demo).length > 1) fail('this version supports one real (non-demo) intake');
  return new Intakes(intakes);
}

export function loadIntakes(path: string): Intakes {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new IntakeConfigError(`Cannot read intakes file ${path}: ${(err as Error).message}`);
  }
  return parseIntakes(raw);
}
