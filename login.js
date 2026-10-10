const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginTab = document.getElementById('tab-login-btn');
const registerTab = document.getElementById('tab-register-btn');
const switchText = document.getElementById('auth-switch-text');
const feedback = document.getElementById('auth-feedback');
const membershipPlans = {
  corte: { name: 'Corte', price: 'R$ 84,90/mês' },
  barba: { name: 'Barba', price: 'R$ 79,90/mês' },
  'corte-barba': { name: 'Corte + barba', price: 'R$ 149,50/mês' }
};
const selectedPlan = membershipPlans[new URLSearchParams(window.location.search).get('plan')];
const selectedPlanCode = new URLSearchParams(window.location.search).get('plan');

function switchTab(mode = 'login') {
  const isLogin = mode === 'login';
  loginForm.classList.toggle('hidden', !isLogin);
  registerForm.classList.toggle('hidden', isLogin);
  loginTab.setAttribute('aria-selected', String(isLogin));
  registerTab.setAttribute('aria-selected', String(!isLogin));
  loginTab.className = `py-2.5 text-xs ${isLogin ? 'font-bold bg-rose-600 text-white shadow-lg shadow-rose-600/30' : 'font-semibold text-slate-400 hover:text-slate-200'} rounded-lg transition-all duration-200 flex items-center justify-center gap-2`;
  registerTab.className = `py-2.5 text-xs ${isLogin ? 'font-semibold text-slate-400 hover:text-slate-200' : 'font-bold bg-rose-600 text-white shadow-lg shadow-rose-600/30'} rounded-lg transition-all duration-200 flex items-center justify-center gap-2`;
  switchText.replaceChildren(document.createTextNode(isLogin ? 'Ainda não é membro do clube?' : 'Já possui cadastro?'));

  const switchButton = document.createElement('button');
  switchButton.type = 'button';
  switchButton.className = 'text-rose-400 font-bold hover:text-rose-300 ml-1 underline decoration-rose-400/40 hover:decoration-rose-300';
  switchButton.textContent = isLogin ? 'Criar conta gratuita' : 'Entrar na sua conta';
  switchButton.addEventListener('click', () => switchTab(isLogin ? 'register' : 'login'));
  switchText.append(switchButton);
}

function showAuthFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.className = `mb-4 rounded-lg border px-3 py-2.5 text-sm leading-5 ${isError ? 'border-rose-500/40 bg-rose-950/40 text-rose-200' : 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'}`;
  feedback.classList.toggle('hidden', !message);
  feedback.setAttribute('role', isError ? 'alert' : 'status');
}

function togglePasswordVisibility(button) {
  const input = document.getElementById(button.dataset.passwordInput);
  const icon = document.getElementById(button.dataset.passwordIcon);
  if (!input || !icon) return;

  const showPassword = input.type === 'password';
  input.type = showPassword ? 'text' : 'password';
  button.setAttribute('aria-label', showPassword ? 'Ocultar senha' : 'Mostrar senha');
  icon.innerHTML = showPassword
    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />'
    : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />';
}

