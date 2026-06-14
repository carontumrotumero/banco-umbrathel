const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
)

function syncBalance(discordId, balance) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return
  supabase.rpc('bot_sync_balance', {
    p_discord_id: discordId,
    p_balance: balance,
  }).then(({ error }) => {
    if (error) console.error('[SupabaseSync] balance:', error.message)
  })
}

function syncTransaction(discordId, type, amount, description) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return
  supabase.rpc('bot_sync_transaction', {
    p_discord_id: discordId,
    p_type: type,
    p_amount: amount,
    p_description: description,
  }).then(({ error }) => {
    if (error) console.error('[SupabaseSync] transaction:', error.message)
  })
}

module.exports = { syncBalance, syncTransaction }

