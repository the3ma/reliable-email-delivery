import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/app';
import type { EmailDeliveryStack } from '../lib/email-delivery-stack';

export type Context = Record<string, string | number | boolean>;
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, Json>;

export interface CfnResource {
  Type: string;
  Properties?: JsonObject;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

export interface Synth {
  app: App;
  stack: EmailDeliveryStack;
  template: Template;
  resources: Record<string, CfnResource>;
}

export const PROD: Context = {
  stage: 'prod',
  alarmEmail: 'ops@example.test',
  sendingDomain: 'example.test',
  fromAddress: 'notifications@example.test',
};

const FEATURE_FLAGS = (
  JSON.parse(readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')) as { context: Context }
).context;

/** Synthesizes the stack exactly as `cdk synth` would (same feature flags), with placeholder code. */
export function synth(context: Context = {}, opts: { nag?: boolean } = {}): Synth {
  const app = new App({ context: { ...FEATURE_FLAGS, skipBundling: true, ...context } });
  const stack = buildApp(app, { nag: opts.nag ?? false });
  const template = Template.fromStack(stack);
  const resources = (template.toJSON() as { Resources: Record<string, CfnResource> }).Resources;
  return { app, stack, template, resources };
}

export function ofType(
  resources: Record<string, CfnResource>,
  type: string,
): [string, CfnResource][] {
  return Object.entries(resources).filter(([, r]) => r.Type === type);
}

export function props(resource: CfnResource): JsonObject {
  return resource.Properties ?? {};
}

/** Logical id referenced by `{ Ref: X }` or `{ Fn::GetAtt: [X, ...] }`. */
export function refId(value: Json | undefined): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.Ref === 'string') return value.Ref;
  const getAtt = value['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  return undefined;
}

export function functionByName(s: Synth, name: string): [string, CfnResource] {
  const found = ofType(s.resources, 'AWS::Lambda::Function').find(
    ([, r]) => props(r).FunctionName === `${s.stack.config.prefix}-${name}`,
  );
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

export interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: Json;
  Condition?: JsonObject;
  Sid?: string;
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** All identity-policy statements attached to a role (logical id). */
export function roleStatements(s: Synth, roleId: string): Statement[] {
  return ofType(s.resources, 'AWS::IAM::Policy')
    .filter(([, r]) => asArray(props(r).Roles as Json[]).some((role) => refId(role) === roleId))
    .flatMap(
      ([, r]) => (props(r).PolicyDocument as unknown as { Statement: Statement[] }).Statement,
    );
}

export function functionStatements(s: Synth, name: string): Statement[] {
  const [, fn] = functionByName(s, name);
  const roleId = refId(props(fn).Role);
  if (!roleId) throw new Error(`function ${name} has no role in this stack`);
  return roleStatements(s, roleId);
}

export function actionsOf(statements: Statement[]): string[] {
  return statements.flatMap((st) => asArray(st.Action));
}

/** Statements granting `action`. */
export function granting(statements: Statement[], action: string): Statement[] {
  return statements.filter((st) => asArray(st.Action).includes(action));
}

export function stringify(value: Json | undefined): string {
  return JSON.stringify(value ?? null);
}

export function tableId(s: Synth, name: string): string {
  const found = ofType(s.resources, 'AWS::DynamoDB::Table').find(([, r]) =>
    text(props(r).TableName).endsWith(`-${name}`),
  );
  if (!found) throw new Error(`table ${name} not found`);
  return found[0];
}

/** Whether any of the statements names the table (its ARN or its index ARNs). */
export function touchesTable(statements: Statement[], s: Synth, name: string): boolean {
  const id = tableId(s, name);
  return statements.some((st) => stringify(st.Resource).includes(`"${id}"`));
}

/** A template value as text: strings as-is, anything else (an intrinsic) as JSON. */
export function text(value: Json | undefined): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
