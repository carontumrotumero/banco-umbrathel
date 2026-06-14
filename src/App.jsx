import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, supabaseConfigError } from './supabaseClient'

const CURRENCY = 'Ḡ'

function formatMoney(value) {
  return `${CURRENCY} ${Number(value || 0).toFixed(2)}`
}

function signedAmount(tx) {
  if (!tx) return 0
  if (['admin_debit', 'transfer_out', 'withdraw', 'marketplace_buy'].includes(tx.type)) {
    return -Math.abs(Number(tx.amount || 0))
  }
  return Math.abs(Number(tx.amount || 0))
}

function parseTierDiscounts(raw) {
  if (!raw.trim()) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((pair) => {
      const [min, pct] = pair.split(':').map((s) => Number(s.trim()))
      return { min_qty: min, discount_percent: pct }
    })
    .filter((tier) => tier.min_qty > 0 && tier.discount_percent >= 0 && tier.discount_percent <= 100)
    .sort((a, b) => a.min_qty - b.min_qty)
}

function resolveDiscount(base, tiers, quantity) {
  let discount = Number(base || 0)
  ;(tiers || []).forEach((tier) => {
    if (quantity >= Number(tier.min_qty || 0)) {
      discount = Math.max(discount, Number(tier.discount_percent || 0))
    }
  })
  return Math.min(100, Math.max(0, discount))
}

function AuthView() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function loginWithDiscord() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: window.location.origin },
    })
    if (error) { setError(error.message); setLoading(false) }
  }

  return (
    <div className="auth-card">
      <h1>Banco de Umbrathel</h1>
      <p className="subtitle">Tu banco digital con moneda oficial {CURRENCY}</p>
      <button onClick={loginWithDiscord} disabled={loading} style={{ background: '#5865F2', fontSize: '1rem', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '1.5rem auto', cursor: loading ? 'not-allowed' : 'pointer' }}>
        <svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="white"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
        {loading ? 'Conectando...' : 'Iniciar sesión con Discord'}
      </button>
      {error && <p className="message">{error}</p>}
      <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '1rem' }}>Solo usuarios del servidor de Umbrathel</p>
    </div>
  )
}