async function submitAuthForm(event) {
  event.preventDefault();
  const isRegistration = event.currentTarget === registerForm;
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  const buttonLabel = submitButton.querySelector('span');
  const originalLabel = buttonLabel.textContent;
  let authenticationSucceeded = false;
  const payload = isRegistration
    ? {
        name: document.getElementById('reg-name').value.trim(),
        phone: document.getElementById('reg-phone').value,
        email: document.getElementById('reg-email').value.trim(),
        password: document.getElementById('reg-password').value
      }
    : {
        identifier: document.getElementById('login-identifier').value.trim(),
        password: document.getElementById('login-password').value
      };

  submitButton.disabled = true;
  buttonLabel.textContent = 'Aguarde...';
  showAuthFeedback('');
  try {
    const response = await fetch(isRegistration ? '/api/register' : '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('O servidor retornou uma resposta inválida. Tente novamente.');
    }
    if (!response.ok) throw new Error(result.error || 'Não foi possível concluir o acesso.');
    authenticationSucceeded = true;
    if (selectedPlan) {
      showAuthFeedback('Preparando seu checkout seguro...');
      const checkoutResponse = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ plan: selectedPlanCode })
      });
      let checkout;
      try {
        checkout = await checkoutResponse.json();
      } catch {
        throw new Error('O servidor retornou uma resposta inválida para o checkout.');
      }
      if (!checkoutResponse.ok) throw new Error(checkout.error || 'Não foi possível iniciar a assinatura.');
      if (!checkout.checkout_url) throw new Error('O Mercado Pago não retornou o link de pagamento.');
      window.location.assign(checkout.checkout_url);
      return;
    }
    window.location.assign('index.html');
  } catch (error) {
    const message = error instanceof TypeError
      ? 'Não foi possível conectar ao sistema. Inicie o servidor local seguindo o README.'
      : error.message;
    if (selectedPlan && authenticationSucceeded) {
      showAuthFeedback(`Conta conectada, mas o checkout não iniciou. ${message}`, true);
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'mt-2 block font-bold text-rose-100 underline underline-offset-2 hover:text-white disabled:opacity-60';
      retryButton.textContent = 'Tentar checkout novamente';
      retryButton.addEventListener('click', async () => {
        retryButton.disabled = true;
        retryButton.textContent = 'Preparando checkout...';
        try {
          const retryResponse = await fetch('/api/subscriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ plan: selectedPlanCode })
          });
          const retryResult = await retryResponse.json();
          if (!retryResponse.ok) throw new Error(retryResult.error || 'Não foi possível iniciar a assinatura.');
          if (!retryResult.checkout_url) throw new Error('O Mercado Pago não retornou o link de pagamento.');
          window.location.assign(retryResult.checkout_url);
        } catch (retryError) {
          showAuthFeedback(retryError.message, true);
          retryButton.disabled = false;
          retryButton.textContent = 'Tentar checkout novamente';
          feedback.append(retryButton);
        }
      });
      feedback.append(retryButton);
    } else {
      showAuthFeedback(message, true);
    }
  } finally {
    submitButton.disabled = false;
    buttonLabel.textContent = originalLabel;
  }
}

loginTab.addEventListener('click', () => switchTab('login'));
registerTab.addEventListener('click', () => switchTab('register'));
for (const tab of [loginTab, registerTab]) {
  tab.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextTab = tab === loginTab ? registerTab : loginTab;
    nextTab.focus();
    switchTab(nextTab === loginTab ? 'login' : 'register');
  });
}

document.querySelectorAll('[data-switch-tab]').forEach(button => {
  button.addEventListener('click', () => switchTab(button.dataset.switchTab));
});
document.querySelectorAll('.password-toggle').forEach(button => {
  button.addEventListener('click', () => togglePasswordVisibility(button));
});
loginForm.addEventListener('submit', submitAuthForm);
registerForm.addEventListener('submit', submitAuthForm);

document.querySelector('a[href="#recuperar-senha"]').addEventListener('click', event => {
  event.preventDefault();
  showAuthFeedback('A recuperação automática por e-mail ainda não está configurada. Procure a equipe da B7 Barber.', true);
});

document.querySelectorAll('[data-purpose="social-login"] button').forEach(button => {
  button.addEventListener('click', () => {
    showAuthFeedback(`O acesso por ${button.textContent.trim()} ainda precisa ser configurado. Use e-mail ou telefone e senha.`, true);
  });
});

if (new URLSearchParams(window.location.search).get('mode') === 'register' || selectedPlan) {
  switchTab('register');
}

if (selectedPlan) {
  const planNotice = document.createElement('p');
  planNotice.className = 'mb-4 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2.5 text-sm leading-5 text-rose-100';
  planNotice.setAttribute('role', 'status');
  planNotice.textContent = `Plano escolhido: ${selectedPlan.name} · ${selectedPlan.price}. A assinatura e o acesso ao Club serão liberados após a confirmação do pagamento pela equipe.`;
  feedback.after(planNotice);
}

fetch('/api/me', { credentials: 'same-origin' })
  .then(response => response.ok ? response.json() : null)
  .then(result => {
    if (result?.authenticated && result.user) {
      showAuthFeedback(`Você já está conectado como ${result.user.name}.`, false);
    }
  })
  .catch(() => {});