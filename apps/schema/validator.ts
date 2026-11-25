import { ValidationBudget } from './limits';

export interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema | boolean;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  skippedPattern?: true;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  'x-kubernetes-int-or-string'?: boolean;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  'x-kubernetes-embedded-resource'?: boolean;
}

export type Path = (string | number)[];
export interface Issue {
  path: Path;
  message: string;
}

interface Evaluation {
  issues: Issue[];
  unknown: boolean;
}

const quantityRef = 'io.k8s.apimachinery.pkg.api.resource.Quantity';
const intOrStringRef = 'io.k8s.apimachinery.pkg.util.intstr.IntOrString';
const quantity = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[KMGTPE]i|[numkMGTPE]|[eE][+-]?\d+)?$/;
const dateTime = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const maxIssues = 100;

function typeOf(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const show = (value: unknown) => {
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  if (typeof value === 'string' && value.length > 60) return `${JSON.stringify(value.slice(0, 55))}...`;
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

function deepEqual(a: unknown, b: unknown, budget: ValidationBudget, depth: number): boolean {
  budget.use(depth, typeof a === 'string' ? 1 + Math.floor(a.length / 1024) : 1);
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], budget, depth + 1));
}

export class Validator {
  constructor(private readonly definitions: Record<string, Schema>, private readonly budget: ValidationBudget) {}

  validate(value: unknown, schema: Schema): Evaluation {
    return this.evaluate(value, schema, [], 0);
  }

  private evaluate(value: unknown, schema: Schema, path: Path, depth: number): Evaluation {
    const result: Evaluation = { issues: [], unknown: false };
    this.check(value, schema, path, result, depth);
    return result;
  }

  private resolve(schema: Schema) {
    let current = schema;
    for (let hops = 0; current.$ref && hops < 8; hops++) {
      const ref = current.$ref;
      if (ref === quantityRef || ref === intOrStringRef) return { ...current, $ref: undefined, format: ref === quantityRef ? 'quantity' : 'int-or-string' };
      const target = this.definitions[ref];
      if (!target) return {};
      current = target;
    }
    return current;
  }