function Dashboard({ session }) {
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [tab, setTab] = useState('bank')

  const [profile, setProfile] = useState(null)
  const [account, setAccount] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [users, setUsers] = useState([])
  const [salaryRecords, setSalaryRecords] = useState([])
  const [listings, setListings] = useState([])

  const [transferToDiscord, setTransferToDiscord] = useState('')
  const [transferAmount, setTransferAmount] = useState('')

  const [adminUserId, setAdminUserId] = useState('')
  const [adminAmount, setAdminAmount] = useState('')
  const [salaryUserId, setSalaryUserId] = useState('')
  const [salaryAmount, setSalaryAmount] = useState('')
  const [salarySource, setSalarySource] = useState('salary')
  const [salaryNote, setSalaryNote] = useState('')

  const [listingTitle, setListingTitle] = useState('')
  const [listingDescription, setListingDescription] = useState('')
  const [listingPrice, setListingPrice] = useState('')
  const [listingStock, setListingStock] = useState('1')
  const [listingUnlimited, setListingUnlimited] = useState(false)
  const [listingBaseDiscount, setListingBaseDiscount] = useState('0')
  const [listingTiers, setListingTiers] = useState('')

  const [buyQtyByListing, setBuyQtyByListing] = useState({})

  const refreshTimer = useRef(null)
  const isAdmin = useMemo(() => profile?.role === 'admin', [profile])

  const loadData = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setMessage('')
    }

    const [{ data: p, error: pErr }, { data: acc, error: accErr }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', session.user.id).single(),
      supabase.from('accounts').select('*').eq('user_id', session.user.id).single()
    ])

    if (pErr || accErr) {
      if (!silent) setMessage(pErr?.message || accErr?.message || 'Error cargando datos')
      if (!silent) setLoading(false)
      return
    }

    setProfile(p)
    setAccount(acc)

    const [txRes, salaryRes, listingsRes] = await Promise.all([
      supabase.from('transactions_view').select('*').order('created_at', { ascending: false }).limit(60),
      supabase.from('salary_records').select('*').order('paid_at', { ascending: false }).limit(40),
      supabase.from('market_listings').select('*').order('created_at', { ascending: false })
    ])

    if (txRes.error && !silent) setMessage(txRes.error.message)
    if (salaryRes.error && !silent) setMessage(salaryRes.error.message)
    if (listingsRes.error && !silent) setMessage(listingsRes.error.message)

    if (!txRes.error) setTransactions(txRes.data || [])
    if (!salaryRes.error) setSalaryRecords(salaryRes.data || [])
    if (!listingsRes.error) setListings(listingsRes.data || [])

    if (p.role === 'admin') {
      const { data: userList, error: userErr } = await supabase
        .from('profiles')
        .select('id, email, full_name, discord_id, discord_username')
        .order('discord_username', { ascending: true })
      if (userErr && !silent) setMessage(userErr.message)
      setUsers(userList || [])
    }

    if (!silent) setLoading(false)
  }, [session.user.id])

  function scheduleRefresh() {
    if (refreshTimer.current) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      loadData(true)
    }, 250)
  }

  useEffect(() => {
    loadData()

    const channel = supabase
      .channel(`bank-live-${session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'salary_records' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'market_listings' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'market_purchases' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      supabase.removeChannel(channel)
    }
  }, [loadData, session.user.id])

  async function runRpc(name, payload) {
    setMessage('')
    const { error } = await supabase.rpc(name, payload)
    if (error) {
      setMessage(error.message)
      return false
    }
    await loadData(true)
    return true
  }

  async function doTransfer(e) {
    e.preventDefault()
    if (!transferAmount || !transferToDiscord) return
    const ok = await runRpc('transfer_by_discord', {
      p_to_discord_id: transferToDiscord.trim(),
      p_amount: Number(transferAmount)
    })
    if (ok) {
      setTransferToDiscord('')
      setTransferAmount('')
    }
  }

  async function doAdminAdjust(e) {
    e.preventDefault()
    if (!adminUserId || !adminAmount) return
    const ok = await runRpc('admin_adjust_user_balance', {
      p_user_id: adminUserId,
      p_amount: Number(adminAmount)
    })
    if (ok) setAdminAmount('')
  }

  async function doSalary(e) {
    e.preventDefault()
    if (!salaryUserId || !salaryAmount) return
    const ok = await runRpc('admin_add_salary', {
      p_user_id: salaryUserId,
      p_amount: Number(salaryAmount),
      p_source: salarySource,
      p_note: salaryNote
    })
    if (ok) {
      setSalaryAmount('')
      setSalaryNote('')
    }
  }

  async function doCreateListing(e) {
    e.preventDefault()
    const tiers = parseTierDiscounts(listingTiers)

    const payload = {
      seller_id: session.user.id,
      title: listingTitle,
      description: listingDescription,
      unit_price: Number(listingPrice),
      stock: listingUnlimited ? null : Number(listingStock),
      is_unlimited: listingUnlimited,
      base_discount_percent: Number(listingBaseDiscount || 0),
      tier_discounts: tiers,
      is_active: true
    }

    setMessage('')
    const { error } = await supabase.from('market_listings').insert(payload)
    if (error) {
      setMessage(error.message)
      return
    }

    setListingTitle('')
    setListingDescription('')
    setListingPrice('')
    setListingStock('1')
    setListingUnlimited(false)
    setListingBaseDiscount('0')
    setListingTiers('')
    await loadData(true)
  }

  async function doBuy(listingId) {
    const quantity = Number(buyQtyByListing[listingId] || 1)
    if (!quantity || quantity <= 0) return

    const ok = await runRpc('buy_market_listing', {
      p_listing_id: listingId,
      p_quantity: quantity
    })

    if (ok) {
      setBuyQtyByListing((prev) => ({ ...prev, [listingId]: 1 }))
    }
  }

  async function signOut() {
    await supabase.auth.signOut()
    window.location.reload()
  }

  if (loading) return <p className="loading">Cargando panel bancario...</p>

  const visibleListings = listings.filter((item) => item.is_active || item.seller_id === session.user.id)

  return (
    <div className="container">
      <header className="topbar">
        <div>
          <h1>Banco de Umbrathel</h1>
          <p>
            {profile?.discord_username || profile?.full_name || profile?.email || session.user.email} · Rol: <strong>{profile?.role || 'user'}</strong>
          </p>
        </div>
        <button onClick={signOut}>Cerrar sesión</button>
      </header>

      <section className="card tabs">
        <button className={tab === 'bank' ? 'tab-btn active' : 'tab-btn'} onClick={() => setTab('bank')}>Banco</button>
        <button className={tab === 'salary' ? 'tab-btn active' : 'tab-btn'} onClick={() => setTab('salary')}>Salarios</button>
        <button className={tab === 'market' ? 'tab-btn active' : 'tab-btn'} onClick={() => setTab('market')}>Mercado</button>
      </section>

      <section className="card balance">
        <h2>Saldo disponible</h2>
        <p className="amount">{formatMoney(account?.balance)}</p>
      </section>

      {tab === 'bank' && (
        <>
          <section className="grid">
            <form className="card" onSubmit={doTransfer}>
              <h3>Transferencia</h3>
              <input placeholder="ID de Discord del destinatario" value={transferToDiscord} onChange={(e) => setTransferToDiscord(e.target.value)} required />
              <small style={{ color: '#888', marginTop: '-0.5rem' }}>Clic derecho en el usuario → Copiar ID de usuario</small>
              <input type="number" min="0.01" step="0.01" placeholder="Monto" value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} required />
              <button type="submit">Transferir</button>
            </form>

            {isAdmin && (
              <section className="card admin">
                <h3>Panel Administrador</h3>
                <p>Ajuste manual: positivo suma, negativo resta.</p>
                <form onSubmit={doAdminAdjust}>
                  <select value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)} required>
                    <option value="">Selecciona usuario</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.discord_username || u.full_name || u.email}</option>
                    ))}
                  </select>
                  <input type="number" step="0.01" placeholder="Monto (+/-)" value={adminAmount} onChange={(e) => setAdminAmount(e.target.value)} required />
                  <button type="submit">Aplicar ajuste</button>
                </form>
              </section>
            )}
          </section>

          <section className="card">
            <h3>Movimientos</h3>
            {transactions.length === 0 ? (
              <p>No hay movimientos aún.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th>Detalle</th>
                    <th>Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td>{new Date(tx.created_at).toLocaleString()}</td>
                      <td>{tx.type}</td>
                      <td>{tx.detail}</td>
                      <td>{formatMoney(signedAmount(tx))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === 'salary' && (
        <>
          {isAdmin && (
            <section className="card admin">
              <h3>Registrar salario</h3>
              <form onSubmit={doSalary}>
                <select value={salaryUserId} onChange={(e) => setSalaryUserId(e.target.value)} required>
                  <option value="">Selecciona usuario</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.discord_username || u.full_name || u.email}</option>
                  ))}
                </select>
                <input type="number" min="0.01" step="0.01" placeholder="Monto salario" value={salaryAmount} onChange={(e) => setSalaryAmount(e.target.value)} required />
                <input placeholder="Origen (ej: nomina)" value={salarySource} onChange={(e) => setSalarySource(e.target.value)} />
                <input placeholder="Nota" value={salaryNote} onChange={(e) => setSalaryNote(e.target.value)} />
                <button type="submit">Pagar salario</button>
              </form>
            </section>
          )}

          <section className="card">
            <h3>Historial de salarios</h3>
            {salaryRecords.length === 0 ? (
              <p>No hay pagos de salario aún.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Origen</th>
                    <th>Nota</th>
                    <th>Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {salaryRecords.map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.paid_at).toLocaleString()}</td>
                      <td>{row.source}</td>
                      <td>{row.note || '-'}</td>
                      <td>{formatMoney(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === 'market' && (
        <>
          <section className="card">
            <h3>Publicar artículo</h3>
            <form onSubmit={doCreateListing}>
              <input placeholder="Título" value={listingTitle} onChange={(e) => setListingTitle(e.target.value)} required />
              <input placeholder="Descripción" value={listingDescription} onChange={(e) => setListingDescription(e.target.value)} />
              <input type="number" min="0.01" step="0.01" placeholder="Precio unitario" value={listingPrice} onChange={(e) => setListingPrice(e.target.value)} required />
              <label className="inline-check">
                <input type="checkbox" checked={listingUnlimited} onChange={(e) => setListingUnlimited(e.target.checked)} />
                Stock ilimitado
              </label>
              {!listingUnlimited && (
                <input type="number" min="1" step="1" placeholder="Stock" value={listingStock} onChange={(e) => setListingStock(e.target.value)} required />
              )}
              <input type="number" min="0" max="100" step="0.01" placeholder="Descuento base %" value={listingBaseDiscount} onChange={(e) => setListingBaseDiscount(e.target.value)} />
              <input
                placeholder="Descuentos por lote (formato 5:10,10:20)"
                value={listingTiers}
                onChange={(e) => setListingTiers(e.target.value)}
              />
              <button type="submit">Publicar en mercado</button>
            </form>
          </section>

          <section className="card">
            <h3>Mercado</h3>
            {visibleListings.length === 0 ? (
              <p>No hay artículos publicados.</p>
            ) : (
              <div className="market-list">
                {visibleListings.map((item) => {
                  const qty = Number(buyQtyByListing[item.id] || 1)
                  const tiers = Array.isArray(item.tier_discounts) ? item.tier_discounts : []
                  const discount = resolveDiscount(item.base_discount_percent, tiers, qty)
                  const total = (Number(item.unit_price) * qty * (1 - discount / 100)).toFixed(2)
                  const isOwn = item.seller_id === session.user.id

                  return (
                    <article className="market-item" key={item.id}>
                      <h4>{item.title}</h4>
                      <p>{item.description || 'Sin descripción'}</p>
                      <p>Precio: {formatMoney(item.unit_price)}</p>
                      <p>Stock: {item.is_unlimited ? 'Ilimitado' : item.stock}</p>
                      <p>Descuento aplicado: {discount.toFixed(2)}%</p>
                      <p>Total estimado: {formatMoney(total)}</p>
                      {tiers.length > 0 && (
                        <p className="tiny">Lotes: {tiers.map((t) => `${t.min_qty}+ => ${t.discount_percent}%`).join(' | ')}</p>
                      )}

                      {!isOwn && item.is_active && (
                        <div className="buy-row">
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={buyQtyByListing[item.id] || 1}
                            onChange={(e) => setBuyQtyByListing((prev) => ({ ...prev, [item.id]: e.target.value }))}
                          />
                          <button type="button" onClick={() => doBuy(item.id)}>Comprar</button>
                        </div>
                      )}

                      {isOwn && <p className="tiny">Este artículo es tuyo.</p>}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}

      {message && <p className="message">{message}</p>}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)

  useEffect(() => {
    if (supabaseConfigError) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession))
    return () => subscription.unsubscribe()
  }, [])

  if (supabaseConfigError) return (
    <div className="auth-card"><h1>Banco de Umbrathel</h1><p className="message">{supabaseConfigError}</p></div>
  )
  if (!session) return <AuthView />
  return <Dashboard session={session} />
}
