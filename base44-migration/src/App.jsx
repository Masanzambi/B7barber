import { useEffect, useState } from 'react';
import { base44 } from './api/base44Client.js';

const plans = [
  { code: 'corte', name: 'Corte', price: '84,90', marker: '01 / CORTE' },
  { code: 'barba', name: 'Barba', price: '79,90', marker: '02 / BARBA' },
  { code: 'corte-barba', name: 'Corte + barba', price: '149,50', marker: '03 / COMBO', featured: true },
];

function getFunctionData(result) {
  return result?.data ?? result;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [membership, setMembership] = useState(null);
  const [catalog, setCatalog] = useState({ services: [], barbers: [] });
  const [catalogError, setCatalogError] = useState('');
  const [booking, setBooking] = useState({ service_id: '', barber_name: 'Artur', date: new Date().toISOString().slice(0, 10), hour: '10' });
  const [availability, setAvailability] = useState({});
  const [availabilityMessage, setAvailabilityMessage] = useState('');
  const [bookingMessage, setBookingMessage] = useState('');
  const [adminData, setAdminData] = useState(null);
  const [adminMessage, setAdminMessage] = useState('');
  const [serviceDraft, setServiceDraft] = useState({ id: '', name: '', description: '', price_brl: '', category: 'cabelo' });
  const [cashDraft, setCashDraft] = useState({ barber_name: 'Artur', entry_type: 'income', amount_brl: '', description: '', entry_date: new Date().toISOString().slice(0, 10) });
  const [availabilityDraft, setAvailabilityDraft] = useState({ barber_name: 'Artur', date: new Date().toISOString().slice(0, 10), hour: '10', is_available: false });
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [registration, setRegistration] = useState({ display_name: '', phone: '', email: '', password: '', otp: '' });
  const [needsOtp, setNeedsOtp] = useState(false);
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function refreshAccount() {
    let currentUser;
    try {
      currentUser = await base44.auth.me();
      setUser(currentUser);
    } catch {
      setUser(null);
      setMembership(null);
      return;
    }
    try {
      const result = await base44.functions.invoke('getMyClubStatus', {});
      setMembership(getFunctionData(result));
    } catch {
      setMembership(null);
    }
  }

  async function loadCatalog() {
    try {
      const result = await base44.functions.invoke('getPublicCatalog', {});
      setCatalog(getFunctionData(result));
      setCatalogError('');
    } catch {
      setCatalogError('Não foi possível carregar serviços e barbeiros.');
    }
  }

  useEffect(() => {
    refreshAccount();
    loadCatalog();
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') loadAdminDashboard();
    else setAdminData(null);
  }, [user?.role]);

  useEffect(() => {
    if (!booking.date || !booking.barber_name) return;
    let isCurrent = true;
    setAvailabilityMessage('Consultando horários...');
    base44.functions.invoke('getAvailability', { date: booking.date })
      .then(result => {
        if (!isCurrent) return;
        const catalog = getFunctionData(result);
        setAvailability(catalog.availability || {});
        setAvailabilityMessage('Horários disponíveis conforme atualização da equipe.');
      })
      .catch(() => {
        if (!isCurrent) return;
        setAvailability({});
        setAvailabilityMessage('Não foi possível consultar a disponibilidade. A equipe confirmará sua solicitação.');
      });
    return () => { isCurrent = false; };
  }, [booking.date, booking.barber_name]);

  async function loadAdminDashboard() {
    try {
      const result = await base44.functions.invoke('getAdminDashboard', {});
      setAdminData(getFunctionData(result));
    } catch (error) {
      setAdminMessage(error.message || 'Não foi possível carregar a administração.');
    }
  }

  async function runAdminAction(action) {
    setAdminMessage('Salvando...');
    try {
      const result = await base44.functions.invoke('adminManage', action);
      const response = getFunctionData(result);
      if (action.action === 'seedCatalog') {
        setAdminMessage(`Carga concluída: ${response.services_created} serviços e ${response.barbers_created} barbeiros adicionados.`);
      } else {
        setAdminMessage('Alteração salva.');
      }
      await Promise.all([loadAdminDashboard(), loadCatalog()]);
    } catch (error) {
      setAdminMessage(error.message || 'Não foi possível salvar.');
    }
  }

  async function beginCheckout(planCode) {
    setIsLoading(true);
    setMessage('Preparando checkout seguro...');
    try {
      const result = await base44.functions.invoke('createSubscriptionCheckout', { plan_code: planCode });
      const checkout = getFunctionData(result);
      const checkoutUrl = checkout?.checkout_url;
      if (!checkoutUrl || !checkoutUrl.startsWith('https://')) {
        throw new Error('O checkout não retornou um endereço seguro.');
      }
      window.location.assign(checkoutUrl);
    } catch (error) {
      setMessage(error.message || 'Não foi possível iniciar a assinatura. Tente novamente.');
      setIsLoading(false);
    }
  }

  function choosePlan(planCode) {
    setSelectedPlan(planCode);
    if (user) {
      beginCheckout(planCode);
      return;
    }
    setAuthMode('register');
    setMessage('Crie sua conta para continuar com o plano escolhido.');
    document.getElementById('conta')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function requestBooking(event) {
    event.preventDefault();
    if (!user) {
      setSelectedPlan(null);
      setAuthMode('login');
      setMessage('Entre na sua conta para solicitar um horário.');
      document.getElementById('conta')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    setIsLoading(true);
    setBookingMessage('Enviando solicitação...');
    try {
      const result = await base44.functions.invoke('createBookingRequest', {
        service_id: catalog.services.find(service => (service.id || service.name) === booking.service_id)?.id || '',
        service_name: catalog.services.find(service => (service.id || service.name) === booking.service_id)?.name || '',
        barber_name: booking.barber_name,
        date: booking.date,
        hour: Number(booking.hour),
      });
      const response = getFunctionData(result);
      setBookingMessage(`Solicitação enviada para ${response.barber_name}, ${response.date} às ${String(response.hour).padStart(2, '0')}:00. Aguarde a confirmação da equipe.`);
    } catch (error) {
      setBookingMessage(error.message || 'Não foi possível solicitar este horário.');
    } finally {
      setIsLoading(false);
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    setIsLoading(true);
    setMessage('');
    try {
      await base44.auth.loginViaEmailPassword(registration.email.trim(), registration.password);
      await refreshAccount();
      if (selectedPlan) await beginCheckout(selectedPlan);
      else setMessage('Login realizado.');
    } catch (error) {
      setMessage(error.message || 'Não foi possível entrar. Confira seu e-mail e senha.');
    } finally {
      setIsLoading(false);
    }
  }

  async function submitRegistration(event) {
    event.preventDefault();
    setIsLoading(true);
    setMessage('');
    try {
      await base44.auth.register({ email: registration.email.trim(), password: registration.password });
      setNeedsOtp(true);
      setMessage('Enviamos um código de confirmação para seu e-mail.');
    } catch (error) {
      setMessage(error.message || 'Não foi possível iniciar o cadastro.');
    } finally {
      setIsLoading(false);
    }
  }

  async function verifyRegistration(event) {
    event.preventDefault();
    setIsLoading(true);
    setMessage('');
    try {
      await base44.auth.verifyOtp({ email: registration.email.trim(), otpCode: registration.otp.trim() });
      await base44.auth.loginViaEmailPassword(registration.email.trim(), registration.password);
      await base44.auth.updateMe({
        phone: registration.phone.trim(),
        display_name: registration.display_name.trim(),
      });
      await refreshAccount();
      if (selectedPlan) await beginCheckout(selectedPlan);
      else setMessage('Conta confirmada e conectada.');
    } catch (error) {
      setMessage(error.message || 'Não foi possível confirmar o código.');
    } finally {
      setIsLoading(false);
    }
  }

  async function resendOtp() {
    setIsLoading(true);
    try {
      await base44.auth.resendOtp(registration.email.trim());
      setMessage('Enviamos outro código para seu e-mail.');
    } catch (error) {
      setMessage(error.message || 'Não foi possível reenviar o código.');
    } finally {
      setIsLoading(false);
    }
  }

  function updateRegistration(field, value) {
    setRegistration(current => ({ ...current, [field]: value }));
  }

  async function signOut() {
    await base44.auth.logout('/');
  }

  const selectedPlanDetails = plans.find(plan => plan.code === selectedPlan);

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="B7 Barber Club, início">
          <span className="brand-mark" aria-hidden="true">B7</span>
          <span>B7 <strong>BARBER CLUB</strong></span>
        </a>
        <nav className="main-nav" aria-label="Navegação principal">
          <a href="#servicos">Serviços</a>
          <a href="#barbeiros">Barbeiros</a>
          <a href="#club">Club</a>
        </nav>
        <a className="account-link" href="#conta">{user ? user.display_name || user.full_name || 'Minha conta' : 'Entrar'}</a>
      </header>
      <section className="club-intro" id="inicio">
        <p className="eyebrow">Curicica · Rio de Janeiro</p>
        <h1>Seu estilo.<br /><span>Seu clube.</span></h1>
        <p className="intro-copy">Cuidado preciso, barbeiros de confiança e um plano mensal feito para manter o visual em dia.</p>
      </section>
      <section className="catalog-section" id="servicos" aria-labelledby="services-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">A carta da casa</p>
            <h2 id="services-title">Serviços</h2>
          </div>
          <span className="billing-note">Valores por atendimento</span>
        </div>
        {catalogError && <p className="auth-message" role="status">{catalogError}</p>}
        <div className="service-grid">
          {catalog.services.map(service => (
            <article className="service-row" key={service.id || service.name}>
              <div>
                <h3>{service.name}</h3>
                <p>{service.description || service.category}</p>
              </div>
              <strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(service.price_brl)}</strong>
            </article>
          ))}
        </div>
      </section>
      <section className="barbers-section" id="barbeiros" aria-labelledby="barbers-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Mãos experientes</p>
            <h2 id="barbers-title">Nossa equipe</h2>
          </div>
          <span className="billing-note">Atendimento com hora marcada</span>
        </div>
        <div className="barber-grid">
          {catalog.barbers.map(barber => (
            <article className="barber-profile" key={barber.id || barber.name}>
              <img src={barber.image_url} alt={`Barbeiro ${barber.name}`} loading="lazy" />
              <div>
                <h3>{barber.name}</h3>
                <p>{barber.specialty}</p>
                {barber.rating && <span className="barber-rating">{Number(barber.rating).toFixed(1)} · {barber.review_count || 0} avaliações</span>}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="booking-section" id="agendar" aria-labelledby="booking-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Próximo passo</p>
            <h2 id="booking-title">Solicite um horário</h2>
          </div>
          <span className="billing-note">Confirmação pela equipe B7</span>
        </div>
        <form className="booking-form" onSubmit={requestBooking}>
          <label>Serviço
            <select value={booking.service_id} onChange={event => setBooking(current => ({ ...current, service_id: event.target.value }))} required>
              <option value="">Selecione o serviço</option>
              {catalog.services.map(service => <option value={service.id || service.name} key={service.id || service.name}>{service.name} · {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(service.price_brl)}</option>)}
            </select>
          </label>
          <label>Barbeiro
            <select value={booking.barber_name} onChange={event => setBooking(current => ({ ...current, barber_name: event.target.value }))}>
              {catalog.barbers.map(barber => <option value={barber.name} key={barber.id || barber.name}>{barber.name}</option>)}
            </select>
          </label>
          <label>Data<input type="date" min={new Date().toISOString().slice(0, 10)} value={booking.date} onChange={event => setBooking(current => ({ ...current, date: event.target.value }))} required /></label>
          <label>Horário
            <select value={booking.hour} onChange={event => setBooking(current => ({ ...current, hour: event.target.value }))}>
              {Array.from({ length: 14 }, (_, index) => index + 8).map(hour => {
                const isAvailable = availability[booking.barber_name]?.[String(hour)] !== false;
                return <option value={hour} key={hour} disabled={!isAvailable}>{String(hour).padStart(2, '0')}:00{isAvailable ? '' : ' · indisponível'}</option>;
              })}
            </select>
          </label>
          <button className="auth-submit" type="submit" disabled={isLoading || !catalog.services.length || !catalog.barbers.length}>{isLoading ? 'Enviando...' : 'Solicitar horário'}</button>
        </form>
        <p className="booking-note" role="status">{bookingMessage || availabilityMessage || 'O horário só fica reservado após a confirmação da equipe.'}</p>
      </section>
      <section className="plans" id="club" aria-labelledby="plans-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">B7 Barber Club</p>
            <h2 id="plans-title">Escolha sua assinatura</h2>
          </div>
          <span className="billing-note">Cobrança mensal</span>
        </div>
        <div className="plan-grid">
          {plans.map(plan => (
            <article className={`plan-card${plan.featured ? ' plan-card-featured' : ''}`} key={plan.code}>
              <span className="plan-index">{plan.marker}</span>
              <h3>{plan.name}</h3>
              <p className="plan-price">R$ {plan.price} <span>/ mês</span></p>
              <button type="button" className="plan-button" onClick={() => choosePlan(plan.code)} disabled={isLoading}>
                Assinar {plan.name} <span aria-hidden="true">↗</span>
              </button>
            </article>
          ))}
        </div>
        <p className="membership-note">Benefícios exclusivos para membros com assinatura ativa.</p>
      </section>
      <section className="account-section" id="conta" aria-labelledby="account-title">
        <div className="account-copy">
          <p className="eyebrow">Área do membro</p>
          <h2 id="account-title">{user ? `Olá, ${user.display_name || user.full_name || user.email}` : 'Entre para continuar'}</h2>
          {user && membership?.active ? (
            <p className="account-status">Plano {membership.plan_name} ativo. Próxima cobrança: {membership.next_payment_date ? new Date(membership.next_payment_date).toLocaleDateString('pt-BR') : 'em processamento'}.</p>
          ) : user && membership?.status ? (
            <p className="account-status">Seu plano está {membership.status === 'authorized' ? 'autorizado, aguardando a cobrança' : 'aguardando confirmação do pagamento'}.</p>
          ) : (
            <p className="account-status">A assinatura ativa libera os benefícios exclusivos do B7 Barber Club.</p>
          )}
          {user && <button className="text-button" type="button" onClick={signOut}>Sair da conta</button>}
        </div>
        {!user && (
          <div className="auth-panel">
            <div className="auth-tabs" role="tablist" aria-label="Acesso à conta">
              <button className={authMode === 'login' ? 'auth-tab active' : 'auth-tab'} type="button" onClick={() => { setAuthMode('login'); setNeedsOtp(false); setMessage(''); }}>Entrar</button>
              <button className={authMode === 'register' ? 'auth-tab active' : 'auth-tab'} type="button" onClick={() => { setAuthMode('register'); setNeedsOtp(false); setMessage(''); }}>Criar conta</button>
            </div>
            {selectedPlanDetails && <p className="selected-plan">Plano selecionado: {selectedPlanDetails.name} · R$ {selectedPlanDetails.price}/mês</p>}
            {message && <p className="auth-message" role="status">{message}</p>}
            {authMode === 'login' ? (
              <form className="auth-form" onSubmit={submitLogin}>
                <label>E-mail<input autoComplete="email" type="email" value={registration.email} onChange={event => updateRegistration('email', event.target.value)} required /></label>
                <label>Senha<input autoComplete="current-password" type="password" value={registration.password} onChange={event => updateRegistration('password', event.target.value)} minLength={8} required /></label>
                <button className="auth-submit" type="submit" disabled={isLoading}>{isLoading ? 'Aguarde...' : 'Entrar'}</button>
              </form>
            ) : needsOtp ? (
              <form className="auth-form" onSubmit={verifyRegistration}>
                <label>Código enviado por e-mail<input autoComplete="one-time-code" inputMode="numeric" value={registration.otp} onChange={event => updateRegistration('otp', event.target.value)} required /></label>
                <button className="auth-submit" type="submit" disabled={isLoading}>{isLoading ? 'Confirmando...' : 'Confirmar cadastro'}</button>
                <button className="text-button" type="button" onClick={resendOtp} disabled={isLoading}>Reenviar código</button>
              </form>
            ) : (
              <form className="auth-form" onSubmit={submitRegistration}>
                <label>Como podemos chamar você?<input autoComplete="name" maxLength={120} value={registration.display_name} onChange={event => updateRegistration('display_name', event.target.value)} required /></label>
                <label>WhatsApp<input autoComplete="tel" inputMode="tel" maxLength={20} value={registration.phone} onChange={event => updateRegistration('phone', event.target.value)} required /></label>
                <label>E-mail<input autoComplete="email" type="email" value={registration.email} onChange={event => updateRegistration('email', event.target.value)} required /></label>
                <label>Senha<input autoComplete="new-password" type="password" minLength={8} value={registration.password} onChange={event => updateRegistration('password', event.target.value)} required /></label>
                <button className="auth-submit" type="submit" disabled={isLoading}>{isLoading ? 'Enviando...' : selectedPlanDetails ? 'Criar conta e assinar' : 'Criar conta'}</button>
              </form>
            )}
          </div>
        )}
      </section>
      {user?.role === 'admin' && (
        <section className="admin-section" id="admin" aria-labelledby="admin-title">
          <div className="section-heading">
            <div><p className="eyebrow">Equipe B7</p><h2 id="admin-title">Administração</h2></div>
            <span className="billing-note">Acesso restrito</span>
          </div>
          {adminMessage && <p className="auth-message" role="status">{adminMessage}</p>}
          <button className="text-button" type="button" onClick={() => runAdminAction({ action: 'seedCatalog' })}>Carregar catálogo inicial</button>
          {adminData && <p className="admin-summary">{adminData.users.length} contas · {adminData.services.length} serviços · {adminData.booking_requests.filter(item => item.status === 'pending').length} solicitações pendentes</p>}
          {adminData?.cashflow && <div className="cash-summary">{['week', 'month', 'year'].map(period => {
            const totals = adminData.cashflow[period];
            const labels = { week: 'Semana', month: 'Mês', year: 'Ano' };
            return <article key={period}><span>{labels[period]}</span><strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totals.total_profit_cents / 100)}</strong><small>Entradas {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totals.total_income_cents / 100)} · Saídas {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totals.total_expense_cents / 100)}</small></article>;
          })}</div>}
          <div className="admin-grid">
            <form className="admin-form" onSubmit={event => { event.preventDefault(); runAdminAction({ action: 'saveService', ...serviceDraft, price_brl: Number(serviceDraft.price_brl), active: true }); setServiceDraft({ id: '', name: '', description: '', price_brl: '', category: 'cabelo' }); }}>
              <h3>{serviceDraft.id ? 'Editar serviço' : 'Novo serviço'}</h3>
              <label>Nome<input value={serviceDraft.name} maxLength={80} onChange={event => setServiceDraft(current => ({ ...current, name: event.target.value }))} required /></label>
              <label>Descrição<input value={serviceDraft.description} maxLength={300} onChange={event => setServiceDraft(current => ({ ...current, description: event.target.value }))} /></label>
              <label>Preço em R$<input type="number" min="0" max="10000" step="0.01" value={serviceDraft.price_brl} onChange={event => setServiceDraft(current => ({ ...current, price_brl: event.target.value }))} required /></label>
              <label>Categoria<select value={serviceDraft.category} onChange={event => setServiceDraft(current => ({ ...current, category: event.target.value }))}><option value="cabelo">Cabelo</option><option value="barba">Barba</option><option value="combos">Combos</option><option value="quimica">Química</option></select></label>
              <button className="auth-submit" type="submit">{serviceDraft.id ? 'Salvar serviço' : 'Adicionar serviço'}</button>
              {serviceDraft.id && <button className="text-button" type="button" onClick={() => setServiceDraft({ id: '', name: '', description: '', price_brl: '', category: 'cabelo' })}>Cancelar edição</button>}
            </form>
            <form className="admin-form" onSubmit={event => { event.preventDefault(); runAdminAction({ action: 'setAvailability', ...availabilityDraft, hour: Number(availabilityDraft.hour) }); }}>
              <h3>Disponibilidade</h3>
              <label>Barbeiro<select value={availabilityDraft.barber_name} onChange={event => setAvailabilityDraft(current => ({ ...current, barber_name: event.target.value }))}><option>Artur</option><option>Fabio</option><option>Ricardo</option></select></label>
              <label>Data<input type="date" value={availabilityDraft.date} onChange={event => setAvailabilityDraft(current => ({ ...current, date: event.target.value }))} required /></label>
              <label>Horário<select value={availabilityDraft.hour} onChange={event => setAvailabilityDraft(current => ({ ...current, hour: event.target.value }))}>{Array.from({ length: 14 }, (_, index) => index + 8).map(hour => <option value={hour} key={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label>
              <label>Estado<select value={String(availabilityDraft.is_available)} onChange={event => setAvailabilityDraft(current => ({ ...current, is_available: event.target.value === 'true' }))}><option value="false">Indisponível</option><option value="true">Disponível</option></select></label>
              <button className="auth-submit" type="submit">Salvar horário</button>
            </form>
            <form className="admin-form" onSubmit={event => { event.preventDefault(); runAdminAction({ action: 'createCashEntry', ...cashDraft, amount_brl: Number(cashDraft.amount_brl) }); setCashDraft(current => ({ ...current, amount_brl: '', description: '' })); }}>
              <h3>Caixa</h3>
              <label>Barbeiro<select value={cashDraft.barber_name} onChange={event => setCashDraft(current => ({ ...current, barber_name: event.target.value }))}><option>Artur</option><option>Fabio</option><option>Ricardo</option></select></label>
              <label>Tipo<select value={cashDraft.entry_type} onChange={event => setCashDraft(current => ({ ...current, entry_type: event.target.value }))}><option value="income">Entrada</option><option value="expense">Saída</option></select></label>
              <label>Valor em R$<input type="number" min="0.01" max="1000000" step="0.01" value={cashDraft.amount_brl} onChange={event => setCashDraft(current => ({ ...current, amount_brl: event.target.value }))} required /></label>
              <label>Descrição<input maxLength={120} value={cashDraft.description} onChange={event => setCashDraft(current => ({ ...current, description: event.target.value }))} required /></label>
              <label>Data<input type="date" value={cashDraft.entry_date} onChange={event => setCashDraft(current => ({ ...current, entry_date: event.target.value }))} required /></label>
              <button className="auth-submit" type="submit">Registrar lançamento</button>
            </form>
          </div>
          {adminData && <div className="admin-list"><h3>Catálogo de serviços</h3>{adminData.services.map(service => <article className="admin-list-row" key={service.id}><div><strong>{service.name}</strong><span>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(service.price_brl)} · {service.active ? 'Publicado' : 'Arquivado'}</span></div><div className="request-actions"><button type="button" onClick={() => setServiceDraft({ id: service.id, name: service.name, description: service.description || '', price_brl: String(service.price_brl), category: service.category })}>Editar</button><button type="button" onClick={() => runAdminAction({ action: 'setServiceActive', id: service.id, active: !service.active })}>{service.active ? 'Arquivar' : 'Publicar'}</button></div></article>)}</div>}
          {adminData && <div className="admin-list"><h3>Equipe</h3>{adminData.barbers.map(barber => <article className="admin-list-row" key={barber.id}><div><strong>{barber.name}</strong><span>{barber.specialty} · {barber.active ? 'Ativo' : 'Arquivado'}</span></div><button className="text-button" type="button" onClick={() => runAdminAction({ action: 'setBarberActive', id: barber.id, active: !barber.active })}>{barber.active ? 'Arquivar' : 'Ativar'}</button></article>)}</div>}
          {adminData && <div className="admin-requests"><h3>Solicitações de horário</h3>{adminData.booking_requests.filter(item => item.status === 'pending').map(item => <article className="request-row" key={item.id}><div><strong>{item.user_name} · {item.service_name}</strong><p>{item.barber_name} · {item.date} às {String(item.hour).padStart(2, '0')}:00 · {item.user_phone || item.user_email}</p></div><div className="request-actions"><button type="button" onClick={() => runAdminAction({ action: 'updateBookingRequest', id: item.id, status: 'confirmed' })}>Confirmar</button><button type="button" onClick={() => runAdminAction({ action: 'updateBookingRequest', id: item.id, status: 'declined' })}>Recusar</button></div></article>)}</div>}
          {adminData && <div className="admin-list"><h3>Contas</h3>{adminData.users.map(account => <article className="admin-list-row" key={account.id}><div><strong>{account.full_name || account.email}</strong><span>{account.email} · {account.role === 'admin' ? 'Administrador' : 'Cliente'} · {account.disabled ? 'Desativada' : 'Ativa'}</span></div>{account.role !== 'admin' && <button className="text-button" type="button" onClick={() => runAdminAction({ action: 'setUserDisabled', id: account.id, disabled: !account.disabled })}>{account.disabled ? 'Reativar' : 'Desativar'}</button>}</article>)}</div>}
          {adminData && <div className="admin-list"><h3>Lançamentos do caixa</h3>{adminData.cash_entries.slice(0, 12).map(entry => <article className="admin-list-row" key={entry.id}><div><strong>{entry.entry_type === 'income' ? 'Entrada' : 'Saída'} · {entry.barber_name}</strong><span>{entry.description} · {entry.entry_date}</span></div><strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(entry.amount_cents / 100)}</strong></article>)}</div>}
        </section>
      )}
      <footer className="site-footer">
        <span>Estrada de Curicica, 136 · Rio de Janeiro</span>
        <span>© B7 Barber Club</span>
      </footer>
    </main>
  );
}