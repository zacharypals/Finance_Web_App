// v0.10.0: Tags — list/create/edit/delete, and which Plaid codes feed each tag.
// Changing a tag's Plaid codes re-tags ALL history for that tag (automatic tags only; yours stay).
import { json } from './util.js';
import { tagStatements, HH_ACCOUNTS } from './categorize.js';
import { ensureReady } from './transactions.js';

const CODE_RE = /^(P:)?[A-Z][A-Z_]{1,80}$/;

function cleanCodes(v) {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map(String).filter((c) => CODE_RE.test(c)))].slice(0, 60);
}

async function ownedTag(env, user, id) {
  return env.DB.prepare('SELECT * FROM tags WHERE id = ? AND household_id = ?').bind(id, user.household_id).first();
}

async function tagRules(env, user, tagId) {
  return (await env.DB.prepare('SELECT * FROM category_rules WHERE household_id = ? AND enabled = 1 AND tag_id = ?')
    .bind(user.household_id, tagId).all()).results;
}

// Replace a tag's Plaid codes and rebuild its automatic tags over all history.
async function setCodes(env, user, tagId, codes) {
  const stmts = [env.DB.prepare('DELETE FROM plaid_tag_map WHERE household_id = ? AND tag_id = ?').bind(user.household_id, tagId)];
  for (const c of codes) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO plaid_tag_map (household_id, pfc_detailed, tag_id) VALUES (?, ?, ?)')
      .bind(user.household_id, c, tagId));
  }
  stmts.push(...tagStatements(env, user.household_id, await tagRules(env, user, tagId), { tagId, reset: true }));
  await env.DB.batch(stmts);
}

const tagged = async (env, tagId) =>
  ((await env.DB.prepare("SELECT COUNT(*) AS n FROM transaction_tags WHERE tag_id = ? AND source != 'off'").bind(tagId).first()) || {}).n || 0;

export async function listTags(env, user) {
  await ensureReady(env, user.household_id);
  const { results } = await env.DB.prepare(
    `SELECT tg.id, tg.name, tg.color, tg.sort,
            (SELECT group_concat(m.pfc_detailed) FROM plaid_tag_map m WHERE m.household_id = tg.household_id AND m.tag_id = tg.id) AS plaid_codes
       FROM tags tg WHERE tg.household_id = ? ORDER BY tg.sort, tg.name COLLATE NOCASE`
  ).bind(user.household_id).all();
  return json({ tags: results.map((t) => ({ ...t, plaid_codes: t.plaid_codes ? t.plaid_codes.split(',').sort() : [] })) });
}

export async function createTag(env, user, body) {
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) return json({ error: 'bad_request', message: 'Name is required.' }, 400);
  await ensureReady(env, user.household_id);
  const dup = await env.DB.prepare('SELECT id FROM tags WHERE household_id = ? AND name = ? COLLATE NOCASE').bind(user.household_id, name).first();
  if (dup) return json({ error: 'conflict', message: 'You already have a tag called ' + name + '.', id: dup.id }, 409);
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM tags WHERE household_id = ?').bind(user.household_id).first();
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO tags (id, household_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, user.household_id, name, (max ? max.m : 0) + 1, Date.now()).run();
  const codes = cleanCodes(body.plaid_codes);
  if (codes && codes.length) await setCodes(env, user, id, codes);
  return json({ id, tagged: codes && codes.length ? await tagged(env, id) : 0 });
}

// Body: { name?, color?, plaid_codes? }
export async function patchTag(env, user, id, body) {
  const tag = await ownedTag(env, user, id);
  if (!tag) return json({ error: 'not_found' }, 404);
  const name = 'name' in body ? String(body.name || '').trim().slice(0, 30) || tag.name : tag.name;
  if (name.toLowerCase() !== tag.name.toLowerCase()) {
    const dup = await env.DB.prepare('SELECT 1 FROM tags WHERE household_id = ? AND name = ? COLLATE NOCASE AND id != ?').bind(user.household_id, name, id).first();
    if (dup) return json({ error: 'conflict', message: 'You already have a tag called ' + name + '.' }, 409);
  }
  const color = 'color' in body ? (/^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? body.color : null) : tag.color;
  await env.DB.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').bind(name, color, id).run();
  const codes = cleanCodes(body.plaid_codes);
  if (codes) await setCodes(env, user, id, codes);
  return json({ ok: true, tagged: await tagged(env, id) });
}

// Removes the tag from every transaction; rules that only set this tag are deleted, others keep their category.
export async function deleteTag(env, user, id) {
  const tag = await ownedTag(env, user, id);
  if (!tag) return json({ error: 'not_found' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM category_rules WHERE household_id = ? AND tag_id = ? AND category_id IS NULL').bind(user.household_id, id),
    env.DB.prepare('UPDATE category_rules SET tag_id = NULL WHERE household_id = ? AND tag_id = ?').bind(user.household_id, id),
    env.DB.prepare('DELETE FROM plaid_tag_map WHERE household_id = ? AND tag_id = ?').bind(user.household_id, id),
    env.DB.prepare('DELETE FROM transaction_tags WHERE tag_id = ?').bind(id),
    env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// Plaid codes that appear in your transactions (for the tag editor). One pass over your
// transactions — only called when you open a tag's editor, never on routine loads.
export async function plaidCodes(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT pfc_detailed AS code, pfc_primary AS primary_code, COUNT(*) AS n, SUM(amount) AS total
       FROM transactions WHERE account_id IN (${HH_ACCOUNTS}) AND removed = 0 AND pfc_detailed IS NOT NULL
      GROUP BY pfc_detailed ORDER BY n DESC`
  ).bind(user.household_id).all();
  return json({ codes: results });
}
