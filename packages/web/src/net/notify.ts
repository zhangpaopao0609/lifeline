/** Desktop notifications: fire when an approval appears; tag-based de-dupe (same semantics as production). */

const notified = new Set<string>();

export async function notifyApproval(id: string, description: string): Promise<void> {
  if (notified.has(id))
    return;
  notified.add(id);
  if (typeof Notification === 'undefined')
    return;
  try {
    if (Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted')
        return;
    }
    if (Notification.permission !== 'granted')
      return;
    // eslint-disable-next-line no-new -- the constructor is the only way to raise one
    new Notification('Lifeline · 需要你批准', {
      body: description.slice(0, 140),
      tag: `approval:${id}`,
    });
  }
  catch { /* Silent when notifications are unavailable. */ }
}

export function clearNotified(id: string): void {
  notified.delete(id);
}
