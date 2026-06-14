const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

function call(fn, params) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return
  supabase.rpc(fn, params).then(({ error }) => {
    if (error) console.error(`[SupabaseSync] ${fn}:`, error.message)
  })
}

function syncBalance(discordId, balance) {
  call('bot_sync_balance', { p_discord_id: discordId, p_balance: balance })
}

function syncTransaction(discordId, type, amount, description) {
  call('bot_sync_transaction', { p_discord_id: discordId, p_type: type, p_amount: amount, p_description: description })
}

function syncSalary(discordId, amount, source = 'salary', note = '') {
  call('bot_sync_salary', { p_discord_id: discordId, p_amount: amount, p_source: source, p_note: note })
}

function syncShopListing(discordId, title, description, price, quantity) {
  call('bot_sync_shop_listing', { p_discord_id: discordId, p_title: title, p_description: description, p_price: price, p_quantity: quantity })
}

function deactivateShopListing(discordId, title) {
  call('bot_deactivate_shop_listing', { p_discord_id: discordId, p_title: title })
}

module.exports = { syncBalance, syncTransaction, syncSalary, syncShopListing, deactivateShopListing }
