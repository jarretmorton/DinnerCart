// Grouping for the Recipes tab.

// Most recent of saving or sending to the cart (ISO strings sort by time).
export const lastActivity = (r) => [r.lastPickedAt, r.savedAt].filter(Boolean).sort().pop() || '';

export const RECENCY_GROUPS = ['This week', 'Last week', 'Last 30 days', 'Older'];

// Weeks start on Sunday, local time.
function startOfWeek(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function recencyGroup(iso, now = new Date()) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'Older';
  const thisWeek = startOfWeek(now).getTime();
  const lastWeek = thisWeek - 7 * 86400000;
  if (t >= thisWeek) return 'This week';
  if (t >= lastWeek) return 'Last week';
  if (t >= now.getTime() - 30 * 86400000) return 'Last 30 days';
  return 'Older';
}

// [{title, recipes}] newest first, skipping empty groups.
export function groupByRecency(recipes, now = new Date()) {
  const sorted = [...recipes].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  return RECENCY_GROUPS
    .map((title) => ({ title, recipes: sorted.filter((r) => recencyGroup(lastActivity(r), now) === title) }))
    .filter((g) => g.recipes.length);
}
