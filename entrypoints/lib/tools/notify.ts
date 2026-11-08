/** Tool: show a desktop notification without changing Chrome focus. */
import { register, type ToolArgs } from "../registry";

const notificationWorkspaces = new Map<string, string>();

export function takeNotificationWorkspace(notificationId: string): string | undefined {
  const workspace = notificationWorkspaces.get(notificationId);
  notificationWorkspaces.delete(notificationId);
  return workspace;
}

async function notify(args: ToolArgs): Promise<unknown> {
  if (typeof args.message !== "string") throw new Error("notify: 'message' (string) is required");
  const title = typeof args.title === "string" ? args.title : "DCCB Browser Bridge";
  const notificationId = `bb-notify-${crypto.randomUUID()}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("/icon/128.png"),
    title,
    message: args.message,
  });
  notificationWorkspaces.set(notificationId, typeof args.workspace === "string" ? args.workspace : "default");
  return { ok: true };
}

register("notify", notify);
