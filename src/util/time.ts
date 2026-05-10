/**
 * Format a millisecond timestamp as "X ago".
 */
export function humanTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (sec < 60) return 'just now';
  if (min === 1) return '1 minute ago';
  if (min < 60) return `${min} minutes ago`;
  if (hr === 1) return '1 hour ago';
  if (hr < 24) return `${hr} hours ago`;
  if (day === 1) return '1 day ago';
  if (day < 30) return `${day} days ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
