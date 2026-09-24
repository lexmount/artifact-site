import AppShell from "@/components/app-shell";
import { NotificationList } from "@/components/notifications/notification-center";
import { getT } from "@/lib/i18n-server";
export default async function NotificationsPage() {
  const t = await getT();
  return (
    <AppShell>
      <section className="notifications-page">
        <header className="notifications-page-head">
          <h1>{t("Notification center")}</h1>
          <p>{t("Replies and mentions, all in one place.")}</p>
        </header>
        <div className="notifications-inbox"><NotificationList /></div>
      </section>
    </AppShell>
  );
}
