const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { syncBalance, syncTransaction } = require('./utils/supabaseSync');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
      discord_id TEXT NOT NULL,
      minecraft_uuid TEXT NOT NULL,
      minecraft_username TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY (discord_id),
      UNIQUE (minecraft_uuid)
    );

    CREATE TABLE IF NOT EXISTS pending (
      discord_id TEXT PRIMARY KEY,
      minecraft_username TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_activity (
      discord_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      last_active INTEGER NOT NULL,
      PRIMARY KEY (discord_id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS mc_pending (
      code TEXT PRIMARY KEY,
      minecraft_username TEXT NOT NULL,
      minecraft_uuid TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_permissions (
      guild_id TEXT NOT NULL,
      command TEXT NOT NULL,
      type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, command, type, target_id)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      minecraft_uuid TEXT PRIMARY KEY,
      minecraft_username TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (guild_id, key)
    );

    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS economy (
      discord_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      total_earned REAL NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (discord_id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role_id TEXT NOT NULL,
      salary REAL NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (guild_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS shop_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT -1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auctions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      description TEXT,
      starting_price REAL NOT NULL,
      current_price REAL NOT NULL,
      current_bidder TEXT,
      ends_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
}

// --- Verifications ---
function getVerificationByDiscord(discordId) {
  return db.prepare('SELECT * FROM verifications WHERE discord_id = ?').get(discordId);
}

function getVerificationByMinecraft(uuid) {
  return db.prepare('SELECT * FROM verifications WHERE minecraft_uuid = ?').get(uuid);
}

function addVerification(discordId, uuid, username) {
  db.prepare(
    'INSERT OR REPLACE INTO verifications (discord_id, minecraft_uuid, minecraft_username, verified_at) VALUES (?, ?, ?, ?)'
  ).run(discordId, uuid, username, Date.now());
}

function removeVerification(discordId) {
  db.prepare('DELETE FROM verifications WHERE discord_id = ?').run(discordId);
}

function getAllVerifications() {
  return db.prepare('SELECT * FROM verifications').all();
}

// --- Pending ---
function getPending(discordId) {
  return db.prepare('SELECT * FROM pending WHERE discord_id = ?').get(discordId);
}

function setPending(discordId, username, code) {
  db.prepare(
    'INSERT OR REPLACE INTO pending (discord_id, minecraft_username, code, created_at) VALUES (?, ?, ?, ?)'
  ).run(discordId, username, code, Date.now());
}

function removePending(discordId) {
  db.prepare('DELETE FROM pending WHERE discord_id = ?').run(discordId);
}

function cleanExpiredPending(maxAgeMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  db.prepare('DELETE FROM pending WHERE created_at < ?').run(cutoff);
}

// --- Watchlist ---
function getWatchlist() {
  return db.prepare('SELECT * FROM watchlist ORDER BY added_at DESC').all();
}

function isWatchlisted(uuid) {
  return !!db.prepare('SELECT 1 FROM watchlist WHERE minecraft_uuid = ?').get(uuid);
}

function addToWatchlist(uuid, username, addedBy) {
  db.prepare(
    'INSERT OR REPLACE INTO watchlist (minecraft_uuid, minecraft_username, added_by, added_at) VALUES (?, ?, ?, ?)'
  ).run(uuid, username, addedBy, Date.now());
}

function removeFromWatchlist(uuid) {
  const result = db.prepare('DELETE FROM watchlist WHERE minecraft_uuid = ?').run(uuid);
  return result.changes > 0;
}

// --- Config ---
function getConfig(guildId, key) {
  const row = db.prepare('SELECT value FROM config WHERE guild_id = ? AND key = ?').get(guildId, key);
  return row ? row.value : null;
}

function setConfig(guildId, key, value) {
  db.prepare('INSERT OR REPLACE INTO config (guild_id, key, value) VALUES (?, ?, ?)').run(guildId, key, value);
}

function deleteConfig(guildId, key) {
  const result = db.prepare('DELETE FROM config WHERE guild_id = ? AND key = ?').run(guildId, key);
  return result.changes > 0;
}

function getAllConfig(guildId) {
  return db.prepare('SELECT key, value FROM config WHERE guild_id = ?').all(guildId);
}

// --- Warnings ---
function addWarning(guildId, discordId, reason, moderatorId) {
  return db.prepare(
    'INSERT INTO warnings (guild_id, discord_id, reason, moderator_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(guildId, discordId, reason, moderatorId, Date.now());
}

function getWarnings(guildId, discordId) {
  return db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND discord_id = ? ORDER BY created_at DESC').all(guildId, discordId);
}

function clearWarnings(guildId, discordId) {
  return db.prepare('DELETE FROM warnings WHERE guild_id = ? AND discord_id = ?').run(guildId, discordId).changes;
}

function deleteWarning(id) {
  return db.prepare('DELETE FROM warnings WHERE id = ?').run(id).changes > 0;
}

// --- Economy ---
function getBalance(guildId, discordId) {
  let row = db.prepare('SELECT * FROM economy WHERE discord_id = ? AND guild_id = ?').get(discordId, guildId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO economy (discord_id, guild_id, balance) VALUES (?, ?, 0)').run(discordId, guildId);
    row = db.prepare('SELECT * FROM economy WHERE discord_id = ? AND guild_id = ?').get(discordId, guildId);
  }
  return row;
}

function addBalance(guildId, discordId, amount, description = '', type = 'credit') {
  getBalance(guildId, discordId);
  db.prepare('UPDATE economy SET balance = balance + ?, total_earned = total_earned + ? WHERE discord_id = ? AND guild_id = ?')
    .run(amount, amount > 0 ? amount : 0, discordId, guildId);
  db.prepare('INSERT INTO transactions (guild_id, discord_id, type, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, discordId, type, amount, description, Date.now());
  const newBalance = getBalance(guildId, discordId).balance;
  syncBalance(discordId, newBalance);
  syncTransaction(discordId, type, amount, description);
}

function removeBalance(guildId, discordId, amount, description = '', type = 'debit') {
  getBalance(guildId, discordId);
  db.prepare('UPDATE economy SET balance = balance - ?, total_spent = total_spent + ? WHERE discord_id = ? AND guild_id = ?')
    .run(amount, amount, discordId, guildId);
  db.prepare('INSERT INTO transactions (guild_id, discord_id, type, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, discordId, type, amount, description, Date.now());
  const newBalance = getBalance(guildId, discordId).balance;
  syncBalance(discordId, newBalance);
  syncTransaction(discordId, type, amount, description);
}

function setBalance(guildId, discordId, amount) {
  getBalance(guildId, discordId);
  db.prepare('UPDATE economy SET balance = ? WHERE discord_id = ? AND guild_id = ?').run(amount, discordId, guildId);
  syncBalance(discordId, amount);
}

function getTopBalances(guildId, limit = 10) {
  return db.prepare('SELECT * FROM economy WHERE guild_id = ? ORDER BY balance DESC LIMIT ?').all(guildId, limit);
}

function getTransactions(guildId, discordId, limit = 10) {
  return db.prepare('SELECT * FROM transactions WHERE guild_id = ? AND discord_id = ? ORDER BY created_at DESC LIMIT ?').all(guildId, discordId, limit);
}

// --- Jobs ---
function createJob(guildId, name, roleId, salary, createdBy) {
  return db.prepare('INSERT OR REPLACE INTO jobs (guild_id, name, role_id, salary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, name, roleId, salary, createdBy, Date.now());
}

function getJobs(guildId) {
  return db.prepare('SELECT * FROM jobs WHERE guild_id = ? ORDER BY name ASC').all(guildId);
}

function getJobByRole(guildId, roleId) {
  return db.prepare('SELECT * FROM jobs WHERE guild_id = ? AND role_id = ?').get(guildId, roleId);
}

function getJobById(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function deleteJob(id) {
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
}

function editJobSalary(id, salary) {
  return db.prepare('UPDATE jobs SET salary = ? WHERE id = ?').run(salary, id).changes > 0;
}

function getAllEconomyMembers(guildId) {
  return db.prepare('SELECT * FROM economy WHERE guild_id = ?').all(guildId);
}

// --- Shop ---
function createListing(guildId, sellerId, itemName, description, price, quantity) {
  return db.prepare('INSERT INTO shop_listings (guild_id, seller_id, item_name, description, price, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(guildId, sellerId, itemName, description, price, quantity, Date.now());
}

function getListings(guildId) {
  return db.prepare('SELECT * FROM shop_listings WHERE guild_id = ? AND (quantity > 0 OR quantity = -1) ORDER BY created_at DESC').all(guildId);
}

function getListing(id) {
  return db.prepare('SELECT * FROM shop_listings WHERE id = ?').get(id);
}

function decrementListing(id) {
  const listing = getListing(id);
  if (!listing) return false;
  if (listing.quantity === -1) return true;
  if (listing.quantity <= 0) return false;
  db.prepare('UPDATE shop_listings SET quantity = quantity - 1 WHERE id = ?').run(id);
  return true;
}

function removeListing(id) {
  return db.prepare('DELETE FROM shop_listings WHERE id = ?').run(id).changes > 0;
}

// --- Auctions ---
function createAuction(guildId, sellerId, itemName, description, startingPrice, endsAt) {
  return db.prepare(
    'INSERT INTO auctions (guild_id, seller_id, item_name, description, starting_price, current_price, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(guildId, sellerId, itemName, description, startingPrice, startingPrice, endsAt, Date.now());
}

function getAuction(id) {
  return db.prepare('SELECT * FROM auctions WHERE id = ?').get(id);
}

function getActiveAuctions(guildId) {
  return db.prepare("SELECT * FROM auctions WHERE guild_id = ? AND status = 'active' ORDER BY ends_at ASC").all(guildId);
}

function getExpiredAuctions() {
  return db.prepare("SELECT * FROM auctions WHERE status = 'active' AND ends_at <= ?").all(Date.now());
}

function placeBid(id, bidderId, amount) {
  return db.prepare('UPDATE auctions SET current_price = ?, current_bidder = ? WHERE id = ?').run(amount, bidderId, id).changes > 0;
}

function closeAuction(id, status = 'ended') {
  return db.prepare('UPDATE auctions SET status = ? WHERE id = ?').run(status, id).changes > 0;
}

module.exports = {
  init,
  getVerificationByDiscord,
  getVerificationByMinecraft,
  addVerification,
  removeVerification,
  getAllVerifications,
  getPending,
  setPending,
  removePending,
  cleanExpiredPending,
  getWatchlist,
  isWatchlisted,
  addToWatchlist,
  removeFromWatchlist,
  getConfig,
  setConfig,
  deleteConfig,
  getAllConfig,
  addWarning,
  getWarnings,
  clearWarnings,
  deleteWarning,
  // Economy
  getBalance,
  addBalance,
  removeBalance,
  setBalance,
  getTopBalances,
  getTransactions,
  getAllEconomyMembers,
  // Jobs
  createJob,
  getJobs,
  getJobByRole,
  getJobById,
  deleteJob,
  editJobSalary,
  // Shop
  createListing,
  getListings,
  getListing,
  decrementListing,
  removeListing,
  // Auctions
  createAuction,
  getAuction,
  getActiveAuctions,
  getExpiredAuctions,
  placeBid,
  closeAuction,
  // Activity
  updateActivity,
  getActivity,
  // MC Pending
  addMcPending,
  getMcPending,
  deleteMcPending,
  // Command permissions
  grantPermission,
  revokePermission,
  getCommandPermissions,
  hasCustomPermission,
};

// ── MC Pending (verificación desde plugin de Minecraft) ───────────────────────

// ── User Activity ─────────────────────────────────────────────────────────────

function updateActivity(guildId, discordId) {
  db.prepare('INSERT INTO user_activity (discord_id, guild_id, last_active) VALUES (?, ?, ?) ON CONFLICT(discord_id, guild_id) DO UPDATE SET last_active = excluded.last_active')
    .run(discordId, guildId, Date.now());
}

function getActivity(guildId, discordId) {
  return db.prepare('SELECT * FROM user_activity WHERE guild_id = ? AND discord_id = ?').get(guildId, discordId);
}

// ── MC Pending ────────────────────────────────────────────────────────────────

function addMcPending(username, uuid, code, expiresAt) {
  // Eliminar códigos anteriores del mismo jugador
  db.prepare('DELETE FROM mc_pending WHERE minecraft_username = ?').run(username);
  db.prepare('INSERT OR REPLACE INTO mc_pending (code, minecraft_username, minecraft_uuid, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, username, uuid, expiresAt);
}

function getMcPending(code) {
  // Eliminar expirados primero
  db.prepare('DELETE FROM mc_pending WHERE expires_at < ?').run(Date.now());
  return db.prepare('SELECT * FROM mc_pending WHERE code = ?').get(code);
}

function deleteMcPending(code) {
  db.prepare('DELETE FROM mc_pending WHERE code = ?').run(code);
}

// ── Command permissions ───────────────────────────────────────────────────────

function grantPermission(guildId, command, type, targetId) {
  db.prepare('INSERT OR IGNORE INTO command_permissions (guild_id, command, type, target_id) VALUES (?, ?, ?, ?)')
    .run(guildId, command, type, targetId);
}

function revokePermission(guildId, command, type, targetId) {
  db.prepare('DELETE FROM command_permissions WHERE guild_id = ? AND command = ? AND type = ? AND target_id = ?')
    .run(guildId, command, type, targetId);
}

function getCommandPermissions(guildId, command) {
  return db.prepare('SELECT * FROM command_permissions WHERE guild_id = ? AND command = ?').all(guildId, command);
}

// Devuelve true si el miembro tiene permiso personalizado para el comando
function hasCustomPermission(guildId, command, member) {
  const perms = db.prepare('SELECT * FROM command_permissions WHERE guild_id = ? AND command = ?').all(guildId, command);
  if (!perms.length) return null; // null = no hay permisos configurados para este comando

  // Comprobar si el usuario está en la lista
  if (perms.some(p => p.type === 'user' && p.target_id === member.id)) return true;
  // Comprobar si alguno de sus roles está en la lista
  if (perms.some(p => p.type === 'role' && member.roles.cache.has(p.target_id))) return true;

  return false;
}
