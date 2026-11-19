#!/usr/bin/env node
/* Минимальный валидатор JSON Schema: поддерживается ровно то подмножество,
   которое используют contracts/*.schema.json. Полный стандарт здесь не нужен:
   неподдерживаемое ключевое слово должно падать, а не тихо игнорироваться. */

const isInteger = (v) => typeof v === 'number' && Number.isInteger(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isInteger(v)) return 'integer';
  return typeof v;
};

const sameType = (expected, actual) => expected === actual || (expected === 'number' && actual === 'integer');

const SUPPORTED = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'minItems', 'maxItems', 'uniqueItems', 'format', 'description', 'title', '$schema', '$id',
]);

export class SchemaError extends Error {
  constructor(label, errors) {
    super(`${label}: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    this.name = 'SchemaError';
    this.errors = errors;
  }
}

function checkKeywords(schema, at) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new SchemaError('schema', [{ path: at, message: `unsupported keyword "${key}"` }]);
    const value = schema[key];
    if (key === 'properties' || key === 'items') {
      const walk = (s, p) => { if (s && typeof s === 'object') checkKeywords(s, p); };
      if (key === 'properties') for (const [k, sub] of Object.entries(value)) walk(sub, `${at}.properties.${k}`);
      else walk(value, `${at}.items`);
    }
  }
}

export function validate(schema, value, at = '$', errors = []) {
  checkKeywords(schema, at);

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!expected.some((t) => sameType(t, actual))) {
      errors.push({ path: at, message: `expected ${expected.join('|')}, got ${actual}` });
      return errors;
    }
  }

  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: at, message: `shorter than ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path: at, message: `longer than ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(`^(?:${schema.pattern})$`).test(value)) {
      errors.push({ path: at, message: `does not match ${schema.pattern}` });
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push({ path: at, message: 'not an ISO-8601 date-time' });
    }
    if (schema.format === 'sha256' && !/^[a-f0-9]{64}$/.test(value)) {
      errors.push({ path: at, message: 'not a lowercase sha256 hex digest' });
    }
  }

  if (isNumber(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `below minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `above maximum ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: at, message: `fewer than ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path: at, message: `more than ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push({ path: at, message: 'items must be unique' });
    }
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${at}[${i}]`, errors));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path: at, message: `missing required "${key}"` });
      }
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          errors.push({ path: `${at}.${key}`, message: 'unexpected property (additionalProperties: false)' });
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validate(sub, value[key], `${at}.${key}`, errors);
    }
  }

  return errors;
}

export function assertValid(schema, value, label) {
  const errors = validate(schema, value);
  if (errors.length) throw new SchemaError(label, errors);
  return value;
}
