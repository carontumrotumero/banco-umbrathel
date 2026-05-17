import { useEffect, useMemo, useState } from 'react'
import { supabase, supabaseConfigError } from './supabaseClient'

const CURRENCY = 'Ḡ'

function formatMoney(value) {
  return `${CURRENCY} ${Number(value || 0).toFixed(2)}`
}

function AuthView({ onAuth }) {
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [message, setMessage] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setMessage('')

    if (isSignUp) {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName }
        }
      })

      if (error) return setMessage(error.message)
      setMessage('Cuenta creada. Revisa tu correo para confirmar el registro.')
      return
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return setMessage(error.message)
    onAuth()
  }

  return (
    <div className="auth-card">
      <h1>Banco de Umbrathel</h1>
      <p className="subtitle">Tu banco digital con moneda oficial {CURRENCY}</p>

      <form onSubmit={handleSubmit}>
        {isSignUp && (
          <label>
            Nombre completo
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </label>
        )}

        <label>
          Correo
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>

        <label>
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>

        <button type="submit">{isSignUp ? 'Crear cuenta' : 'Iniciar sesión'}</button>
      </form>

      <button className="secondary" onClick={() => setIsSignUp((v) => !v)}>
        {isSignUp ? 'Ya tengo cuenta' : 'No tengo cuenta'}
      </button>

      {message && <p className="message">{message}</p>}
    </div>
  )
}

function Dashboard({ session }) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState(null)
  const [account, setAccount] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [users, setUsers] = useState([])
  const [message, setMessage] = useState('')

  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [transferToEmail, setTransferToEmail] = useState('')
  const [transferAmount, setTransferAmount] = useState('')

  const [adminUserId, setAdminUserId] = useState('')
  const [adminAmount, setAdminAmount] = useState('')

  const isAdmin = useMemo(() => profile?.role === 'admin', [profile])

  async function loadData() {
    setLoading(true)
    setMessage('')

    const [{ data: p, error: pErr }, { data: acc, error: accErr }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', session.user.id).single(),
      supabase.from('accounts').select('*').eq('user_id', session.user.id).single()
    ])

    if (pErr || accErr) {
      setMessage(pErr?.message || accErr?.message || 'Error cargando datos')
      setLoading(false)
      return
    }

    setProfile(p)
    setAccount(acc)

    const { data: tx, error: txErr } = await supabase
      .from('transactions_view')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30)

    if (txErr) {
      setMessage(txErr.message)
    } else {
      setTransactions(tx || [])
    }

    if (p.role === 'admin') {
      const { data: userList } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .order('email', { ascending: true })
      setUsers(userList || [])
    }

    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  async function runRpc(name, payload) {
    setMessage('')
    const { error } = await supabase.rpc(name, payload)
    if (error) {
      setMessage(error.message)
      return false
    }
    await loadData()
    return true
  }

  async function doDeposit(e) {
    e.preventDefault()
    if (!depositAmount) return
    const ok = await runRpc('deposit_self', { p_amount: Number(depositAmount) })
    if (ok) setDepositAmount('')
  }

  async function doWithdraw(e) {
    e.preventDefault()
    if (!withdrawAmount) return
    const ok = await runRpc('withdraw_self', { p_amount: Number(withdrawAmount) })
    if (ok) setWithdrawAmount('')
  }

  async function doTransfer(e) {
    e.preventDefault()
    if (!transferAmount || !transferToEmail) return
    const ok = await runRpc('transfer_by_email', {
      p_to_email: transferToEmail,
      p_amount: Number(transferAmount)
    })
    if (ok) {
      setTransferAmount('')
      setTransferToEmail('')
    }
  }

  async function doAdminCredit(e) {
    e.preventDefault()
    if (!adminAmount || !adminUserId) return
    const ok = await runRpc('admin_credit_user', {
      p_user_id: adminUserId,
      p_amount: Number(adminAmount)
    })
    if (ok) {
      setAdminAmount('')
      setAdminUserId('')
    }
  }

  async function signOut() {
    await supabase.auth.signOut()
    window.location.reload()
  }

  if (loading) return <p className="loading">Cargando panel bancario...</p>

  return (
    <div className="container">
      <header className="topbar">
        <div>
          <h1>Banco de Umbrathel</h1>
          <p>
            {profile?.full_name || profile?.email} · Rol: <strong>{profile?.role}</strong>
          </p>
        </div>
        <button onClick={signOut}>Cerrar sesión</button>
      </header>

      <section className="card balance">
        <h2>Saldo disponible</h2>
        <p className="amount">{formatMoney(account?.balance)}</p>
      </section>

      <section className="grid">
        <form className="card" onSubmit={doDeposit}>
          <h3>Ingreso</h3>
          <input type="number" min="0.01" step="0.01" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} required />
          <button type="submit">Ingresar</button>
        </form>

        <form className="card" onSubmit={doWithdraw}>
          <h3>Retiro</h3>
          <input type="number" min="0.01" step="0.01" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} required />
          <button type="submit">Retirar</button>
        </form>

        <form className="card" onSubmit={doTransfer}>
          <h3>Transferencia</h3>
          <input type="email" placeholder="Correo destinatario" value={transferToEmail} onChange={(e) => setTransferToEmail(e.target.value)} required />
          <input type="number" min="0.01" step="0.01" placeholder="Monto" value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} required />
          <button type="submit">Transferir</button>
        </form>
      </section>

      {isAdmin && (
        <section className="card admin">
          <h3>Panel Administrador</h3>
          <p>Como administrador, puedes agregar saldo a cualquier usuario.</p>
          <form onSubmit={doAdminCredit}>
            <select value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)} required>
              <option value="">Selecciona usuario</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} {u.full_name ? `(${u.full_name})` : ''}
                </option>
              ))}
            </select>
            <input type="number" min="0.01" step="0.01" placeholder="Monto a acreditar" value={adminAmount} onChange={(e) => setAdminAmount(e.target.value)} required />
            <button type="submit">Acreditar dinero</button>
          </form>
        </section>
      )}

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
                  <td>{formatMoney(tx.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {message && <p className="message">{message}</p>}
    </div>
  )
}

export default function App() {
  if (supabaseConfigError) {
    return (
      <div className="auth-card">
        <h1>Banco de Umbrathel</h1>
        <p className="message">{supabaseConfigError}</p>
        <p>Configura esas variables en Vercel Project Settings → Environment Variables y redeploy.</p>
      </div>
    )
  }

  const [session, setSession] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (!session) {
    return <AuthView onAuth={() => {}} />
  }

  return <Dashboard session={session} />
}
