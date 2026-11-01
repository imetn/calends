// Small JSON-schema subset used by the tool catalogue, enforced for MCP and assistant callers alike.
import { t } from './i18n.ts';
import { validDay } from './billing.ts';

export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
};
export const objectSchema = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const textSchema: Schema = { type: 'string' };
export const daySchema: Schema = { type: 'string', format: 'date' };
/** 允许 null：type 已是数组时合并，不会变成 "string,null" 这种无效类型 */
export const nullable = (s: Schema): Schema => {
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  return { ...s, type: [...new Set([...types, 'null'])] };
};
export const billingSchema: Schema = {
  type: 'string',
  enum: ['postpaid'],
  description:
    'Omit (or null) for prepaid. postpaid = billed at the end of each cycle for the cycle just used: no charge on the start/anchor day, first bill one cycle later; after end/stop/pause one final bill still covers the last period started before it. No prepaid days, refund cap or "paid through". Ignored for lifetime.',
};
export const drySchema: Schema ={ type: 'boolean', description: 'Preview before/after and references without saving.' };

export function validateToolInput(schema: Schema, value: unknown, path = 'arguments'): void {
  const fail = (field = path) => {
    throw new Error(t('mcp.error.invalidInput', { field }));
  };
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    !types.some(
      (type) =>
        type === undefined ||
        (type === 'null'
          ? value === null
          : type === 'array'
            ? Array.isArray(value)
            : type === 'object'
              ? value !== null && typeof value === 'object' && !Array.isArray(value)
              : type === 'integer'
                ? typeof value === 'number' && Number.isInteger(value)
                : typeof value === type),
    )
  )
    fail();
  if (value === null) return;
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))
  )
    fail();
  if (schema.format === 'date' && (typeof value !== 'string' || !validDay(value))) fail();
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail();
  if (
    Array.isArray(value) &&
    ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems))
  )
    fail();
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validateToolInput(schema.items!, v, `${path}[${i}]`));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail(`${path}.${key}`);
    for (const [key, v] of Object.entries(record)) {
      if (v === undefined && !(schema.required ?? []).includes(key)) continue;
      const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (child) validateToolInput(child, v, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`${path}.${key}`);
    }
  }
}
