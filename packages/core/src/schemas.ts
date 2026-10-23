import { z } from 'zod';

export const CATEGORIES = [
  'report_ready',
  'invoice_failed',
  'comment_added',
  'usage_alert',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories with an immediate template. Any other category always goes to the digest. */
export const IMMEDIATE_TEMPLATES = ['report_ready', 'invoice_failed'] as const;
export type ImmediateTemplateId = (typeof IMMEDIATE_TEMPLATES)[number];
export const TEMPLATE_IDS = [...IMMEDIATE_TEMPLATES, 'digest'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export function hasImmediateTemplate(category: Category): category is ImmediateTemplateId {
  return (IMMEDIATE_TEMPLATES as readonly string[]).includes(category);
}

/**
 * Contract section 6. SQS accepts 1 MiB, but a batch of 10 arrives in one Lambda payload (6 MB
 * cap), so a whole message stays at 500 KiB.
 */
export const LIMITS = {
  subjectChars: 998,
  bodyBytes: 200 * 1024,
  messageBytes: 500 * 1024,
} as const;

// '|' is the dedup-key separator, so it must never appear inside a key part.
const keyPart = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^|\s]+$/, 'must not contain "|" or whitespace');

export const UserIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid userId');

export const DataValueSchema = z.union([z.string().max(2000), z.number(), z.boolean()]);
export type DataValue = z.infer<typeof DataValueSchema>;

export const NotificationRequestSchema = z.object({
  requestId: z.uuid(),
  userId: UserIdSchema,
  category: z.enum(CATEGORIES),
  entityId: keyPart,
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), DataValueSchema).default({}),
});
export type NotificationRequest = z.infer<typeof NotificationRequestSchema>;

export const EmailMessageSchema = z.object({
  deliveryId: z.string().regex(/^[0-9a-f]{64}$/, 'deliveryId must be a sha256 hex digest'),
  userId: UserIdSchema,
  to: z.email(),
  templateId: z.enum(TEMPLATE_IDS),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().min(1),
  category: z.enum([...CATEGORIES, 'digest']),
  kind: z.enum(['immediate', 'digest']),
  requestIds: z.array(z.uuid()).min(1),
  redact: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

export const SubscriptionSchema = z.object({
  userId: UserIdSchema,
  email: z.email(),
  timezone: z.string().min(1),
  locale: z.string().min(2).default('en'),
  immediate: z.array(z.enum(CATEGORIES)).default([]),
  digest: z.array(z.enum(CATEGORIES)).default([]),
  segment: z.number().int().min(0),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const PendingDigestItemSchema = z.object({
  userId: UserIdSchema,
  sk: z.string(),
  requestId: z.uuid(),
  category: z.enum(CATEGORIES),
  entityId: z.string(),
  occurredAt: z.string(),
  data: z.record(z.string(), DataValueSchema),
  segment: z.number().int().min(0),
  expiresAt: z.number().int(),
});
export type PendingDigestItem = z.infer<typeof PendingDigestItemSchema>;

export function pendingDigestSortKey(occurredAt: string, requestId: string): string {
  return `${occurredAt}#${requestId}`;
}

/** Contract section 6 size limits. Returns a reason when the message must be rejected permanently. */
export function messageLimitViolation(
  message: EmailMessage,
  rawBodyBytes: number,
): string | undefined {
  if (rawBodyBytes > LIMITS.messageBytes) return 'message_too_large';
  if (message.subject.length > LIMITS.subjectChars) return 'subject_too_long';
  if (/[\r\n]/.test(message.subject)) return 'subject_has_line_break';
  if (Buffer.byteLength(message.text, 'utf8') > LIMITS.bodyBytes) return 'text_too_large';
  if (Buffer.byteLength(message.html, 'utf8') > LIMITS.bodyBytes) return 'html_too_large';
  return undefined;
}

/** zod issues without the offending values, so a validation log line cannot leak an address. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path === '' ? '(root)' : path}: ${issue.code}`;
  });
}