  private check(value: unknown, input: Schema, path: Path, result: Evaluation, depth: number) {
    this.budget.use(depth, typeof value === 'string' ? 1 + Math.floor(value.length / 1024) : 1);
    const { issues } = result;
    if (issues.length >= maxIssues) return;
    const schema = this.resolve(input);
    const add = (message: string, at = path) => { if (issues.length < maxIssues) issues.push({ path: at, message }); };
    if (value === null) {
      if (path.length && typeof path.at(-1) === 'string') return;
      if (schema.nullable || !schema.type) return;
    }
    const actual = typeOf(value);

    for (const sub of schema.allOf ?? []) this.check(value, sub, path, result, depth + 1);
    for (const [keyword, options] of [['anyOf', schema.anyOf], ['oneOf', schema.oneOf]] as const) {
      if (!options?.length) continue;
      let passing = 0;
      let unknown = false;
      let closest: Issue[] | undefined;
      for (const option of options) {
        const branch = this.evaluate(value, option, path, depth + 1);
        // A checked failure rules out a branch even if it also has an unchecked pattern.
        if (branch.issues.length) {
          if (!closest || branch.issues.length < closest.length) closest = branch.issues;
        } else if (branch.unknown) {
          unknown = true;
        } else {
          passing++;
          if (keyword === 'anyOf' || passing > 1) break;
        }
      }
      if (keyword === 'oneOf' && passing > 1) add('matches more than one allowed schema (oneOf)');
      else if (unknown && (keyword === 'oneOf' || !passing)) result.unknown = true;
      if (!passing && !unknown && closest) for (const issue of closest) add(issue.message, issue.path);
    }
    if (schema.not) {
      const negated = this.evaluate(value, schema.not, path, depth + 1);
      if (!negated.issues.length) {
        if (negated.unknown) result.unknown = true;
        else add('matches a schema it must not match (not)');
      }
    }

    if (schema.format === 'int-or-string' || schema['x-kubernetes-int-or-string']) {
      if (actual !== 'integer' && actual !== 'string') return add(`expected integer or string, got ${actual}`);
      if (actual === 'integer' && Math.abs(value as number) > 2 ** 31) add(`integer ${show(value)} is out of range`);
    } else if (schema.format === 'quantity') {
      if (actual !== 'integer' && actual !== 'number' && actual !== 'string') return add(`expected a quantity, got ${actual}`);
      if (actual === 'string' && !quantity.test(value as string)) add(`invalid quantity ${show(value)}; use a number with an optional suffix such as 500m or 1Gi`);
    } else if (schema.type) {
      const matches = schema.type === actual || (schema.type === 'number' && actual === 'integer');
      if (!matches) return add(`expected ${schema.type}, got ${actual}${actual === 'object' || actual === 'array' ? '' : ` ${show(value)}`}`);
    }

    if (schema.enum && !schema.enum.some(option => deepEqual(option, value, this.budget, depth + 1))) {
      const choices = schema.enum.slice(0, 10).map(show).join(', ');
      add(`must be one of ${choices}${schema.enum.length > 10 ? ', ...' : ''}; got ${show(value)}`);
    }
    if (typeof value === 'string') {
      if (schema.skippedPattern) result.unknown = true;
      this.checkString(value, schema, add);
    } else if (typeof value === 'number') this.checkNumber(value, schema, add);
    else if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) add(`must have at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must have at most ${schema.maxItems} items`);
      if (schema.uniqueItems && value.some((item, i) => value.findIndex(other =>
        deepEqual(item, other, this.budget, depth + 1)) !== i)) add('items must be unique');
      if (schema.items) {
        for (const [i, item] of value.entries()) {
          if (issues.length >= maxIssues) break;
          this.check(item, schema.items, [...path, i], result, depth + 1);
        }
      }
    } else if (actual === 'object') {
      this.checkObject(value as Record<string, unknown>, schema, path, result, depth, add);
    }
  }

  private checkString(value: string, schema: Schema, add: (message: string) => void) {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) add(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) add(`must be at most ${schema.maxLength} characters`);
    if (schema.format === 'byte' && !base64.test(value.replace(/[\r\n]/g, ''))) add('must be base64 encoded');
    if (schema.format === 'date-time' && !dateTime.test(value)) add(`${show(value)} is not an RFC 3339 date-time`);
  }

  private checkNumber(value: number, schema: Schema, add: (message: string) => void) {
    if (schema.format === 'int32' && (value < -(2 ** 31) || value > 2 ** 31 - 1)) add(`${value} is out of range for int32`);
    if (schema.minimum !== undefined && (schema.exclusiveMinimum ? value <= schema.minimum : value < schema.minimum)) {
      add(`must be ${schema.exclusiveMinimum ? 'greater than' : 'at least'} ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && (schema.exclusiveMaximum ? value >= schema.maximum : value > schema.maximum)) {
      add(`must be ${schema.exclusiveMaximum ? 'less than' : 'at most'} ${schema.maximum}`);
    }
    if (schema.multipleOf && !Number.isInteger(value / schema.multipleOf)) add(`must be a multiple of ${schema.multipleOf}`);
  }

  private checkObject(
    value: Record<string, unknown>, schema: Schema, path: Path, result: Evaluation, depth: number,
    add: (message: string, at?: Path) => void,
  ) {
    const { issues } = result;
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) add(`must have at least ${schema.minProperties} fields`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) add(`must have at most ${schema.maxProperties} fields`);
    for (const field of schema.required ?? []) {
      if (issues.length >= maxIssues) break;
      this.budget.use(depth);
      if (!Object.hasOwn(value, field) || value[field] === undefined || value[field] === null) add(`missing required field "${field}"`);
    }
    const { properties, additionalProperties } = schema;
    const closed = additionalProperties === false ||
      (additionalProperties === undefined && properties !== undefined && !schema['x-kubernetes-preserve-unknown-fields']);
    for (const key of keys) {
      if (issues.length >= maxIssues) break;
      this.budget.use(depth);
      const property = properties && Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (property) this.check(value[key], property, [...path, key], result, depth + 1);
      else if (typeof additionalProperties === 'object') this.check(value[key], additionalProperties, [...path, key], result, depth + 1);
      else if (closed) add(`unknown field "${key}"`, [...path, key]);
    }
  }
}

export function formatPath(path: Path) {
  return path.map((part, i) => typeof part === 'number' ? `[${part}]`
    : /^[A-Za-z_$][\w$-]*$/.test(part) ? `${i ? '.' : ''}${part}` : `[${JSON.stringify(part)}]`).join('') || '(root)';
}

const crdKeys = [
  'type', 'format', 'enum', 'required', 'nullable', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'x-kubernetes-int-or-string', 'x-kubernetes-preserve-unknown-fields', 'x-kubernetes-embedded-resource',
] as const;

export const objectMetaRef = 'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta';

/** Converts a CustomResourceDefinition structural schema to the validator's schema with strict unknown-field handling. */
export function fromCrdSchema(input: unknown, budget: ValidationBudget, counter: { rules: number; patterns: number }, depth = 0): Schema {
  budget.use(depth);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const schema: Schema = {};
  for (const key of crdKeys) {
    const value = source[key];
    if (value === undefined || key === 'required' || key === 'enum') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      (schema as Record<string, unknown>)[key] = value;
    }
  }
  if (Array.isArray(source.required)) {
    budget.use(depth, source.required.length);
    schema.required = source.required.filter((value): value is string => typeof value === 'string');
  }
  if (Array.isArray(source.enum)) schema.enum = source.enum;
  if (typeof source.pattern === 'string') {
    schema.skippedPattern = true;
    counter.patterns++;
  }
  if (Array.isArray(source['x-kubernetes-validations'])) counter.rules += source['x-kubernetes-validations'].length;
  const convert = (value: unknown) => fromCrdSchema(value, budget, counter, depth + 1);
  if (source.properties && typeof source.properties === 'object') {
    schema.properties = Object.fromEntries(Object.entries(source.properties).map(([key, value]) => [key, convert(value)]));
  }
  if (source.items && typeof source.items === 'object' && !Array.isArray(source.items)) schema.items = convert(source.items);
  if (typeof source.additionalProperties === 'boolean') schema.additionalProperties = source.additionalProperties;
  else if (source.additionalProperties && typeof source.additionalProperties === 'object') schema.additionalProperties = convert(source.additionalProperties);
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(source[key])) schema[key] = (source[key] as unknown[]).map(convert);
  }
  if (source.not) schema.not = convert(source.not);
  if (schema['x-kubernetes-embedded-resource']) {
    schema.properties = { apiVersion: { type: 'string' }, kind: { type: 'string' }, metadata: { $ref: objectMetaRef }, ...schema.properties };
  }
  if (schema.additionalProperties === undefined && (schema.type === 'object' || schema.properties)) {
    // Untyped schemas inside anyOf/allOf/oneOf/not only add value validations; they never prune fields.
    schema.additionalProperties = schema.type !== 'object' || Boolean(schema['x-kubernetes-preserve-unknown-fields']);
  }
  return schema;
}
