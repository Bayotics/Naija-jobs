import { z } from 'zod';
import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS, NOTIFICATION_STATUSES } from './common';

/**
 * Notifications are modelled as a batch (`notification`) fanned out to one
 * delivery attempt per channel/recipient (`notification_delivery`), so a
 * digest that succeeds by email and fails by Telegram is representable.
 */

export const notificationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  subject: z.string().max(300),
  jobIds: z.array(z.string().uuid()),
  scheduledFor: z.date().nullable(),
  createdAt: z.date(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationDeliverySchema = z.object({
  id: z.string().uuid(),
  notificationId: z.string().uuid(),
  channel: z.enum(NOTIFICATION_CHANNELS),
  recipient: z.string().max(320),
  status: z.enum(NOTIFICATION_STATUSES),
  providerMessageId: z.string().max(255).nullable(),
  attempts: z.number().int().min(0),
  sentAt: z.date().nullable(),
  failedAt: z.date().nullable(),
  errorMessage: z.string().nullable(),
});
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;

/**
 * Channel port. Email lands in prompt 17; Telegram/Slack/webhook are additive
 * implementations of this interface plus a config entry — no pipeline change.
 */
export interface NotificationChannelAdapter {
  readonly id: (typeof NOTIFICATION_CHANNELS)[number];
  readonly capabilities: { richContent: boolean; actionButtons: boolean };
  send(payload: {
    recipient: string;
    subject: string;
    body: { html?: string; text: string };
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}
