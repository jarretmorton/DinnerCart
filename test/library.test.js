import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByRecency, lastActivity, recencyGroup } from '../web/js/library.js';

// Wednesday Oct 21 2026, local time; this week starts Sunday Oct 18.
const now = new Date(2026, 9, 21, 12);
const at = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();

test('recencyGroup buckets by calendar week, then 30 days', () => {
  assert.equal(recencyGroup(at(2026, 9, 18, 0), now), 'This week', 'Sunday counts as this week');
  assert.equal(recencyGroup(at(2026, 9, 21), now), 'This week');
  assert.equal(recencyGroup(at(2026, 9, 17, 23), now), 'Last week', 'Saturday before');
  assert.equal(recencyGroup(at(2026, 9, 11), now), 'Last week');
  assert.equal(recencyGroup(at(2026, 9, 10), now), 'Last 30 days');
  assert.equal(recencyGroup(at(2026, 8, 22), now), 'Last 30 days');
  assert.equal(recencyGroup(at(2026, 8, 20), now), 'Older');
  assert.equal(recencyGroup(undefined, now), 'Older');
});

test('groupByRecency uses the latest of save or pick, newest first, skips empty groups', () => {
  const recipes = [
    { name: 'old save, picked today', savedAt: at(2026, 5, 1), lastPickedAt: at(2026, 9, 21) },
    { name: 'saved this week', savedAt: at(2026, 9, 19) },
    { name: 'ancient', savedAt: at(2025, 1, 1) },
  ];
  assert.equal(lastActivity(recipes[0]), at(2026, 9, 21));
  const groups = groupByRecency(recipes, now);
  assert.deepEqual(groups.map((g) => g.title), ['This week', 'Older']);
  assert.deepEqual(groups[0].recipes.map((r) => r.name), ['old save, picked today', 'saved this week']);
});
