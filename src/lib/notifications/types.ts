export type NotificationItem = {
  id: string;
  createdAt: number;
  readAt: number | null;
} & (
  | { available: false }
  | {
      available: true;
      author: string | null;
      mentioned: boolean;
      agent: boolean;
      excerpt: string;
      siteTitle: string;
      versionNumber: number;
      shared: boolean;
      shareLabel: string | null;
      threadId: string;
      messageId: string;
    }
);
export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: { time: number; id: string } | null;
}
