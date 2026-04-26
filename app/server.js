require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');
const basicAuth = require('basic-auth');
const multer = require('multer');
const nodemailer = require('nodemailer');
const execFileAsync = promisify(execFile);

const app = express();
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

app.use(express.urlencoded({ extended: true }));

function parseCookies(header = '') {
  return String(header || '').split(';').reduce((acc, part) => {
    const [key, ...rest] = part.split('=');
    if (!key) return acc;
    acc[String(key).trim()] = decodeURIComponent(rest.join('=').trim());
    return acc;
  }, {});
}

function normalizarNumeroFormulario(value, { decimal = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw || raw === "'" || raw === '"') return '';
  let normalized = raw.replace(/\s+/g, '');
  if (decimal) {
    if (normalized.includes(',') && normalized.includes('.')) {
      const lastComma = normalized.lastIndexOf(',');
      const lastDot = normalized.lastIndexOf('.');
      if (lastComma > lastDot) normalized = normalized.replace(/\./g, '').replace(',', '.');
      else normalized = normalized.replace(/,/g, '');
    } else if (normalized.includes(',')) {
      const parts = normalized.split(',');
      if (parts.length === 2 && parts[1].length <= 2) normalized = parts[0].replace(/\./g, '') + '.' + parts[1];
      else normalized = normalized.replace(/,/g, '');
    } else if (normalized.includes('.')) {
      const parts = normalized.split('.');
      if (!(parts.length === 2 && parts[1].length <= 2)) normalized = normalized.replace(/\./g, '');
    }
  } else {
    normalized = normalized.replace(/[.,]/g, '');
  }
  return normalized;
}

function validarNumerosFormulario(body, fields) {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === '') continue;
    const normalized = normalizarNumeroFormulario(value, { decimal: ['valor_minimo', 'valor_maximo', 'valor', 'area_total_m2', 'area_construida_m2', 'dimensao_frente_m', 'dimensao_fundos_m', 'valor_condominio'].includes(field) });
    if (!/^\d+(\.\d+)?$/.test(String(normalized).trim())) return field;
  }
  return null;
}

function mascaraNumeroAttrs({ decimal = false, monetario = false } = {}) {
  const pattern = decimal ? '[0-9.,]+' : '[0-9.,]*';
  const inputmode = decimal ? 'decimal' : 'numeric';
  const attrs = [`inputmode="${inputmode}"`, `pattern="${pattern}"`, `oninput="this.value=this.value.replace(/[^0-9.,]/g,'');"`];
  if (monetario) attrs.push('data-monetario="true"');
  return attrs.join(' ');
}

function renderFormError(message) {
  if (!message) return '';
  return `<div class="card form-error">${esc(message)}</div>`;
}

function normalizarCampoBanco(value) {
  if (value === undefined || value === null) return null;
  let str = String(value).trim();
  str = str.replace(/^['"]+|['"]+$/g, '').trim();
  if (!str || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') return null;
  return str;
}

function normalizarPayloadImovel(source = {}) {
  const out = { ...source };
  const decimais = ['valor','area_total_m2','area_construida_m2','dimensao_frente_m','dimensao_fundos_m','valor_condominio'];
  const inteiros = ['cep','matricula_imovel','numero_dormitorios','numero_suites','numero_banheiros','numero_vagas_garagem','andar'];
  const booleanos = ['possui_elevador','aceita_financiamento','aceita_permuta','registro_cartorio','possui_escritura','possui_averbacao'];
  for (const key of [...decimais, ...inteiros, ...booleanos]) out[key] = normalizarCampoBanco(out[key]);
  for (const key of decimais) out[key] = normalizarNumeroFormulario(out[key], { decimal: true });
  for (const key of inteiros) out[key] = normalizarNumeroFormulario(out[key]);
  for (const key of booleanos) out[key] = normalizarCampoBanco(out[key]);
  return out;
}

const ESTADOS_IMOVEL = ['Novo', 'Usado'];
const STATUS_PUBLICACAO = [
  { value: 'disponivel', label: 'Disponível' },
  { value: 'reservado', label: 'Reservado' },
  { value: 'vendido', label: 'Vendido' },
  { value: 'inativo', label: 'Inativo' },
];
const OPCOES_TIPO_PAGAMENTO = ['Financiamento Bancário', 'À vista', 'Permuta', 'Financiamento direto'];
const MATCH_RULES = {
  pesos: {
    categoria: 40,
    valor: 25,
    cidade: 20,
    estado: 10,
    bairro: 6,
    estruturaPorItem: 1.75,
    propostaRegistrada: 5,
  },
  scoreMinimo: 55,
};

function renderSelectOptions(options, selectedValue, includeEmptyLabel = 'Selecione') {
  const normalizedSelected = selectedValue == null ? '' : String(selectedValue);
  const normalizedOptions = options.map((item) => typeof item === 'string' ? { value: item, label: item } : item);
  return `<option value="">${esc(includeEmptyLabel)}</option>${normalizedOptions.map((item) => `<option value="${esc(item.value)}" ${normalizedSelected === String(item.value) ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}`;
}

function selectEstadoImovel(name, value, includeEmptyLabel = 'Selecione') {
  return `<select name="${esc(name)}">${renderSelectOptions(ESTADOS_IMOVEL, value, includeEmptyLabel)}</select>`;
}

function selectStatusPublicacao(value, includeEmptyLabel = null, name = 'status_publicacao') {
  const emptyLabel = includeEmptyLabel == null ? '' : `<option value="">${esc(includeEmptyLabel)}</option>`;
  const selected = value == null ? '' : String(value);
  return `<select name="${esc(name)}">${emptyLabel}${STATUS_PUBLICACAO.map((item) => `<option value="${esc(item.value)}" ${selected === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select>`;
}
app.use(express.json());
app.set('trust proxy', true);
app.use('/assets', express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: path.join(__dirname, '..', 'uploads-tmp') });
fs.mkdirSync(path.join(__dirname, '..', 'uploads-tmp'), { recursive: true });

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(value) {
  if (value == null) return '-';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value));
}

function logoTag() {
  const base = path.join(__dirname, 'public');
  for (const file of ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp']) {
    if (fs.existsSync(path.join(base, file))) return `<img src="/assets/${file}" alt="Logo" />`;
  }
  return '';
}

function getGalleryDomain() {
  return String(process.env.GALLERY_DOMAIN || '').trim().toLowerCase();
}

function getGalleryBaseUrl() {
  const domain = getGalleryDomain();
  return domain ? `https://${domain}` : '';
}

function getPublicGallerySubtitle() {
  return process.env.GALLERY_TITLE || process.env.PANEL_TITLE || process.env.APP_NAME || 'Galeria pública';
}

function getPublicLeadFallbackName() {
  return process.env.PUBLIC_LEAD_FALLBACK_NAME || process.env.PANEL_TITLE || process.env.APP_NAME || 'Atendimento';
}

function getPublicGalleryHomeTitle() {
  return process.env.PUBLIC_GALLERY_HOME_TITLE || 'Galeria pública de imóveis';
}

function getPublicGalleryHomeSubtitle() {
  return process.env.PUBLIC_GALLERY_HOME_SUBTITLE || 'Galeria pública de imóveis.';
}

function getPublicFormTitle() {
  return process.env.PUBLIC_FORM_TITLE || 'Formulário de interesse';
}

function getPublicFormSubtitle() {
  return process.env.PUBLIC_FORM_SUBTITLE || 'Enquanto você preenche o formulário, o sistema estará pesquisando em nosso catálogo, imóveis que atendam ao seu interesse.';
}

function getFormDomain() {
  return String(process.env.FORM_DOMAIN || '').trim().toLowerCase();
}

function getFormBaseUrl(req = null) {
  const domain = getFormDomain();
  if (domain) return `https://${domain}`;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return '';
}

function normalizarCodigoFuncionario(value) {
  return String(value || '').trim().toUpperCase();
}

function montarLinkFormularioCorretor(codigo, req = null) {
  const codigoNormalizado = normalizarCodigoFuncionario(codigo);
  if (!codigoNormalizado) return '';
  const base = getFormBaseUrl(req);
  const formPath = `/formulario?corretor=${encodeURIComponent(codigoNormalizado)}`;
  return base ? `${base}${formPath}` : formPath;
}

function getPublicFormSuccessMessage() {
  return process.env.PUBLIC_FORM_SUCCESS_MESSAGE || 'Recebemos suas informações com sucesso. Em breve entraremos em contato.';
}

function getPublicFormNoMatchMessage() {
  return process.env.PUBLIC_FORM_NO_MATCH_MESSAGE || 'Nossa pesquisa não encontrou em nosso portifólio, imóvel compatível com seu interesse neste momento. Nossos corretores estarão empenhados em encontrar algo que lhe sirva.';
}

function themeVarsCss() {
  const vars = {
    '--theme-header-bg': process.env.THEME_HEADER_BG || '#111827',
    '--theme-header-text': process.env.THEME_HEADER_TEXT || '#ffffff',
    '--theme-header-border': process.env.THEME_HEADER_BORDER || '#d4af37',
    '--theme-brand-highlight': process.env.THEME_BRAND_HIGHLIGHT || '#f4c542',
    '--theme-brand-subtext': process.env.THEME_BRAND_SUBTEXT || '#d1d5db',
    '--theme-menu-text': process.env.THEME_MENU_TEXT || '#ffffff',
    '--theme-page-title': process.env.THEME_PAGE_TITLE || '#111827',
    '--theme-page-subtitle': process.env.THEME_PAGE_SUBTITLE || '#6b7280',
    '--theme-menu-border': process.env.THEME_MENU_BORDER || 'rgba(255,255,255,.14)',
    '--theme-menu-active-bg': process.env.THEME_MENU_ACTIVE_BG || '#d4af37',
    '--theme-menu-active-text': process.env.THEME_MENU_ACTIVE_TEXT || '#111827',
    '--theme-menu-active-border': process.env.THEME_MENU_ACTIVE_BORDER || '#d4af37',
  };
  return `:root{${Object.entries(vars).map(([k, v]) => `${k}:${String(v).trim()};`).join('')}}`;
}

function getPdfTheme() {
  return {
    headerBg: process.env.PDF_HEADER_BG || '#000000',
    headerText: process.env.PDF_HEADER_TEXT || '#ffffff',
    brandHighlight: process.env.PDF_BRAND_HIGHLIGHT || process.env.THEME_BRAND_HIGHLIGHT || '#f4c542',
    badgeBg: process.env.PDF_BADGE_BG || process.env.THEME_MENU_ACTIVE_BG || '#f4c542',
    badgeText: process.env.PDF_BADGE_TEXT || process.env.THEME_MENU_ACTIVE_TEXT || '#111827',
  };
}

function getBasicAuthRealm() {
  return process.env.PANEL_AUTH_REALM || process.env.APP_NAME || 'Painel Imobiliário';
}

function getAuditActor() {
  return process.env.APP_AUDIT_ACTOR || 'system';
}

function getPublicFormAtendenteName() {
  return process.env.PUBLIC_FORM_ATTENDANT_NAME || 'Formulário';
}

function getPublicFormMatchTitle() {
  return process.env.PUBLIC_FORM_MATCH_TITLE || 'Imóvel(is) compatível';
}

function getPublicFormMatchHint() {
  return process.env.PUBLIC_FORM_MATCH_HINT || 'Preencha nome, telefone, cidade, tipo de imóvel e faixa de valor para ver sugestões';
}

function getPublicFormMatchLoadingText() {
  return process.env.PUBLIC_FORM_MATCH_LOADING_TEXT || 'Buscando imóveis compatíveis...';
}

function getPublicFormMatchFoundText(total) {
  const template = process.env.PUBLIC_FORM_MATCH_FOUND_TEMPLATE || 'Encontramos <span class="match-highlight">{{total}} imóvel(is) compatível(is)</span> com seu interesse, preencha o formulário e envie para visualizar as opções disponíveis';
  return template.replace(/\{\{\s*total\s*\}\}/g, String(total));
}

function getPublicFormResultTitle() {
  return process.env.PUBLIC_FORM_RESULT_TITLE || 'Imóveis compatíveis com seu interesse';
}

function getPublicFormReceivedTitle() {
  return process.env.PUBLIC_FORM_RECEIVED_TITLE || 'Recebemos seu interesse';
}

function getOpportunityEmptyMessage() {
  return process.env.OPPORTUNITY_EMPTY_MESSAGE || 'Ainda não há oportunidades com score relevante.';
}

function formatarDataHoraHumana(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

function getPublicUnavailablePropertyMessage() {
  return process.env.PUBLIC_UNAVAILABLE_PROPERTY_MESSAGE || 'Imóvel indisponível';
}

function getPublicFormLeadNote() {
  return process.env.PUBLIC_FORM_LEAD_NOTE || 'Lead recebido via formulário público';
}

function getLeadBrokerLabel() {
  return process.env.LEAD_BROKER_LABEL || 'Corretor';
}

function getLeadAttendantLabel() {
  return process.env.LEAD_ATTENDANT_LABEL || 'Atendente';
}

function getAppInternalName() {
  return process.env.APP_INTERNAL_NAME || 'corretorcenter';
}

function getAppDisplayName() {
  return process.env.APP_NAME || 'CorretorCenter';
}

function getAuthRequiredMessage() {
  return process.env.AUTH_REQUIRED_MESSAGE || 'Autenticação necessária';
}

function getRecoveryEmail() {
  return String(process.env.PANEL_RECOVERY_EMAIL || '').trim().toLowerCase();
}

function recoveryTokenFilePath() {
  return path.join(__dirname, '..', 'storage', 'recovery-token.json');
}

function recoveryBaseUrl(req = null) {
  const panelDomain = String(process.env.PANEL_DOMAIN || '').trim().toLowerCase();
  if (panelDomain) return `https://${panelDomain}`;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return '';
}

function recoveryLink(req, token) {
  const base = recoveryBaseUrl(req);
  return base ? `${base}/recuperar-acesso/redefinir?token=${encodeURIComponent(token)}` : `/recuperar-acesso/redefinir?token=${encodeURIComponent(token)}`;
}

function criarTokenRecuperacao() {
  return crypto.randomBytes(32).toString('hex');
}

function hashTokenRecuperacao(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function lerRecuperacaoAtiva() {
  const file = recoveryTokenFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function salvarRecuperacaoAtiva(data) {
  const file = recoveryTokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function limparRecuperacaoAtiva() {
  try { fs.unlinkSync(recoveryTokenFilePath()); } catch {}
}

function tokenRecuperacaoValido(token) {
  const atual = lerRecuperacaoAtiva();
  if (!atual || !atual.tokenHash || !atual.expiresAt) return { ok: false, reason: 'missing' };
  if (new Date(atual.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (hashTokenRecuperacao(token) !== atual.tokenHash) return { ok: false, reason: 'invalid' };
  return { ok: true, data: atual };
}

async function enviarEmailRecuperacao({ to, link }) {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASSWORD || '').trim();
  const from = String(process.env.SMTP_FROM || '').trim() || user;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true' || port === 465;
  if (!host || !from) throw new Error('SMTP não configurado. Defina SMTP_HOST, SMTP_PORT, SMTP_FROM, SMTP_USER e SMTP_PASSWORD.');
  const transporter = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined });
  await transporter.sendMail({
    from,
    to,
    subject: 'Recuperação de acesso ao painel',
    text: `Foi solicitada uma recuperação de acesso ao painel.\n\nUse este link para redefinir usuário e senha:\n${link}\n\nEste link expira em 5 minutos. Se você não solicitou essa recuperação, ignore este e-mail.`,
    html: `<p>Foi solicitada uma recuperação de acesso ao painel.</p><p>Use este link para redefinir usuário e senha:</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>Este link expira em 5 minutos. Se você não solicitou essa recuperação, ignore este e-mail.</p>`,
  });
}

function renderRecoveryRequestPage({ error = '', ok = '', email = '' } = {}) {
  const successMode = Boolean(ok && !error);
  return formShell({
    title: successMode ? 'E-mail enviado' : 'Recuperação de acesso',
    subtitle: successMode ? 'O pedido de recuperação foi enviado com sucesso.' : 'Informe o e-mail de recuperação cadastrado para receber o link de redefinição.',
    content: `
      <section class="card" style="max-width:720px;margin:0 auto;">
        ${error ? `<div class="card form-error">${esc(error)}</div>` : ''}
        ${ok ? `<div class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">${esc(ok)}</div>` : ''}
        ${successMode ? `
          <div style="margin-top:16px;display:flex;justify-content:center;">
            <a href="/recuperar-acesso"><button type="button">Enviar novamente</button></a>
          </div>
        ` : `
        <form method="post" action="/recuperar-acesso">
          <div class="search-blocks">
            <div class="search-block">
              <div class="grid-2">
                <div class="field-full">
                  <label>E-mail de recuperação</label>
                  <input type="email" name="email" value="${esc(email)}" placeholder="recuperacao@seudominio.com" required />
                  <small class="muted">Use o mesmo e-mail configurado na instalação.</small>
                </div>
              </div>
            </div>
          </div>
          <div class="filters-actions">
            <button type="submit">Enviar link de recuperação</button>
          </div>
        </form>
        `}
      </section>
    `,
  });
}

function renderRecoveryResetPage({ error = '', token = '', username = '', password = '', confirmPassword = '' } = {}) {
  return formShell({
    title: 'Redefinir acesso',
    subtitle: 'Defina o novo usuário e a nova senha do painel.',
    content: `
      <section class="card" style="max-width:720px;margin:0 auto;">
        ${error ? `<div class="card form-error">${esc(error)}</div>` : ''}
        <form method="post" action="/recuperar-acesso/redefinir">
          <input type="hidden" name="token" value="${esc(token)}" />
          <div class="search-blocks">
            <div class="search-block">
              <div class="grid-2">
                <div><label>Novo usuário do painel</label><input name="panelAdminUser" value="${esc(username)}" required /></div>
                <div><label>Nova senha do painel</label><input type="password" name="panelAdminPassword" value="${esc(password)}" required /></div>
                <div class="field-full"><label>Confirmar nova senha</label><input type="password" name="panelAdminPasswordConfirm" value="${esc(confirmPassword)}" required /></div>
              </div>
            </div>
          </div>
          <div class="filters-actions">
            <button type="submit">Salvar novo acesso</button>
          </div>
        </form>
      </section>
    `,
  });
}

function renderSystemHomePage({ error = '', info = '' } = {}) {
  const company = process.env.PANEL_TITLE || getAppDisplayName();
  return formShell({
    title: company,
    subtitle: 'Plataforma de gestão imobiliária',
    content: `
      <section class="card login-home-card" style="overflow:hidden;">
        <div class="login-home-grid">
          <div class="login-home-brand-column">
            <img src="/assets/logo-login.jpg" alt="Logo ${esc(company)}" class="login-home-logo" />
            <div class="login-home-brand-copy">
              <h2 class="page-title">${esc(company)}</h2>
              <p class="page-subtitle" style="margin-bottom:20px;">Sistema profissional para gestão, atendimento e operação do seu negócio imobiliário.</p>
            </div>
            <div class="search-block">
              <h3 style="margin-top:0;">Contato</h3>
              <div class="maintenance-list">
                <div class="maintenance-item"><strong>Fone / WhatsApp</strong><span>(51) 980357562</span></div>
                <div class="maintenance-item"><strong>E-mail</strong><span>contato@codeflowsoluctions.com</span></div>
                <div class="maintenance-item"><strong>Site</strong><span>www.codeflowsoluctions.com</span></div>
              </div>
            </div>
          </div>
          <div class="search-block login-home-access-card">
            <h3 style="margin-top:0;">Acessar o sistema</h3>
            ${error ? `<div class="card form-error">${esc(error)}</div>` : ''}
            ${info ? `<div class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">${esc(info)}</div>` : ''}
            <form method="post" action="/entrar">
              <div class="grid-2">
                <div class="field-full"><label>Usuário</label><input name="usuario" autocomplete="username" required /></div>
                <div class="field-full"><label>Senha</label><input type="password" name="senha" autocomplete="current-password" required /></div>
              </div>
              <div class="filters-actions" style="margin-top:18px;">
                <button type="submit">Entrar no painel</button>
                <a class="btn-link" href="/recuperar-acesso">Recuperar acesso</a>
              </div>
            </form>
          </div>
        </div>
      </section>
    `,
  });
}

function getExportErrorPrefix() {
  return process.env.EXPORT_ERROR_PREFIX || 'Erro ao gerar exportação';
}

function getPublicGalleryPageTitle() {
  return process.env.PUBLIC_GALLERY_PAGE_TITLE || 'Galeria pública';
}

function getCategoriesPageSubtitle() {
  return process.env.CATEGORIES_PAGE_SUBTITLE || 'Gestão das categorias usadas no cadastro e código automático dos imóveis.';
}

function getCategoriesEditSubtitle() {
  return process.env.CATEGORIES_EDIT_SUBTITLE || 'Manutenção das categorias usadas no cadastro de imóveis.';
}

function normalizarLeadBroker(value) {
  return String(value || '').trim();
}

function nomeCompletoFuncionario(item = {}) {
  return [item.nome, item.sobrenome].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
}

async function buscarFuncionarioPorCodigo(codigo) {
  const codigoNormalizado = normalizarCodigoFuncionario(codigo);
  if (!codigoNormalizado) return null;
  const result = await pool.query('SELECT id, codigo, nome, sobrenome FROM funcionarios WHERE upper(codigo) = $1 LIMIT 1', [codigoNormalizado]);
  if (!result.rows.length) return null;
  const item = result.rows[0];
  return {
    ...item,
    nome_completo: nomeCompletoFuncionario(item),
  };
}

function resolverNomeAtendimentoPublico(corretor) {
  return normalizarLeadBroker(corretor) || getPublicLeadFallbackName();
}

async function carregarCategoriasAtivas() {
  return pool.query('SELECT slug, nome_exibicao FROM categorias_imovel WHERE ativa IS TRUE ORDER BY nome_exibicao');
}

function authCookieName() {
  return 'cc_auth';
}

function authCookieSignature() {
  const secretBase = `${process.env.PANEL_ADMIN_USER || ''}:${process.env.PANEL_ADMIN_PASSWORD || ''}:${process.env.APP_NAME || 'corretorcenter'}`;
  return crypto.createHash('sha256').update(secretBase).digest('hex');
}

function authFuncionarioCookieName() {
  return 'cc_func_auth';
}

function employeeAuthSecret() {
  return `${process.env.PANEL_ADMIN_USER || ''}:${process.env.PANEL_ADMIN_PASSWORD || ''}:${process.env.APP_NAME || 'corretorcenter'}:funcionario`;
}

function criarHashSenhaFuncionario(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function validarHashSenhaFuncionario(senha, storedHash) {
  const raw = String(storedHash || '');
  const [algoritmo, salt, hash] = raw.split('$');
  if (algoritmo !== 'scrypt' || !salt || !hash) return false;
  const atual = crypto.scryptSync(String(senha || ''), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(atual, 'hex'), Buffer.from(hash, 'hex'));
}

function senhaInicialFuncionario(codigo) {
  return `LOG_${normalizarCodigoFuncionario(codigo)}`;
}

function gerarSenhaTemporariaFuncionario(codigo) {
  return `LOG_${normalizarCodigoFuncionario(codigo)}_${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function gerarTokenSessaoFuncionario(item) {
  const codigo = normalizarCodigoFuncionario(item.codigo);
  const base = `${item.id}:${codigo}:${item.login_password_hash || ''}:${employeeAuthSecret()}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

function serializarSessaoFuncionario(item) {
  const payload = Buffer.from(JSON.stringify({ id: item.id, codigo: normalizarCodigoFuncionario(item.codigo), token: gerarTokenSessaoFuncionario(item) }), 'utf8').toString('base64url');
  return payload;
}

function lerSessaoFuncionario(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const raw = cookies[authFuncionarioCookieName()];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function hasAuthenticatedSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[authCookieName()] === authCookieSignature();
}

function setAuthenticatedSession(res) {
  const cookies = [
    `${authCookieName()}=${authCookieSignature()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`,
    `${authFuncionarioCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
  res.setHeader('Set-Cookie', cookies);
}

function setFuncionarioAuthenticatedSession(res, item) {
  const cookies = [
    `${authFuncionarioCookieName()}=${serializarSessaoFuncionario(item)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`,
    `${authCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
  res.setHeader('Set-Cookie', cookies);
}

function clearAuthenticatedSession(res) {
  res.setHeader('Set-Cookie', [
    `${authCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    `${authFuncionarioCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ]);
}

async function funcionarioAutenticado(req) {
  const sessao = lerSessaoFuncionario(req);
  if (!sessao?.id || !sessao?.codigo || !sessao?.token) return null;
  const result = await pool.query('SELECT id, codigo, nome, sobrenome, login_password_hash, login_reset_required FROM funcionarios WHERE id = $1 LIMIT 1', [sessao.id]);
  if (!result.rows.length) return null;
  const item = result.rows[0];
  if (normalizarCodigoFuncionario(item.codigo) != normalizarCodigoFuncionario(sessao.codigo)) return null;
  if (gerarTokenSessaoFuncionario(item) != sessao.token) return null;
  return item;
}

async function hasValidPanelCredentials(req) {
  if (hasAuthenticatedSession(req)) return { tipo: 'admin' };
  const funcionario = await funcionarioAutenticado(req);
  if (funcionario) return { tipo: 'funcionario', funcionario };
  return null;
}

async function auth(req, res, next) {
  const panelUser = String(process.env.PANEL_ADMIN_USER || '').trim();
  const panelPass = String(process.env.PANEL_ADMIN_PASSWORD || '').trim();
  if (!panelUser || !panelPass) {
    return res.status(500).send('Credenciais do painel não configuradas. Defina PANEL_ADMIN_USER e PANEL_ADMIN_PASSWORD antes de subir o app.');
  }
  const sessao = await hasValidPanelCredentials(req);
  if (sessao?.tipo === 'admin') {
    req.authContext = sessao;
    return next();
  }
  if (sessao?.tipo === 'funcionario') {
    req.authContext = sessao;
    if (sessao.funcionario.login_reset_required && req.path !== '/primeiro-acesso-funcionario') {
      return res.redirect('/primeiro-acesso-funcionario');
    }
    return next();
  }
  const link = recoveryBaseUrl(req) ? `${recoveryBaseUrl(req)}/recuperar-acesso` : '/recuperar-acesso';
  return res.redirect(`/?erro=${encodeURIComponent(`${getAuthRequiredMessage()}. Se precisar, recupere o acesso em ${link}`)}`);
}

function validarSenhaPainel(senha) {
  return senha && senha === process.env.PANEL_ADMIN_PASSWORD;
}

function envFilePath() {
  return path.join(__dirname, '..', '.env');
}

function lerEnvArquivo() {
  const file = envFilePath();
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function atualizarEnvValores(values) {
  const file = envFilePath();
  const current = lerEnvArquivo();
  const lines = current ? current.split(/\r?\n/) : [];
  const map = new Map(Object.entries(values).map(([k, v]) => [k, String(v ?? '').trim()]));
  const seen = new Set();
  const quoteIfNeeded = (value) => /\s/.test(value) ? JSON.stringify(value) : value;
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return line;
    const key = match[1];
    if (!map.has(key)) return line;
    seen.add(key);
    return `${key}=${quoteIfNeeded(map.get(key))}`;
  });
  for (const [key, value] of map.entries()) {
    if (!seen.has(key)) next.push(`${key}=${quoteIfNeeded(value)}`);
    process.env[key] = value;
  }
  fs.writeFileSync(file, `${next.filter((line, index, arr) => !(index === arr.length - 1 && line === '')).join('\n')}\n`);
}

function pareceDominio(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(text);
}

function pareceEmailValido(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(text);
}

function configuracoesSistemaValores(source = process.env) {
  return {
    appName: source.appName || source.APP_NAME || "",
    panelTitle: source.panelTitle || source.PANEL_TITLE || "",
    panelSubtitlePdf: source.panelSubtitlePdf || source.PANEL_SUBTITLE_PDF || "",
    publicFormTitle: source.publicFormTitle || source.PUBLIC_FORM_TITLE || "",
    publicFormSubtitle: source.publicFormSubtitle || source.PUBLIC_FORM_SUBTITLE || "",
    publicGalleryTitle: source.publicGalleryTitle || source.PUBLIC_GALLERY_HOME_TITLE || "",
    leadFallbackName: source.leadFallbackName || source.PUBLIC_LEAD_FALLBACK_NAME || "",
    themeHeaderBg: source.themeHeaderBg || source.THEME_HEADER_BG || "",
    themeHeaderText: source.themeHeaderText || source.THEME_HEADER_TEXT || "",
    themeBrandHighlight: source.themeBrandHighlight || source.THEME_BRAND_HIGHLIGHT || "",
    themeBrandSubtext: source.themeBrandSubtext || source.THEME_BRAND_SUBTEXT || "",
    themeMenuText: source.themeMenuText || source.THEME_MENU_TEXT || "",
    themePageTitle: source.themePageTitle || source.THEME_PAGE_TITLE || "",
    themePageSubtitle: source.themePageSubtitle || source.THEME_PAGE_SUBTITLE || "",
    themeMenuActiveBg: source.themeMenuActiveBg || source.THEME_MENU_ACTIVE_BG || "",
    themeMenuActiveText: source.themeMenuActiveText || source.THEME_MENU_ACTIVE_TEXT || "",
    panelAdminUser: source.panelAdminUser || source.PANEL_ADMIN_USER || "",
    panelAdminPassword: source.panelAdminPassword || "",
    panelRecoveryEmail: source.panelRecoveryEmail || source.PANEL_RECOVERY_EMAIL || "",
    panelDomain: source.panelDomain || source.PANEL_DOMAIN || "",
    formDomain: source.formDomain || source.FORM_DOMAIN || "",
    galleryDomain: source.galleryDomain || source.GALLERY_DOMAIN || "",
    imagesDomain: source.imagesDomain || source.IMAGES_DOMAIN || "",
  };
}

function montarStatusConfiguracaoSistema() {
  const env = configuracoesSistemaValores();
  const checks = [
    { label: "Identidade básica", ok: Boolean(env.appName && env.panelTitle), hint: "Defina nome do sistema e título do painel." },
    { label: "Acesso do painel", ok: Boolean(env.panelAdminUser && process.env.PANEL_ADMIN_PASSWORD), hint: "Configure usuário e senha do painel." },
    { label: "E-mail de recuperação", ok: pareceEmailValido(env.panelRecoveryEmail), hint: "Informe um e-mail válido para recuperação de acesso." },
    { label: "Domínio do painel", ok: Boolean(env.panelDomain), hint: "Informe o domínio principal do painel administrativo." },
    { label: "Domínio do formulário", ok: Boolean(env.formDomain), hint: "Informe onde o formulário público ficará disponível." },
    { label: "Domínio da galeria", ok: Boolean(env.galleryDomain), hint: "Informe o domínio da galeria pública." },
    { label: "Domínio das imagens", ok: Boolean(env.imagesDomain), hint: "Informe o domínio base dos arquivos de imagem." },
    { label: "Logo da empresa", ok: Boolean(logoTag()), hint: "Envie a logo da empresa para reforçar a identidade visual." },
  ];
  const concluidos = checks.filter((item) => item.ok).length;
  const total = checks.length;
  const percentual = Math.round((concluidos / total) * 100);
  const pendencias = checks.filter((item) => !item.ok);
  return { checks, concluidos, total, percentual, pendencias };
}

async function montarStatusManutencaoSistema() {
  const rootDir = path.join(__dirname, '..');
  const deployDir = path.join(rootDir, 'deploy');
  const backupsDir = path.join(rootDir, 'backups');
  const packageFile = path.join(rootDir, 'package.json');
  let version = '-';
  try {
    version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version || '-';
  } catch {}
  const fileExists = (relativePath) => fs.existsSync(path.join(rootDir, relativePath));
  const generatedFiles = [
    'deploy/corretorcenter.generated.service',
                'scripts/update-assisted.sh',
    'deploy/UPDATE_FLOW.md',
    '.update-manifest.json',
  ].map((relativePath) => ({
    path: relativePath,
    ok: fileExists(relativePath),
  }));
  const installedVersion = String(process.env.INSTALLED_VERSION || version || '').trim();
  const clientLabel = String(process.env.CLIENT_LABEL || '').trim();
  const panelDomain = String(process.env.PANEL_DOMAIN || '').trim();
  const formDomain = String(process.env.FORM_DOMAIN || '').trim();
  const galleryDomain = String(process.env.GALLERY_DOMAIN || '').trim();
  const imagesDomain = String(process.env.IMAGES_DOMAIN || '').trim();
  const servicePublished = fs.existsSync('/etc/systemd/system/corretorcenter.service');
        const domainsReady = Boolean(panelDomain && formDomain && galleryDomain && imagesDomain);
  let updateManifest = null;
  try {
    updateManifest = JSON.parse(fs.readFileSync(path.join(rootDir, '.update-manifest.json'), 'utf8'));
  } catch {}
  let detectedChanges = [];
  try {
    detectedChanges = fs.readFileSync(path.join(rootDir, '.update-detected-changes.txt'), 'utf8').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch {}
  let lastMaintenanceRun = null;
  try {
    lastMaintenanceRun = JSON.parse(fs.readFileSync(path.join(rootDir, '.last-maintenance-run.json'), 'utf8'));
  } catch {}
  let maintenanceHistory = [];
  try {
    maintenanceHistory = JSON.parse(fs.readFileSync(path.join(rootDir, '.maintenance-history.json'), 'utf8'));
    if (!Array.isArray(maintenanceHistory)) maintenanceHistory = [];
  } catch {}
  const lastUpdateAt = fileExists('.update-manifest.json') ? fs.statSync(path.join(rootDir, '.update-manifest.json')).mtime.toISOString() : '';
  const trackedFilesTotal = updateManifest ? Object.keys(updateManifest).length : 0;
  const changeGroups = [
    { label: 'Dependências', ok: detectedChanges.some((item) => item === 'package.json' || item === 'package-lock.json') },
    { label: 'Backend', ok: detectedChanges.includes('app/server.js') },
    { label: 'Proxy / setup', ok: detectedChanges.some((item) => item.includes('caddy') || item === 'scripts/install-wizard.sh' || item === '.env.example') },
    { label: 'Service', ok: detectedChanges.includes('deploy/corretorcenter.service.example') },
    { label: 'Update assistido', ok: detectedChanges.includes('scripts/update-assisted.sh') },
  ];
  const historySummary = {
    total: maintenanceHistory.length,
    success: maintenanceHistory.filter((item) => item && item.ok).length,
    failure: maintenanceHistory.filter((item) => item && item.ok === false).length,
    byAction: [
      { action: 'revalidar-health', label: maintenanceActionLabel('revalidar-health'), total: maintenanceHistory.filter((item) => item && item.action === 'revalidar-health').length },
      { action: 'regenerar-artefatos', label: maintenanceActionLabel('regenerar-artefatos'), total: maintenanceHistory.filter((item) => item && item.action === 'regenerar-artefatos').length },
      { action: 'rodar-update', label: maintenanceActionLabel('rodar-update'), total: maintenanceHistory.filter((item) => item && item.action === 'rodar-update').length },
    ],
  };
  let dbOk = false;
  let dbError = '';
  try {
    await pool.query('select 1');
    dbOk = true;
  } catch (error) {
    dbError = error.message;
  }
  return {
    version,
    envOk: Boolean(lerEnvArquivo().trim()),
    packageLockOk: fileExists('package-lock.json'),
    updateManifestOk: fileExists('.update-manifest.json'),
    generatedFiles,
    deployDirOk: fs.existsSync(deployDir),
    panelDomain,
    formDomain,
    galleryDomain,
    imagesDomain,
    domainsReady,
    servicePublished,
    appOk: true,
    dbOk,
    dbError,
    lastUpdateAt,
    trackedFilesTotal,
    detectedChanges,
    changeGroups,
    lastMaintenanceRun,
    maintenanceHistory,
    historySummary,
    maintenanceActionRunning: maintenanceActionRunning(),
    maintenanceActionInfo: maintenanceActionInfo(),
  };
}

function ehGaleriaModoEdicao(returnTo, imovelId) {
  if (!returnTo) return false;
  const valor = String(returnTo);
  const tentativas = [valor];
  try {
    tentativas.push(decodeURIComponent(valor));
  } catch {}
  return tentativas.some((item) => item.startsWith(`/painel/imoveis-editar/${imovelId}`));
}

function runExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function inferirProgressoUpdate(summary) {
  const text = String(summary || '').toLowerCase();
  if (text.includes('checklist pós-update') || text.includes('atualização assistida concluída')) {
    return { label: 'Finalizando a atualização e conferindo o resultado.', percent: 95 };
  }
  if (text.includes('executando migrations') || text.includes('migration')) {
    return { label: 'Atualizando a base de dados do sistema.', percent: 75 };
  }
  if (text.includes('instalando/atualizando dependências') || text.includes('npm install')) {
    return { label: 'Atualizando os componentes internos do sistema.', percent: 45 };
  }
  if (text.includes('criando backup')) {
    return { label: 'Criando um backup de segurança antes da atualização.', percent: 20 };
  }
  return null;
}

function maintenanceRunFilePath() {
  return path.join(__dirname, '..', '.last-maintenance-run.json');
}

function maintenanceProgressFilePath() {
  return path.join(__dirname, '..', '.maintenance-progress.json');
}

function maintenanceHistoryFilePath() {
  return path.join(__dirname, '..', '.maintenance-history.json');
}

function maintenanceHistoryItems(limit = 50) {
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(maintenanceHistoryFilePath(), 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {}
  return history.slice().reverse().slice(0, limit);
}

function salvarResumoManutencao(data) {
  fs.writeFileSync(maintenanceRunFilePath(), `${JSON.stringify(data, null, 2)}\n`);
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(maintenanceHistoryFilePath(), 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {}
  history.unshift(data);
  history = history.slice(0, 10);
  fs.writeFileSync(maintenanceHistoryFilePath(), `${JSON.stringify(history, null, 2)}\n`);
}

function resumirSaidaComando(text) {
  return String(text || '').replace(/\u0000/g, '').trim().split(/\r?\n/).slice(-12).join('\n').slice(0, 2000);
}

function maintenanceLockFilePath() {
  return path.join(__dirname, '..', '.maintenance-action.lock');
}

function maintenanceActionRunning() {
  return fs.existsSync(maintenanceLockFilePath());
}

function maintenanceActionInfo() {
  try {
    const lockInfo = JSON.parse(fs.readFileSync(maintenanceLockFilePath(), 'utf8'));
    try {
      const progressInfo = JSON.parse(fs.readFileSync(maintenanceProgressFilePath(), 'utf8'));
      return { ...lockInfo, ...progressInfo };
    } catch {
      return lockInfo;
    }
  } catch {
    return null;
  }
}

function maintenanceStepStatus(action, progressPercent) {
  const steps = maintenanceActionSteps(action);
  const percent = Number(progressPercent || 0);
  if (!steps.length) return [];
  const chunk = 100 / steps.length;
  return steps.map((step, index) => {
    const threshold = Math.round((index + 1) * chunk);
    const previousThreshold = Math.round(index * chunk);
    let state = 'pending';
    if (percent >= threshold) state = 'done';
    else if (percent > previousThreshold || (index === 0 && percent > 0)) state = 'active';
    return { step, state };
  });
}

function maintenanceActionLabel(action) {
  const labels = {
    'revalidar-health': 'Revalidar saúde do sistema',
    'regenerar-artefatos': 'Regenerar arquivos do setup',
    'rodar-update': 'Rodar update assistido',
  };
  return labels[action] || action || 'Ação de manutenção';
}

function maintenanceActionSteps(action) {
  const steps = {
    'revalidar-health': [
      'Verificar aplicação web',
      'Verificar banco de dados',
      'Confirmar resposta do sistema',
    ],
    'regenerar-artefatos': [
      'Ler configuração atual',
      'Gerar arquivos do setup',
      'Atualizar artefatos do painel e setup',
    ],
    'rodar-update': [
      'Criar backup de segurança',
      'Atualizar dependências do sistema',
      'Executar migrations',
      'Revalidar o ambiente',
    ],
  };
  return steps[action] || ['Preparar ação', 'Executar tarefa', 'Finalizar'];
}

function startMaintenanceAction(action) {
  fs.writeFileSync(maintenanceLockFilePath(), JSON.stringify({ action, at: new Date().toISOString(), progressLabel: 'Preparando execução', progressPercent: 10 }, null, 2));
}

function clearMaintenanceLockSafe() {
  try { fs.unlinkSync(maintenanceLockFilePath()); } catch {}
  try { fs.unlinkSync(maintenanceProgressFilePath()); } catch {}
}

function updateMaintenanceActionProgress(progressLabel, progressPercent = null) {
  const info = maintenanceActionInfo() || {};
  fs.writeFileSync(maintenanceLockFilePath(), JSON.stringify({ ...info, progressLabel, progressPercent: progressPercent == null ? (info.progressPercent ?? 10) : progressPercent, at: info.at || new Date().toISOString() }, null, 2));
}

function finishMaintenanceAction() {
  clearMaintenanceLockSafe();
}

function renderMaintenancePasswordField() {
  return '<input type="password" name="senha" placeholder="Digite a senha do painel" required />';
}

function validarSituacaoComercial() {
  return { ok: true, message: '' };
}

function scriptAutoRefreshManutencao(enabled) {
  if (!enabled) return '';
  return `<script>
    document.addEventListener('DOMContentLoaded', () => {
      const badge = document.querySelector('[data-auto-refresh-status]');
      let seconds = 15;
      const tick = () => {
        if (badge) badge.textContent = 'Atualizando automaticamente em ' + seconds + 's';
        if (seconds === 0) {
          window.location.reload();
          return;
        }
        seconds -= 1;
        setTimeout(tick, 1000);
      };
      tick();
    });
  </script>`;
}

function scriptNumeroAoDigitar() {
  return `<script>
    function confirmarSenhaPainel(event, acao, campo = 'senha') {
      const senha = window.prompt('Digite a senha para ' + acao + ':');
      if (!senha) return false;
      const input = event.target.querySelector('input[name="' + campo + '"]');
      if (input) input.value = senha;
      return true;
    }

    function acessarPaginaProtegida(event, url, acao) {
      event.preventDefault();
      const senha = window.prompt('Digite a senha para acessar ' + acao + ':');
      if (!senha) return false;
      const destino = new URL(url, window.location.origin);
      destino.searchParams.set('senha', senha);
      window.location.href = destino.toString();
      return false;
    }

    document.addEventListener('DOMContentLoaded', () => {
      const forms = document.querySelectorAll('form[data-validate-numeric]');
      forms.forEach((form) => {
        const submitButton = form.querySelector('[type="submit"]');
        const fields = form.querySelectorAll('[data-numero]');

        const normalizeCurrencyInput = (value) => {
          const raw = String(value || '').trim();
          if (!raw) return '';
          let normalized = raw.replace(/\\s+/g, '');
          if (normalized.includes(',') && normalized.includes('.')) {
            const lastComma = normalized.lastIndexOf(',');
            const lastDot = normalized.lastIndexOf('.');
            if (lastComma > lastDot) normalized = normalized.replace(/\\./g, '').replace(',', '.');
            else normalized = normalized.replace(/,/g, '');
          } else if (normalized.includes(',')) {
            const parts = normalized.split(',');
            if (parts.length === 2 && parts[1].length <= 2) normalized = parts[0].replace(/\\./g, '') + '.' + parts[1];
            else normalized = normalized.replace(/,/g, '');
          } else if (normalized.includes('.')) {
            const parts = normalized.split('.');
            if (!(parts.length === 2 && parts[1].length <= 2)) normalized = normalized.replace(/\\./g, '');
          }
          return normalized;
        };

        const validateField = (el) => {
          const decimal = el.dataset.numero === 'decimal';
          const raw = String(el.value || '').trim();
          const normalized = el.dataset.monetario === 'true' ? normalizeCurrencyInput(raw) : raw.replace(',', '.');
          const label = form.querySelector('label[for="' + el.id + '"]') || el.closest('div')?.querySelector('label');
          let marker = el.parentElement.querySelector('.field-error-marker');
          if (!marker) {
            marker = document.createElement('span');
            marker.className = 'field-error-marker';
            marker.textContent = ' *';
            marker.style.display = 'none';
            if (label) label.appendChild(marker);
          }

          let valid = true;
          if (normalized !== '') {
            if (decimal) {
              const asNumber = Number(normalized);
              valid = !Number.isNaN(asNumber) && new RegExp('^[0-9.,]+$').test(raw);
            } else {
              valid = new RegExp('^[0-9.,]+$').test(raw);
            }
          }

          el.classList.toggle('input-error', !valid);
          marker.style.display = valid ? 'none' : 'inline';
          return valid;
        };

        const refreshFormState = () => {
          let ok = true;
          fields.forEach((el) => {
            if (!validateField(el)) ok = false;
          });
          if (submitButton) submitButton.disabled = !ok;
        };

        fields.forEach((el) => {
          el.addEventListener('input', refreshFormState);
          el.addEventListener('blur', refreshFormState);
          el.addEventListener('paste', () => setTimeout(refreshFormState, 0));
        });

        refreshFormState();
      });
    });
  </script>`;
}

function textoNormalizado(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function calcularCompatibilidade(imovel, cliente) {
  const pesos = MATCH_RULES.pesos;
  let score = 0;
  const motivos = [];
  const cidadeImovel = textoNormalizado(imovel.cidade);
  const cidadeCliente = textoNormalizado(cliente.cidade);
  const bairroImovel = textoNormalizado(imovel.bairro);
  const bairroCliente = textoNormalizado(cliente.bairro);
  const tipoImovel = textoNormalizado(imovel.categoria_nome || imovel.categoria_slug);
  const tipoCliente = textoNormalizado(cliente.tipo_imovel_desejado);
  const estadoImovel = textoNormalizado(imovel.estado_imovel);
  const estadoCliente = textoNormalizado(cliente.estado_imovel_desejado);
  const propostaCliente = textoNormalizado(cliente.tipo_pagamento);

  if (tipoCliente) {
    if (!tipoImovel || tipoImovel !== tipoCliente) {
      return { score: 0, motivos: [] };
    }
    score += pesos.categoria;
    motivos.push('categoria do imóvel compatível');
  }

  const valor = Number(imovel.valor || 0);
  const min = cliente.valor_minimo == null ? null : Number(cliente.valor_minimo);
  const max = cliente.valor_maximo == null ? null : Number(cliente.valor_maximo);
  const clienteTemFaixa = min != null || max != null;
  const dentroMin = min == null || valor >= min;
  const dentroMax = max == null || valor <= max;
  if (clienteTemFaixa) {
    if (dentroMin && dentroMax) {
      score += pesos.valor;
      motivos.push('faixa de valor compatível');
    } else {
      return { score: 0, motivos: [] };
    }
  }

  if (cidadeCliente) {
    if (cidadeImovel === cidadeCliente) {
      score += pesos.cidade;
      motivos.push('mesma cidade');
    } else {
      return { score: 0, motivos: [] };
    }
  }

  if (estadoCliente) {
    if (!estadoImovel || estadoImovel !== estadoCliente) {
      return { score: 0, motivos: [] };
    }
    score += pesos.estado;
    motivos.push('estado do imóvel compatível');
  }

  if (bairroCliente && bairroImovel && bairroImovel === bairroCliente) {
    score += pesos.bairro;
    motivos.push('mesmo bairro');
  }

  const comparacoes = [
    ['numero_quartos_desejado', 'numero_dormitorios', 'quartos compatíveis'],
    ['numero_banheiros_desejado', 'numero_banheiros', 'banheiros compatíveis'],
    ['numero_vagas_garagem_desejada', 'numero_vagas_garagem', 'vagas compatíveis'],
    ['numero_suites_desejada', 'numero_suites', 'suítes compatíveis'],
  ];

  let pontosEstrutura = 0;
  for (const [campoCliente, campoImovel, motivo] of comparacoes) {
    const desejado = cliente[campoCliente] == null ? null : Number(cliente[campoCliente]);
    const atual = imovel[campoImovel] == null ? null : Number(imovel[campoImovel]);
    if (desejado != null && atual != null && atual >= desejado) {
      pontosEstrutura += pesos.estruturaPorItem;
      motivos.push(motivo);
    }
  }
  score += pontosEstrutura;

  if (propostaCliente) {
    score += pesos.propostaRegistrada;
    motivos.push('tipo de pagamento registrado');
  }

  return { score: Math.round(score), motivos };
}

async function buscarMatchesParaCliente(cliente, limit = 5) {
  const imoveis = await pool.query(`SELECT i.*, c.nome_exibicao AS categoria_nome FROM imoveis i LEFT JOIN categorias_imovel c ON c.slug = i.categoria_slug WHERE lower(coalesce(i.status_publicacao, 'disponivel')) = 'disponivel' ORDER BY i.created_at DESC`);
  const matches = [];
  for (const imovel of imoveis.rows) {
    const match = calcularCompatibilidade(imovel, cliente);
    if (match.score >= MATCH_RULES.scoreMinimo) {
      matches.push({ imovel, score: match.score, motivos: match.motivos.slice(0, 4) });
    }
  }
  matches.sort((a, b) => b.score - a.score || String(a.imovel.codigo).localeCompare(String(b.imovel.codigo)));
  return matches.slice(0, limit);
}

async function carregarOportunidades(limit = 5) {
  const clientes = await pool.query('SELECT * FROM clientes ORDER BY data_cadastro DESC');
  const oportunidades = [];
  for (const cliente of clientes.rows) {
    const matches = await buscarMatchesParaCliente(cliente, limit);
    for (const match of matches) {
      oportunidades.push({ imovel: match.imovel, cliente, score: match.score, motivos: match.motivos });
    }
  }
  oportunidades.sort((a, b) => b.score - a.score || String(a.imovel.codigo).localeCompare(String(b.imovel.codigo)));
  return oportunidades.slice(0, limit);
}

function montarClientePreviewMatch(source = {}) {
  return {
    nome: String(source.nome || '').trim(),
    telefone: normalizarTelefone(source.telefone || ''),
    cidade: String(source.cidade || '').trim(),
    bairro: String(source.bairro || '').trim(),
    tipo_imovel_desejado: String(source.tipo_imovel_desejado || '').trim(),
    estado_imovel_desejado: String(source.estado_imovel_desejado || '').trim(),
    numero_quartos_desejado: normalizarNumeroFormulario(source.numero_quartos_desejado),
    numero_banheiros_desejado: normalizarNumeroFormulario(source.numero_banheiros_desejado),
    numero_vagas_garagem_desejada: normalizarNumeroFormulario(source.numero_vagas_garagem_desejada),
    numero_suites_desejada: normalizarNumeroFormulario(source.numero_suites_desejada),
    valor_minimo: normalizarNumeroFormulario(source.valor_minimo, { decimal: true }),
    valor_maximo: normalizarNumeroFormulario(source.valor_maximo, { decimal: true }),
    tipo_pagamento: String(source.tipo_pagamento || '').trim(),
  };
}

async function carregarSugestoesLocalizacao() {
  const [cidadesResult, bairrosResult] = await Promise.all([
    pool.query("SELECT DISTINCT cidade FROM imoveis WHERE cidade IS NOT NULL AND trim(cidade) <> '' ORDER BY cidade"),
    pool.query("SELECT DISTINCT cidade, bairro FROM imoveis WHERE cidade IS NOT NULL AND trim(cidade) <> '' AND bairro IS NOT NULL AND trim(bairro) <> '' ORDER BY cidade, bairro"),
  ]);
  const bairrosPorCidade = bairrosResult.rows.reduce((acc, item) => {
    const cidade = String(item.cidade || '').trim();
    const bairro = String(item.bairro || '').trim();
    if (!cidade || !bairro) return acc;
    if (!acc[cidade]) acc[cidade] = [];
    if (!acc[cidade].includes(bairro)) acc[cidade].push(bairro);
    return acc;
  }, {});
  return { cidades: cidadesResult.rows, bairrosPorCidade };
}

function renderLocationDatalists({ cidades = [], bairrosPorCidade = {} }) {
  return `
    <datalist id="cidades-imoveis">
      ${cidades.map((item) => `<option value="${esc(item.cidade)}"></option>`).join('')}
    </datalist>
    <datalist id="bairros-imoveis"></datalist>
    <script>
      document.addEventListener('DOMContentLoaded', () => {
        const cidadeInput = document.querySelector('input[name="cidade"]');
        const bairroInput = document.querySelector('input[name="bairro"]');
        const bairrosList = document.getElementById('bairros-imoveis');
        const bairrosPorCidade = ${JSON.stringify(bairrosPorCidade)};

        const renderBairros = () => {
          if (!cidadeInput || !bairroInput || !bairrosList) return;
          const cidade = String(cidadeInput.value || '').trim();
          const bairros = bairrosPorCidade[cidade] || [];
          bairrosList.innerHTML = bairros.map((bairro) => '<option value="' + String(bairro).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"></option>').join('');
        };

        if (cidadeInput && bairroInput && bairrosList) {
          cidadeInput.addEventListener('input', renderBairros);
          cidadeInput.addEventListener('change', renderBairros);
          renderBairros();
        }
      });
    </script>
  `;
}

function shell({ title, subtitle = '', active = 'inicio', content }) {
  const company = process.env.PANEL_TITLE || getAppDisplayName();
  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} - ${esc(company)}</title>
    <link rel="stylesheet" href="/assets/style.css" />
    <style>${themeVarsCss()}</style>
  </head>
  <body>
    <header class="panel-header">
      <div class="panel-header-inner">
        <div class="brand">
          ${logoTag()}
          <div>
            <h1>${esc(company)}</h1>
            <p>${esc(title)}</p>
          </div>
        </div>
        <nav class="panel-menu">
          <a href="/painel" class="${active === 'inicio' ? 'active' : ''}">Início</a>
          <a href="/painel/funcionarios" class="${['funcionarios', 'novo-funcionario', 'cargos-funcionarios'].includes(active) ? 'active' : ''}">Funcionários</a>
          <a href="/painel/imoveis" class="${active === 'imoveis' ? 'active' : ''}">Pesquisar imóveis</a>
          <a href="/painel/imoveis/novo" class="${active === 'novo-imovel' ? 'active' : ''}">Cadastrar imóvel</a>
          <a href="/painel/categorias" class="${active === 'categorias' ? 'active' : ''}">Categorias</a>
          <a href="/painel/clientes" class="${active === 'clientes' ? 'active' : ''}">Pesquisar clientes</a>
          <a href="/painel/clientes/novo" class="${active === 'novo-cliente' ? 'active' : ''}">Cadastrar cliente</a>
          <a href="/painel/clientes/simular-compatibilidade" class="${active === 'simular-compatibilidade' ? 'active' : ''}">Simular compatibilidade</a>
          <a href="/painel/oportunidades" class="${active === 'oportunidades' ? 'active' : ''}">Oportunidades</a>
          <a href="/painel/configuracoes" class="${active === 'configuracoes' ? 'active' : ''}" onclick="return acessarPaginaProtegida(event, '/painel/configuracoes', 'Configurações')">Configurações</a>
          <a href="/painel/manutencao" class="${active === 'manutencao' ? 'active' : ''}" onclick="return acessarPaginaProtegida(event, '/painel/manutencao', 'Manutenção')">Manutenção</a>
          <a href="/painel/backup-restaurar" class="${active === 'backup-restaurar' ? 'active' : ''}" onclick="return acessarPaginaProtegida(event, '/painel/backup-restaurar', 'Backup/Restaurar')">Backup/Restaurar</a>
          <a href="/logout">Sair</a>
        </nav>
      </div>
    </header>
    <main class="wrap">
      <div class="card">
        <h2 class="page-title">${esc(title)}</h2>
        ${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ''}
      </div>
      ${content}
      ${scriptNumeroAoDigitar()}
    </main>
  </body>
  </html>`;
}

function formShell({ title, subtitle = '', content }) {
  const company = process.env.PANEL_TITLE || getAppDisplayName();
  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} - ${esc(company)}</title>
    <link rel="stylesheet" href="/assets/style.css" />
    <style>${themeVarsCss()}</style>
  </head>
  <body>
    <header class="panel-header">
      <div class="panel-header-inner">
        <div class="brand">
          ${logoTag()}
          <div>
            <h1>${esc(company)}</h1>
            <p>${esc(title)}</p>
          </div>
        </div>
      </div>
    </header>
    <main class="wrap">
      ${content}
      ${scriptNumeroAoDigitar()}
    </main>
  </body>
  </html>`;
}

function formResultadoShell({ title, content }) {
  return formShell({ title, subtitle: '', content });
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function directoryHasFiles(dir, depth = 3) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && depth > 0) {
        if (directoryHasFiles(path.join(dir, entry.name), depth - 1)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function resolveMediaRoot() {
  const rootDir = path.join(__dirname, '..');
  const candidates = [
    process.env.MEDIA_ROOT,
    path.join(rootDir, 'storage', 'images'),
    path.join(rootDir, 'storage'),
    path.join(path.dirname(rootDir), 'CorretorCenter', 'storage', 'images'),
    path.join(path.dirname(rootDir), 'CorretorCenter', 'storage'),
  ].filter(Boolean).map((item) => path.resolve(String(item)));

  const existing = candidates.find((dir) => fs.existsSync(dir) && directoryHasFiles(dir));
  if (existing) return existing;
  const firstExisting = candidates.find((dir) => fs.existsSync(dir));
  return firstExisting || path.resolve(path.join(rootDir, 'storage', 'images'));
}

const mediaRoot = resolveMediaRoot();
fs.mkdirSync(mediaRoot, { recursive: true });
app.use('/files', express.static(mediaRoot));
app.use('/painel', (req, res, next) => {
  if (req.path.startsWith('/imoveis-pdf/')) return next();
  return auth(req, res, next);
});
app.get('/', async (req, res) => {
  const host = String(req.headers.host || '').toLowerCase();
  const galleryDomain = getGalleryDomain();
  const formDomain = String(process.env.FORM_DOMAIN || '').trim().toLowerCase();
  if (formDomain && host.startsWith(formDomain)) {
    return res.redirect('/formulario');
  }
  if (galleryDomain && host.startsWith(galleryDomain)) {
    return res.send(formShell({
      title: getPublicGalleryPageTitle(),
      subtitle: getPublicGallerySubtitle(),
      content: `
        <section class="card">
          <h2 class="page-title">${esc(getPublicGalleryHomeTitle())}</h2>
          <p class="page-subtitle">${esc(getPublicGalleryHomeSubtitle())}</p>
        </section>
      `,
    }));
  }
  if (await hasValidPanelCredentials(req)) return res.redirect('/painel');
  return res.send(renderSystemHomePage({
    error: req.query.erro ? decodeURIComponent(req.query.erro) : '',
    info: req.query.info ? decodeURIComponent(req.query.info) : '',
  }));
});

app.post('/entrar', async (req, res) => {
  const usuario = String(req.body.usuario || '').trim();
  const senha = String(req.body.senha || '').trim();
  const panelUser = String(process.env.PANEL_ADMIN_USER || '').trim();
  const panelPass = String(process.env.PANEL_ADMIN_PASSWORD || '').trim();
  if (!usuario || !senha) {
    return res.status(400).send(renderSystemHomePage({ error: 'Informe usuário e senha para entrar.' }));
  }
  if (usuario === panelUser && senha === panelPass) {
    setAuthenticatedSession(res);
    return res.redirect('/painel');
  }
  const funcionarioResult = await pool.query('SELECT id, codigo, nome, sobrenome, login_password_hash, login_reset_required FROM funcionarios WHERE upper(codigo) = $1 LIMIT 1', [normalizarCodigoFuncionario(usuario)]);
  if (!funcionarioResult.rows.length || !validarHashSenhaFuncionario(senha, funcionarioResult.rows[0].login_password_hash)) {
    return res.status(401).send(renderSystemHomePage({ error: 'Usuário ou senha inválidos.' }));
  }
  const funcionario = funcionarioResult.rows[0];
  setFuncionarioAuthenticatedSession(res, funcionario);
  if (funcionario.login_reset_required) return res.redirect('/primeiro-acesso-funcionario');
  return res.redirect('/painel');
});

app.get('/primeiro-acesso-funcionario', async (req, res) => {
  const funcionario = await funcionarioAutenticado(req);
  if (!funcionario) return res.redirect('/?erro=' + encodeURIComponent('Faça login para continuar.'));
  return res.send(formShell({
    title: 'Definir nova senha',
    content: `
      ${req.query.erro ? `<div class="card form-error">${esc(decodeURIComponent(req.query.erro))}</div>` : ''}
      <section class="card">
        <h2 class="page-title">Definir nova senha</h2>
        <p class="page-subtitle">Olá, ${esc([funcionario.nome, funcionario.sobrenome].filter(Boolean).join(' '))}. Defina sua nova senha para continuar.</p>
        <form method="post" action="/primeiro-acesso-funcionario">
          <div class="grid">
            <div><label>Usuário</label><input value="${esc(funcionario.codigo)}" readonly /></div>
            <div><label>Nova senha</label><input type="password" name="novaSenha" autocomplete="new-password" required /></div>
            <div><label>Confirmar nova senha</label><input type="password" name="confirmarSenha" autocomplete="new-password" required /></div>
          </div>
          <div class="filters-actions"><button type="submit">Salvar nova senha</button><a href="/logout">Sair</a></div>
        </form>
      </section>
    `,
  }));
});

app.post('/primeiro-acesso-funcionario', async (req, res) => {
  const funcionario = await funcionarioAutenticado(req);
  if (!funcionario) return res.redirect('/?erro=' + encodeURIComponent('Faça login para continuar.'));
  const novaSenha = String(req.body.novaSenha || '').trim();
  const confirmarSenha = String(req.body.confirmarSenha || '').trim();
  if (novaSenha.length < 6) {
    return res.redirect('/primeiro-acesso-funcionario?erro=' + encodeURIComponent('A nova senha deve ter pelo menos 6 caracteres.'));
  }
  if (novaSenha !== confirmarSenha) {
    return res.redirect('/primeiro-acesso-funcionario?erro=' + encodeURIComponent('A confirmação da senha não confere.'));
  }
  const novoHash = criarHashSenhaFuncionario(novaSenha);
  const result = await pool.query('UPDATE funcionarios SET login_password_hash = $2, login_reset_required = false, data_alteracao = now() WHERE id = $1 RETURNING id, codigo, nome, sobrenome, login_password_hash, login_reset_required', [funcionario.id, novoHash]);
  setFuncionarioAuthenticatedSession(res, result.rows[0]);
  return res.redirect('/painel');
});

app.get('/logout', (req, res) => {
  clearAuthenticatedSession(res);
  return res.redirect('/?info=' + encodeURIComponent('Sessão encerrada com sucesso.'));
});

app.get('/recuperar-acesso', (req, res) => {
  return res.send(renderRecoveryRequestPage({
    error: req.query.erro ? decodeURIComponent(req.query.erro) : '',
    ok: req.query.ok ? decodeURIComponent(req.query.ok) : '',
    email: req.query.email ? decodeURIComponent(req.query.email) : '',
  }));
});

app.post('/recuperar-acesso', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const recoveryEmail = getRecoveryEmail();
  if (!pareceEmailValido(email)) {
    return res.status(400).send(renderRecoveryRequestPage({ error: 'Informe um e-mail válido.', email }));
  }
  if (!recoveryEmail) {
    return res.status(500).send(renderRecoveryRequestPage({ error: 'O e-mail de recuperação não está configurado na instalação.', email }));
  }
  if (email !== recoveryEmail) {
    return res.status(400).send(renderRecoveryRequestPage({ error: 'O e-mail informado não é o e-mail cadastrado para recuperação.', email }));
  }
  try {
    const token = criarTokenRecuperacao();
    const expiresAt = new Date(Date.now() + (5 * 60 * 1000)).toISOString();
    salvarRecuperacaoAtiva({ tokenHash: hashTokenRecuperacao(token), expiresAt, requestedAt: new Date().toISOString() });
    await enviarEmailRecuperacao({ to: recoveryEmail, link: recoveryLink(req, token) });
    return res.send(renderRecoveryRequestPage({ ok: 'E-mail de recuperação enviado com sucesso.', email: '' }));
  } catch (error) {
    console.error('ERRO RECUPERACAO EMAIL', error);
    return res.status(500).send(renderRecoveryRequestPage({ error: error.message || 'Não foi possível enviar o e-mail de recuperação.', email }));
  }
});

app.get('/recuperar-acesso/redefinir', (req, res) => {
  const token = String(req.query.token || '').trim();
  const status = tokenRecuperacaoValido(token);
  if (!token || !status.ok) {
    return res.status(400).send(renderRecoveryRequestPage({ error: 'Link de recuperação inválido ou expirado.' }));
  }
  return res.send(renderRecoveryResetPage({ token }));
});

app.post('/recuperar-acesso/redefinir', (req, res) => {
  const token = String(req.body.token || '').trim();
  const panelAdminUser = String(req.body.panelAdminUser || '').trim();
  const panelAdminPassword = String(req.body.panelAdminPassword || '').trim();
  const panelAdminPasswordConfirm = String(req.body.panelAdminPasswordConfirm || '').trim();
  const status = tokenRecuperacaoValido(token);
  if (!token || !status.ok) {
    return res.status(400).send(renderRecoveryRequestPage({ error: 'Link de recuperação inválido ou expirado.' }));
  }
  if (!panelAdminUser) {
    return res.status(400).send(renderRecoveryResetPage({ error: 'Informe o novo usuário do painel.', token, username: panelAdminUser }));
  }
  if (panelAdminPassword.length < 6) {
    return res.status(400).send(renderRecoveryResetPage({ error: 'A nova senha do painel deve ter pelo menos 6 caracteres.', token, username: panelAdminUser }));
  }
  if (panelAdminPassword !== panelAdminPasswordConfirm) {
    return res.status(400).send(renderRecoveryResetPage({ error: 'A confirmação da senha não confere.', token, username: panelAdminUser }));
  }
  atualizarEnvValores({ PANEL_ADMIN_USER: panelAdminUser, PANEL_ADMIN_PASSWORD: panelAdminPassword });
  limparRecuperacaoAtiva();
  return res.send(formShell({
    title: 'Acesso redefinido',
    subtitle: 'Usuário e senha atualizados com sucesso.',
    content: `
      <section class="card" style="max-width:720px;margin:0 auto;border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;">
        <strong>Recuperação concluída.</strong>
        <p style="margin:12px 0 0;">O novo acesso já está valendo. Volte ao painel e entre com as credenciais atualizadas.</p>
        <div class="filters-actions" style="margin-top:18px;">
          <a class="btn-link" href="/">Fazer login</a>
        </div>
      </section>
    `,
  }));
});

app.get('/formulario/matches', async (req, res) => {
  const cliente = {
    cidade: req.query.cidade || '',
    bairro: req.query.bairro || '',
    tipo_imovel_desejado: req.query.tipo_imovel_desejado || '',
    estado_imovel_desejado: req.query.estado_imovel_desejado || '',
    valor_minimo: normalizarNumeroFormulario(req.query.valor_minimo || '', { decimal: true }),
    valor_maximo: normalizarNumeroFormulario(req.query.valor_maximo || '', { decimal: true }),
    numero_quartos_desejado: normalizarNumeroFormulario(req.query.numero_quartos_desejado || ''),
    numero_banheiros_desejado: normalizarNumeroFormulario(req.query.numero_banheiros_desejado || ''),
    numero_vagas_garagem_desejada: normalizarNumeroFormulario(req.query.numero_vagas_garagem_desejada || ''),
    numero_suites_desejada: normalizarNumeroFormulario(req.query.numero_suites_desejada || ''),
    tipo_pagamento: req.query.tipo_pagamento || '',
  };

  const matches = await buscarMatchesParaCliente(cliente, 3);
  res.json({
    total: matches.length,
    items: matches.map(({ imovel, score, motivos }) => ({
      codigo: imovel.codigo,
      titulo: imovel.titulo,
      cidade: imovel.cidade,
      bairro: imovel.bairro,
      valor: imovel.valor,
      score,
      motivos,
    })),
  });
});

app.get('/formulario', async (req, res) => {
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const corretorCodigo = normalizarCodigoFuncionario(req.query.corretor);
  const [categoriasCliente, sugestoesClientes, funcionarioLead] = await Promise.all([
    carregarCategoriasAtivas(),
    pool.query("SELECT nome, telefone FROM clientes WHERE (nome IS NOT NULL AND nome <> '') OR (telefone IS NOT NULL AND telefone <> '') ORDER BY nome NULLS LAST, telefone NULLS LAST LIMIT 200"),
    buscarFuncionarioPorCodigo(corretorCodigo),
  ]);
  const corretor = funcionarioLead?.nome_completo || '';
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const ok = req.query.ok === '1';
  const v = clienteFormValores(req.query);

  res.send(formShell({
    title: getPublicFormTitle(),
    subtitle: '',
    content: `
      ${erro ? `<div class="card form-error">${esc(erro)}</div>` : ''}
      ${ok ? `<div class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">${esc(getPublicFormSuccessMessage())}</div>` : ''}
      <section class="page-hero">
        <div class="card">
          <h2 class="page-title">${esc(getPublicFormTitle())}</h2>
          <p class="page-subtitle">${esc(getPublicFormSubtitle())}</p>
        </div>
        <aside class="card match-summary-card">
          <h3 style="margin:0 0 6px;">${esc(getPublicFormMatchTitle())}</h3>
          <p class="muted" id="form-matches-status">${esc(getPublicFormMatchHint())}</p>
          <div class="match-summary-list" id="form-matches-list" style="display:none;"></div>
        </aside>
      </section>
      <section class="card">
        <form method="post" action="/formulario" data-validate-numeric="true">
          <input type="hidden" name="corretor" value="${esc(corretorCodigo)}" />
          <div class="grid">
            <div><label>Nome</label><input name="nome" value="${esc(v.nome)}" required /></div>
            <div><label>Telefone</label><input name="telefone" value="${v.telefone ? esc(formatarTelefone(v.telefone)) : ""}" placeholder="(51) 98035-7562" inputmode="numeric" oninput="let v=this.value.replace(/\\D/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" required /></div>
            <div><label>${esc(getLeadBrokerLabel())}</label><input value="${esc(resolverNomeAtendimentoPublico(corretor))}" readonly /></div>
            <div><label>Tipo de imóvel desejado</label><select name="tipo_imovel_desejado" required><option value="">Selecione</option>${categoriasCliente.rows.map((c) => `<option value="${esc(c.nome_exibicao)}" ${v.tipo_imovel_desejado === c.nome_exibicao ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
            <div><label>Estado do imóvel desejado</label>${selectEstadoImovel('estado_imovel_desejado', v.estado_imovel_desejado)}</div>
            <div><label for="numero_quartos_desejado">N° de quartos</label><input id="numero_quartos_desejado" name="numero_quartos_desejado" type="text" data-numero="inteiro" value="${esc(v.numero_quartos_desejado)}" /></div>
            <div><label for="numero_banheiros_desejado">N° banheiro</label><input id="numero_banheiros_desejado" name="numero_banheiros_desejado" type="text" data-numero="inteiro" value="${esc(v.numero_banheiros_desejado)}" /></div>
            <div><label for="numero_vagas_garagem_desejada">Vaga garagem</label><input id="numero_vagas_garagem_desejada" name="numero_vagas_garagem_desejada" type="text" data-numero="inteiro" value="${esc(v.numero_vagas_garagem_desejada)}" /></div>
            <div><label for="numero_suites_desejada">N° suíte</label><input id="numero_suites_desejada" name="numero_suites_desejada" type="text" data-numero="inteiro" value="${esc(v.numero_suites_desejada)}" /></div>
            <div><label for="valor_minimo">Valor mínimo</label><input id="valor_minimo" name="valor_minimo" type="text" data-numero="decimal" value="${esc(v.valor_minimo)}" required /></div>
            <div><label for="valor_maximo">Valor máximo</label><input id="valor_maximo" name="valor_maximo" type="text" data-numero="decimal" value="${esc(v.valor_maximo)}" required /></div>
            <div><label>Cidade de interesse</label><input name="cidade" id="form-cidade" value="${esc(v.cidade)}" list="cidades-imoveis" autocomplete="off" required /></div>
            <div><label>Bairro de interesse</label><input name="bairro" id="form-bairro" value="${esc(v.bairro)}" list="bairros-imoveis" autocomplete="off" /></div>
            <div><label>Proposta</label>${selectTipoPagamento(v.tipo_pagamento)}</div>
            <div class="field-full"><label>Observações</label><textarea name="resumo_atendimento">${esc(v.resumo_atendimento)}</textarea></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Enviar formulário</button>
          </div>
        </form>
        <script>
          document.addEventListener('DOMContentLoaded', () => {
            const cidadeInput = document.getElementById('form-cidade');
            const bairroInput = document.getElementById('form-bairro');
            const matchesStatus = document.getElementById('form-matches-status');
            const matchesList = document.getElementById('form-matches-list');
            const form = document.querySelector('form[action="/formulario"]');
            const bairrosPorCidade = ${JSON.stringify(bairrosPorCidade)};
            const bairrosList = document.getElementById('bairros-imoveis');

            const escapeHtml = (value) => String(value || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');

            const renderBairros = () => {
              if (!cidadeInput || !bairroInput || !bairrosList) return;
              const cidade = String(cidadeInput.value || '').trim();
              const bairros = bairrosPorCidade[cidade] || [];
              bairrosList.innerHTML = bairros.map((bairro) => '<option value="' + escapeHtml(bairro) + '"></option>').join('');
            };

            const renderMatches = async () => {
              if (!form || !matchesStatus || !matchesList) return;
              const data = new URLSearchParams(new FormData(form));
              const cidade = String(data.get('cidade') || '').trim();
              const tipo = String(data.get('tipo_imovel_desejado') || '').trim();
              const min = String(data.get('valor_minimo') || '').trim();
              const max = String(data.get('valor_maximo') || '').trim();
              if (!cidade || !tipo || (!min && !max)) {
                matchesStatus.textContent = ${JSON.stringify(getPublicFormMatchHint())};
                matchesList.innerHTML = '';
                return;
              }

              try {
                matchesStatus.textContent = ${JSON.stringify(getPublicFormMatchLoadingText())};
                const resp = await fetch('/formulario/matches?' + data.toString());
                const json = await resp.json();
                matchesStatus.innerHTML = json.total
                  ? ${JSON.stringify(getPublicFormMatchFoundText('__TOTAL__'))}.replace('__TOTAL__', String(json.total))
                  : 'Procurando imóveis compatíveis com seu interesse';
                matchesList.innerHTML = '';
              } catch (error) {
                matchesStatus.textContent = 'Não foi possível carregar sugestões agora.';
                matchesList.innerHTML = '';
              }
            };

            if (cidadeInput && bairroInput) {
              cidadeInput.addEventListener('input', () => {
                renderBairros();
                renderMatches();
              });
              cidadeInput.addEventListener('change', () => {
                renderBairros();
                renderMatches();
              });
              bairroInput.addEventListener('input', renderMatches);
              bairroInput.addEventListener('change', renderMatches);
              renderBairros();
            }

            if (form) {
              form.querySelectorAll('input, select, textarea').forEach((el) => {
                if (el === cidadeInput || el === bairroInput) return;
                el.addEventListener('change', renderMatches);
                el.addEventListener('input', renderMatches);
              });
            }

            renderMatches();
          });
        </script>
        ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      </section>
    `,
  }));
});

app.get('/formulario/resultado/:clienteId', async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  if (!Number.isFinite(clienteId)) return res.redirect('/formulario');
  const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  const cliente = clienteResult.rows[0];
  if (!cliente) return res.redirect('/formulario');
  const matches = await buscarMatchesParaCliente(cliente, 12);

  const content = matches.length
    ? `
      <section class="card">
        <h2 class="page-title">${esc(getPublicFormResultTitle())}</h2>
        <p class="page-subtitle">Encontramos ${matches.length} opção(ões) com potencial para o seu perfil.</p>
      </section>
      <section class="card">
        <div class="results-grid">
          ${matches.map(({ imovel, score, motivos }) => `
            <article class="result-card">
              <h4>${esc(imovel.codigo)}${imovel.titulo ? ` · ${esc(imovel.titulo)}` : ''}</h4>
              <div class="filters-actions" style="margin-top:0;margin-bottom:12px;align-items:center;">
                <span class="match-badge ${score >= 75 ? 'match-alto' : score >= 60 ? 'match-medio' : 'match-baixo'}">${score}% compatível</span>
              </div>
              <div class="result-meta">
                <div><strong>Cidade</strong>${esc(imovel.cidade || '-')}</div>
                <div><strong>Bairro</strong>${esc(imovel.bairro || '-')}</div>
                <div><strong>Valor</strong>${money(imovel.valor)}</div>
                <div><strong>Tipo</strong>${esc(imovel.categoria_nome || imovel.categoria_slug || '-')}</div>
              </div>
              <div class="card" style="margin-top:16px;padding:14px;">
                <strong>Motivos da compatibilidade</strong>
                <p>${esc(motivos.join(', ') || 'Compatibilidade geral')}</p>
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    `
    : `
      <section class="card">
        <h2 class="page-title">${esc(getPublicFormReceivedTitle())}</h2>
        <p class="page-subtitle">${esc(getPublicFormNoMatchMessage())}</p>
      </section>
    `;

  res.send(formResultadoShell({
    title: 'Resultado do formulário',
    content,
  }));
});

app.post('/formulario', async (req, res) => {
  const b = clienteFormValores(req.body);
  const corretorCodigo = normalizarCodigoFuncionario(req.body.corretor);
  const campoNumericoInvalido = validarNumerosFormulario(b, ['numero_quartos_desejado', 'numero_banheiros_desejado', 'numero_vagas_garagem_desejada', 'numero_suites_desejada', 'valor_minimo', 'valor_maximo']);
  if (campoNumericoInvalido) {
    const qs = new URLSearchParams({ ...b, corretor: corretorCodigo, erro: `Preencha o campo ${campoNumericoInvalido} apenas com números.` }).toString();
    return res.redirect(`/formulario?${qs}`);
  }
  const camposObrigatorios = [
    ['nome', 'nome'],
    ['telefone', 'telefone'],
    ['cidade', 'cidade'],
    ['tipo_imovel_desejado', 'tipo de imóvel'],
    ['valor_minimo', 'valor mínimo'],
    ['valor_maximo', 'valor máximo'],
  ];
  const campoObrigatorioFaltando = camposObrigatorios.find(([key]) => !String(b[key] || '').trim());
  if (campoObrigatorioFaltando) {
    const qs = new URLSearchParams({ ...b, corretor: corretorCodigo, erro: `Preencha ${campoObrigatorioFaltando[1]} para enviar o formulário.` }).toString();
    return res.redirect(`/formulario?${qs}`);
  }

  try {
    const funcionarioLead = await buscarFuncionarioPorCodigo(corretorCodigo);
    const nomeCorretor = funcionarioLead?.nome_completo || '';
    const insertResult = await pool.query(`INSERT INTO clientes (telefone, nome, corretor, atendente, tipo_imovel_desejado, estado_imovel_desejado, numero_quartos_desejado, numero_banheiros_desejado, numero_vagas_garagem_desejada, numero_suites_desejada, valor_minimo, valor_maximo, cidade, bairro, tipo_pagamento, resumo_atendimento, interesse) VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::int,NULLIF($8,'')::int,NULLIF($9,'')::int,NULLIF($10,'')::int,NULLIF($11,'')::numeric,NULLIF($12,'')::numeric,$13,$14,$15,$16,$17) RETURNING id`, [
      normalizarTelefone(b.telefone),
      b.nome,
      nomeCorretor,
      getPublicFormAtendenteName(),
      b.tipo_imovel_desejado,
      b.estado_imovel_desejado,
      normalizarNumeroFormulario(b.numero_quartos_desejado),
      normalizarNumeroFormulario(b.numero_banheiros_desejado),
      normalizarNumeroFormulario(b.numero_vagas_garagem_desejada),
      normalizarNumeroFormulario(b.numero_suites_desejada),
      normalizarNumeroFormulario(b.valor_minimo, { decimal: true }),
      normalizarNumeroFormulario(b.valor_maximo, { decimal: true }),
      b.cidade,
      b.bairro,
      b.tipo_pagamento || null,
      b.resumo_atendimento,
      getPublicFormLeadNote(),
    ]);
    res.redirect(`/formulario/resultado/${insertResult.rows[0].id}`);
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe cadastro com este telefone.' : error.message;
    const qs = new URLSearchParams({ ...b, corretor: corretorCodigo, erro: mensagem }).toString();
    res.redirect(`/formulario?${qs}`);
  }
});

app.get('/painel', async (req, res) => {
  const [imoveis, clientes, categorias, cidades, oportunidades] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM imoveis'),
    pool.query('SELECT count(*)::int AS total FROM clientes'),
    pool.query('SELECT count(*)::int AS total FROM categorias_imovel WHERE ativa IS TRUE'),
    pool.query("SELECT count(DISTINCT cidade)::int AS total FROM imoveis WHERE cidade IS NOT NULL AND cidade <> ''"),
    carregarOportunidades(100),
  ]);

  const oportunidadesHome = oportunidades.slice(0, 3);
  const restanteMatches = Math.max(oportunidades.length - oportunidadesHome.length, 0);

  const cardsOportunidade = oportunidadesHome.length
    ? oportunidadesHome.map(({ imovel, cliente, score, motivos }) => {
      const classeScore = score >= 75 ? 'match-alto' : score >= 60 ? 'match-medio' : 'match-baixo';
      const labelScore = score >= 75 ? 'Match alto' : score >= 60 ? 'Match médio' : 'Match baixo';
      return `
      <article class="result-card">
        <h4>${esc(imovel.codigo)} → ${esc(cliente.nome || cliente.telefone || 'Cliente')}</h4>
        <div class="filters-actions" style="margin-top:0;margin-bottom:12px;align-items:center;">
          <span class="match-badge ${classeScore}">${labelScore} · ${score}%</span>
        </div>
        <div class="result-meta">
          <div><strong>Imóvel</strong>${esc(imovel.titulo || imovel.codigo)}</div>
          <div><strong>Cliente</strong>${esc(cliente.nome || cliente.telefone || '-')}</div>
          <div><strong>Cidade</strong>${esc(imovel.cidade || '-')}</div>
          <div><strong>Bairro</strong>${esc(imovel.bairro || '-')}</div>
        </div>
        <div class="card" style="margin-top:16px;padding:14px;">
          <strong>Motivos do match</strong>
          <p>${esc(motivos.join(', ') || 'Compatibilidade geral')}</p>
        </div>
        <div class="result-actions">
          <a class="btn-link" href="/painel/imoveis?codigo=${encodeURIComponent(imovel.codigo)}">Ver imóvel</a>
          <a class="btn-link" href="/painel/clientes?telefone=${encodeURIComponent(cliente.telefone || '')}">Ver cliente</a>
        </div>
      </article>
    `;
    }).join('')
    : `<div class="empty">${esc(getOpportunityEmptyMessage())}</div>`;

  res.send(shell({
    title: 'Página inicial',
    active: 'inicio',
    content: `
      <section class="stats stats-home">
        <div class="stat-card"><span class="muted">Imóveis cadastrados</span><strong>${imoveis.rows[0].total}</strong></div>
        <div class="stat-card"><span class="muted">Clientes cadastrados</span><strong>${clientes.rows[0].total}</strong></div>
        <div class="stat-card"><span class="muted">Categorias de imóveis</span><strong>${categorias.rows[0].total}</strong></div>
        <div class="stat-card"><span class="muted">Cidades cadastradas</span><strong>${cidades.rows[0].total}</strong></div>
      </section>
      <section class="card">
        <div class="filters-actions" style="justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">Alertas de possíveis interessados</h3>
          <a href="/painel/oportunidades" class="btn-link">Ver todas as oportunidades</a>
        </div>
        <div class="results-grid" style="margin-top:16px;">
          ${cardsOportunidade}
        </div>
        ${restanteMatches > 0 ? `<div style="margin-top:16px;"><a href="/painel/oportunidades" class="btn-link">Ver mais ${restanteMatches} match</a></div>` : ''}
      </section>
    `,
  }));
});

app.get('/painel/backup-restaurar', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha)) return res.status(403).send('Senha inválida');
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const ok = req.query.ok ? decodeURIComponent(req.query.ok) : '';
  const backupImoveisRoot = path.join(__dirname, '..', 'backup_imoveis');
  const backupClientesRoot = path.join(__dirname, '..', 'backup_cleber_clientes');
  const backupFuncionariosRoot = path.join(__dirname, '..', 'backup_funcionarios');
  const backupImoveisFiles = fs.existsSync(backupImoveisRoot)
    ? fs.readdirSync(backupImoveisRoot, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.tar.gz')).map((d) => d.name).sort().reverse()
    : [];
  const backupClientesFiles = fs.existsSync(backupClientesRoot)
    ? fs.readdirSync(backupClientesRoot, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.tar.gz')).map((d) => d.name).sort().reverse()
    : [];
  const backupFuncionariosFiles = fs.existsSync(backupFuncionariosRoot)
    ? fs.readdirSync(backupFuncionariosRoot, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.tar.gz')).map((d) => d.name).sort().reverse()
    : [];
  res.send(shell({
    title: 'Backup/Restaurar',
    subtitle: 'Gerencia backups separados de imóveis e clientes.',
    active: 'backup-restaurar',
    content: `
      ${renderFormError(erro)}
      ${ok ? `<div class="card">${esc(ok)}</div>` : ''}
      <section class="card" style="padding:24px; border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:18px;">
          <div>
            <h3 style="margin:0 0 6px; font-size:22px;">Backup de imóveis</h3>
            <p class="muted" style="margin:0; max-width:680px;">Crie um pacote completo de imóveis ou restaure um backup já existente.</p>
          </div>
          <span class="match-badge match-medio">Imóveis</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; align-items:stretch;">
          <div style="min-width:0; border:1px solid #e2e8f0; border-radius:18px; padding:20px; box-sizing:border-box; background:#f8fafc; display:flex; flex-direction:column; gap:16px; min-height:100%;">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; font-size:18px;">Restaurar Backup</h4>
                <span class="match-badge match-medio">Destrutivo</span>
              </div>
              <p class="muted" style="margin:0; line-height:1.5;">Substitui dados e storage de imóveis pelo conteúdo do backup enviado.</p>
            </div>
            <form method="post" action="/painel/backup-restaurar/restore-imoveis-upload" enctype="multipart/form-data" onsubmit="return confirmarSenhaAcaoBackup(event, 'restaurar o backup de imóveis', 'Isso vai substituir os dados e a storage de imóveis pelo conteúdo do backup enviado. Deseja continuar?')" style="display:flex; flex-direction:column; gap:14px; align-items:stretch;">
              <input type="hidden" name="senha" value="" />
              <div>
                <label>Escolher arquivo</label>
                <input type="file" name="backupFile" accept=".tar.gz" required />
              </div>
              <button type="submit" style="align-self:flex-start;">Restaurar Backup</button>
            </form>
          </div>
          <div style="min-width:0; border:1px solid #cbd5e1; border-radius:18px; padding:20px; box-sizing:border-box; background:linear-gradient(180deg,#fff 0%,#f8fafc 100%); display:flex; flex-direction:column; gap:16px; min-height:100%; box-shadow:0 8px 22px rgba(15,23,42,.04);">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; font-size:18px;">Criar Backup</h4>
                <span class="match-badge" style="background:#dcfce7;color:#166534;">Download</span>
              </div>
              <p class="muted" style="margin:0 0 14px; line-height:1.5;">Gera um backup dos imóveis com banco e storage para baixar no computador.</p>
              <div style="padding:14px; border:1px solid #e5e7eb; border-radius:14px; background:#fff; margin-bottom:14px;">
                <strong style="display:block; margin-bottom:10px; font-size:13px; color:#475569; text-transform:uppercase; letter-spacing:.04em;">Backups disponíveis</strong>
                ${backupImoveisFiles.length ? `<ul style="margin:0; padding-left:18px; display:grid; gap:8px;">${backupImoveisFiles.map((item) => `<li><a href="/painel/backup-restaurar/download-imoveis/${encodeURIComponent(item)}">${esc(item)}</a></li>`).join('')}</ul>` : '<p class="muted" style="margin:0;">Nenhum backup de imóveis compactado gerado ainda.</p>'}
              </div>
            </div>
            <form method="post" action="/painel/backup-restaurar/backup-imoveis" onsubmit="return confirmarSenhaAcaoBackup(event, 'criar o backup de imóveis')" style="margin:0; display:flex; flex-direction:column; gap:14px; align-items:flex-start;">
              <input type="hidden" name="senha" value="" />
              <button type="submit">Criar Backup</button>
            </form>
          </div>
        </div>
      </section>
      <section class="card" style="padding:24px; border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:18px;">
          <div>
            <h3 style="margin:0 0 6px; font-size:22px;">Backup de clientes</h3>
            <p class="muted" style="margin:0; max-width:680px;">Crie um backup da tabela de clientes ou restaure uma base enviada.</p>
          </div>
          <span class="match-badge match-medio">Clientes</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; align-items:stretch;">
          <div style="min-width:0; border:1px solid #e2e8f0; border-radius:18px; padding:20px; box-sizing:border-box; background:#f8fafc; display:flex; flex-direction:column; gap:16px; min-height:100%;">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; font-size:18px;">Restaurar backup</h4>
                <span class="match-badge match-medio">Destrutivo</span>
              </div>
              <p class="muted" style="margin:0; line-height:1.5;">Substitui somente os clientes atuais pelos dados do backup enviado.</p>
            </div>
            <form method="post" action="/painel/backup-restaurar/restore-clientes-upload" enctype="multipart/form-data" onsubmit="return confirmarSenhaAcaoBackup(event, 'restaurar o backup de clientes', 'Isso vai substituir somente os clientes pelo conteúdo do backup enviado. Deseja continuar?')" style="display:flex; flex-direction:column; gap:14px; align-items:stretch;">
              <input type="hidden" name="senha" value="" />
              <div>
                <label>Escolher arquivo</label>
                <input type="file" name="backupFile" accept=".tar.gz" required />
              </div>
              <button type="submit" style="align-self:flex-start;">Restaurar backup</button>
            </form>
          </div>
          <div style="min-width:0; border:1px solid #cbd5e1; border-radius:18px; padding:20px; box-sizing:border-box; background:linear-gradient(180deg,#fff 0%,#f8fafc 100%); display:flex; flex-direction:column; gap:16px; min-height:100%; box-shadow:0 8px 22px rgba(15,23,42,.04);">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; font-size:18px;">Backup Clientes</h4>
                <span class="match-badge" style="background:#dcfce7;color:#166534;">Download</span>
              </div>
              <p class="muted" style="margin:0 0 14px; line-height:1.5;">Gera um backup somente da tabela de clientes para baixar e guardar.</p>
              <div style="padding:14px; border:1px solid #e5e7eb; border-radius:14px; background:#fff; margin-bottom:14px;">
                <strong style="display:block; margin-bottom:10px; font-size:13px; color:#475569; text-transform:uppercase; letter-spacing:.04em;">Backups disponíveis</strong>
                ${backupClientesFiles.length ? `<ul style="margin:0; padding-left:18px; display:grid; gap:8px;">${backupClientesFiles.map((item) => `<li><a href="/painel/backup-restaurar/download-clientes/${encodeURIComponent(item)}">${esc(item)}</a></li>`).join('')}</ul>` : '<p class="muted" style="margin:0;">Nenhum backup de clientes compactado gerado ainda.</p>'}
              </div>
            </div>
            <form method="post" action="/painel/backup-restaurar/backup-clientes" onsubmit="return confirmarSenhaAcaoBackup(event, 'criar o backup de clientes')" style="margin:0; display:flex; flex-direction:column; gap:14px; align-items:flex-start;">
              <input type="hidden" name="senha" value="" />
              <button type="submit">Backup Clientes</button>
            </form>
          </div>
        </div>
      </section>
      <section class="card" style="padding:24px; border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:18px;">
          <div>
            <h3 style="margin:0 0 6px; font-size:22px;">Backup de funcionários</h3>
            <p class="muted" style="margin:0; max-width:680px;">Crie um backup das tabelas de funcionários e cargos ou restaure uma base enviada.</p>
          </div>
          <span class="match-badge match-medio">Funcionários</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; align-items:stretch;">
          <div style="min-width:0; border:1px solid #e2e8f0; border-radius:18px; padding:20px; box-sizing:border-box; background:#f8fafc; display:flex; flex-direction:column; gap:16px; min-height:100%;">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; font-size:18px;">Restaurar backup</h4>
                <span class="match-badge match-medio">Destrutivo</span>
              </div>
              <p class="muted" style="margin:0; line-height:1.5;">Substitui cargos e funcionários atuais pelos dados do backup enviado.</p>
            </div>
            <form method="post" action="/painel/backup-restaurar/restore-funcionarios-upload" enctype="multipart/form-data" onsubmit="return confirmarSenhaAcaoBackup(event, 'restaurar o backup de funcionários', 'Isso vai substituir cargos e funcionários pelo conteúdo do backup enviado. Deseja continuar?')" style="display:flex; flex-direction:column; gap:14px; align-items:stretch;">
              <input type="hidden" name="senha" value="" />
              <div>
                <label>Escolher arquivo</label>
                <input type="file" name="backupFile" accept=".tar.gz" required />
              </div>
              <button type="submit" style="align-self:flex-start;">Restaurar backup</button>
            </form>
          </div>
          <div style="min-width:0; border:1px solid #cbd5e1; border-radius:18px; padding:20px; box-sizing:border-box; background:linear-gradient(180deg,#fff 0%,#f8fafc 100%); display:flex; flex-direction:column; gap:16px; min-height:100%; box-shadow:0 8px 22px rgba(15,23,42,.04);">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; font-size:18px;">Backup Funcionários</h4>
                <span class="match-badge" style="background:#dcfce7;color:#166534;">Download</span>
              </div>
              <p class="muted" style="margin:0 0 14px; line-height:1.5;">Gera um backup das tabelas de funcionários e cargos para baixar e guardar.</p>
              <div style="padding:14px; border:1px solid #e5e7eb; border-radius:14px; background:#fff; margin-bottom:14px;">
                <strong style="display:block; margin-bottom:10px; font-size:13px; color:#475569; text-transform:uppercase; letter-spacing:.04em;">Backups disponíveis</strong>
                ${backupFuncionariosFiles.length ? `<ul style="margin:0; padding-left:18px; display:grid; gap:8px;">${backupFuncionariosFiles.map((item) => `<li><a href="/painel/backup-restaurar/download-funcionarios/${encodeURIComponent(item)}">${esc(item)}</a></li>`).join('')}</ul>` : '<p class="muted" style="margin:0;">Nenhum backup de funcionários compactado gerado ainda.</p>'}
              </div>
            </div>
            <form method="post" action="/painel/backup-restaurar/backup-funcionarios" onsubmit="return confirmarSenhaAcaoBackup(event, 'criar o backup de funcionários')" style="margin:0; display:flex; flex-direction:column; gap:14px; align-items:flex-start;">
              <input type="hidden" name="senha" value="" />
              <button type="submit">Backup Funcionários</button>
            </form>
          </div>
        </div>
      <script>
        function confirmarSenhaAcaoBackup(event, acao, mensagemConfirmacao = '') {
          const senha = window.prompt('Digite a senha para ' + acao + ':');
          if (!senha) return false;
          if (mensagemConfirmacao) {
            const confirmar = window.confirm(mensagemConfirmacao);
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
      </script>
    `,
  }));
});

app.post('/painel/backup-restaurar/backup-imoveis', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  execFile(path.join(__dirname, '..', 'scripts', 'backup-imoveis.sh'), [], { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
    if (error) {
      return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent(stderr || error.message)}`);
    }
    const lines = String(stdout || '').trim().split('\n').filter(Boolean);
    const output = lines.length ? lines[lines.length - 1] : 'Backup de imóveis criado com sucesso.';
    return res.redirect(`/painel/backup-restaurar?${senhaQuery}&ok=${encodeURIComponent(output)}`);
  });
});

app.get('/painel/backup-restaurar/download-imoveis/:file', auth, async (req, res) => {
  const file = path.basename(req.params.file || '');
  const fullPath = path.join(__dirname, '..', 'backup_imoveis', file);
  if (!fs.existsSync(fullPath)) return res.status(404).send('Arquivo não encontrado');
  return res.download(fullPath);
});

app.post('/painel/backup-restaurar/backup-clientes', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  execFile(path.join(__dirname, '..', 'scripts', 'backup-clientes.sh'), [], { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
    if (error) {
      return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent(stderr || error.message)}`);
    }
    const lines = String(stdout || '').trim().split('\n').filter(Boolean);
    const output = lines.length ? lines[lines.length - 1] : 'Backup de clientes criado com sucesso.';
    return res.redirect(`/painel/backup-restaurar?${senhaQuery}&ok=${encodeURIComponent(output)}`);
  });
});

app.get('/painel/backup-restaurar/download-clientes/:file', auth, async (req, res) => {
  const file = path.basename(req.params.file || '');
  const fullPath = path.join(__dirname, '..', 'backup_cleber_clientes', file);
  if (!fs.existsSync(fullPath)) return res.status(404).send('Arquivo não encontrado');
  return res.download(fullPath);
});

app.post('/painel/backup-restaurar/backup-funcionarios', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  execFile(path.join(__dirname, '..', 'scripts', 'backup-funcionarios.sh'), [], { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
    if (error) {
      return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent(stderr || error.message)}`);
    }
    const lines = String(stdout || '').trim().split('\n').filter(Boolean);
    const output = lines.length ? lines[lines.length - 1] : 'Backup de funcionários criado com sucesso.';
    return res.redirect(`/painel/backup-restaurar?${senhaQuery}&ok=${encodeURIComponent(output)}`);
  });
});

app.get('/painel/backup-restaurar/download-funcionarios/:file', auth, async (req, res) => {
  const file = path.basename(req.params.file || '');
  const fullPath = path.join(__dirname, '..', 'backup_funcionarios', file);
  if (!fs.existsSync(fullPath)) return res.status(404).send('Arquivo não encontrado');
  return res.download(fullPath);
});

app.post('/painel/backup-restaurar/restore-imoveis-upload', auth, upload.single('backupFile'), async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  if (!req.file) return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent('Envie um arquivo de backup de imóveis.')}`);
  execFile(path.join(__dirname, '..', 'scripts', 'restore-imoveis.sh'), [req.file.path], { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
    try { if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true }); } catch {}
    if (error) {
      return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent(stderr || error.message)}`);
    }
    const lines = String(stdout || '').trim().split('\n').filter(Boolean);
    const output = lines.length ? lines[lines.length - 1] : 'Restore de imóveis concluído com sucesso.';
    return res.redirect(`/painel/backup-restaurar?${senhaQuery}&ok=${encodeURIComponent(output)}`);
  });
});

app.post('/painel/backup-restaurar/restore-clientes-upload', auth, upload.single('backupFile'), async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  if (!req.file) return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent('Envie um arquivo de backup de clientes.')}`);
  execFile(path.join(__dirname, '..', 'scripts', 'restore-clientes.sh'), [req.file.path], { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
    try { if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true }); } catch {}
    if (error) {
      return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent(stderr || error.message)}`);
    }
    const lines = String(stdout || '').trim().split('\n').filter(Boolean);
    const output = lines.length ? lines[lines.length - 1] : 'Restore de clientes concluído com sucesso.';
    return res.redirect(`/painel/backup-restaurar?${senhaQuery}&ok=${encodeURIComponent(output)}`);
  });
});

app.post('/painel/backup-restaurar/restore-funcionarios-upload', auth, upload.single('backupFile'), async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  if (!req.file) return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent('Envie um arquivo de backup de funcionários.')}`);
  execFile(path.join(__dirname, '..', 'scripts', 'restore-funcionarios.sh'), [req.file.path], { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
    try { if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true }); } catch {}
    if (error) {
      return res.redirect(`/painel/backup-restaurar?${senhaQuery}&erro=${encodeURIComponent(stderr || error.message)}`);
    }
    const lines = String(stdout || '').trim().split('\n').filter(Boolean);
    const output = lines.length ? lines[lines.length - 1] : 'Restore de funcionários concluído com sucesso.';
    return res.redirect(`/painel/backup-restaurar?${senhaQuery}&ok=${encodeURIComponent(output)}`);
  });
});

app.get('/painel/manutencao', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha)) return res.status(403).send('Senha inválida');
  const status = await montarStatusManutencaoSistema();
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const ok = req.query.ok ? decodeURIComponent(req.query.ok) : '';
  const filtroStatus = String(req.query.filtroStatus || '').trim();
  const filtroAcao = String(req.query.filtroAcao || '').trim();
  const historicoFiltrado = status.maintenanceHistory.filter((run) => {
    const statusOk = filtroStatus === 'sucesso' ? run.ok === true : filtroStatus === 'falha' ? run.ok === false : true;
    const actionOk = filtroAcao ? run.action === filtroAcao : true;
    return statusOk && actionOk;
  });
  const buildFiltroLink = (nextStatus, nextAcao) => {
    const params = new URLSearchParams();
    if (nextStatus) params.set('filtroStatus', nextStatus);
    if (nextAcao) params.set('filtroAcao', nextAcao);
    return `/painel/manutencao${params.toString() ? `?${params.toString()}` : ''}`;
  };
  const situacaoComercial = validarSituacaoComercial();
  const arquivos = status.generatedFiles.map((item) => `
    <div class="maintenance-item">
      <strong>${esc(item.path)}</strong>
      <span class="match-badge ${item.ok ? 'match-alto' : 'match-baixo'}">${item.ok ? 'presente' : 'faltando'}</span>
    </div>
  `).join('');
  res.send(shell({
    title: 'Manutenção do sistema',
    subtitle: 'Status simples da instalação assistida, arquivos gerados e base da atualização.',
    active: 'manutencao',
    content: `
      ${erro ? `<section class="card form-error">${esc(erro)}</section>` : ''}
      ${ok ? `<section class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">${esc(ok)}</section>` : ''}
      ${!situacaoComercial.ok ? `<section class="card form-error">${esc(situacaoComercial.message)}</section>` : ''}
      <section class="stats">
        <div class="stat-card"><span class="muted">Versão do sistema</span><strong>${esc(status.version)}</strong></div>
      </section>
      <section class="card">
        <h3 style="margin-top:0;">Identidade da instalação</h3>
        <div class="maintenance-list">
        </div>
      </section>
      <section class="grid-2">
        <article class="card">
          <h3 style="margin-top:0;">Última atualização registrada</h3>
          <div class="maintenance-list">
            <div class="maintenance-item"><strong>Registro da última atualização</strong><span class="match-badge ${status.updateManifestOk ? 'match-alto' : 'match-baixo'}">${status.updateManifestOk ? 'disponível' : 'ainda não criado'}</span></div>
            <div class="maintenance-item"><strong>Data da última atualização</strong><span>${esc(status.lastUpdateAt ? formatarDataHoraHumana(status.lastUpdateAt) : 'Ainda não registrada')}</span></div>
            <div class="maintenance-item"><strong>Itens acompanhados pelo sistema</strong><span>${status.trackedFilesTotal}</span></div>
          </div>
        </article>
        <article class="card">
          <h3 style="margin-top:0;">Resumo das mudanças recentes</h3>
          <div class="maintenance-list">
            ${status.changeGroups.map((item) => `<div class="maintenance-item"><strong>${esc(item.label)}</strong><span class="match-badge ${item.ok ? 'match-medio' : 'match-baixo'}">${item.ok ? 'teve alteração' : 'sem alteração recente'}</span></div>`).join('')}
          </div>
          <div style="margin-top:14px;">
            <strong>Arquivos alterados encontrados</strong>
            ${status.detectedChanges.length ? `<div class="maintenance-list" style="margin-top:10px;">${status.detectedChanges.map((item) => `<div class="maintenance-item"><strong>${esc(item)}</strong><span class="match-badge match-alto">alterado</span></div>`).join('')}</div>` : `<p class="muted" style="margin:8px 0 0;">Nenhuma alteração importante foi encontrada na última atualização registrada.</p>`}
          </div>
        </article>
      </section>
      <section class="grid-2">
        <article class="card">
          <h3 style="margin-top:0;">Saúde do sistema</h3>
          <div class="maintenance-list">
            <div class="maintenance-item"><strong>Aplicação web</strong><span class="match-badge ${status.appOk ? 'match-alto' : 'match-baixo'}">${status.appOk ? 'online' : 'offline'}</span></div>
            <div class="maintenance-item"><strong>Banco de dados</strong><span class="match-badge ${status.dbOk ? 'match-alto' : 'match-baixo'}">${status.dbOk ? 'ok' : 'falhou'}</span></div>
            ${status.dbError ? `<div class="maintenance-item"><strong>Detalhe do banco</strong><span>${esc(status.dbError)}</span></div>` : ''}
          </div>
        </article>
      </section>
      <section class="grid-2">
        <article class="card">
          <h3 style="margin-top:0;">Base da instalação</h3>
          <div class="maintenance-list">
            <div class="maintenance-item"><strong>.env configurado</strong><span class="match-badge ${status.envOk ? 'match-alto' : 'match-baixo'}">${status.envOk ? 'ok' : 'pendente'}</span></div>
            <div class="maintenance-item"><strong>package-lock.json</strong><span class="match-badge ${status.packageLockOk ? 'match-alto' : 'match-baixo'}">${status.packageLockOk ? 'ok' : 'faltando'}</span></div>
            <div class="maintenance-item"><strong>Manifesto da atualização</strong><span class="match-badge ${status.updateManifestOk ? 'match-alto' : 'match-baixo'}">${status.updateManifestOk ? 'ok' : 'ainda não gerado'}</span></div>
            <div class="maintenance-item"><strong>Pasta deploy</strong><span class="match-badge ${status.deployDirOk ? 'match-alto' : 'match-baixo'}">${status.deployDirOk ? 'ok' : 'faltando'}</span></div>
          </div>
        </article>
        <article class="card">
          <h3 style="margin-top:0;">Status operacional</h3>
          <div class="maintenance-list">
            <div class="maintenance-item"><strong>Serviço principal instalado</strong><span class="match-badge ${status.servicePublished ? 'match-alto' : 'match-baixo'}">${status.servicePublished ? 'pronto' : 'não encontrado'}</span></div>
            <div class="maintenance-item"><strong>Endereços principais preenchidos</strong><span class="match-badge ${status.domainsReady ? 'match-alto' : 'match-baixo'}">${status.domainsReady ? 'ok' : 'pendente'}</span></div>
          </div>
        </article>
      </section>
      <section class="card">
        <h3 style="margin-top:0;">Domínios configurados</h3>
        <div class="maintenance-list">
          <div class="maintenance-item"><strong>Painel</strong><span>${esc(status.panelDomain || 'Não definido')}</span></div>
          <div class="maintenance-item"><strong>Formulário</strong><span>${esc(status.formDomain || 'Não definido')}</span></div>
          <div class="maintenance-item"><strong>Galeria</strong><span>${esc(status.galleryDomain || 'Não definido')}</span></div>
          <div class="maintenance-item"><strong>Imagens</strong><span>${esc(status.imagesDomain || 'Não definido')}</span></div>
        </div>
      </section>
      <section class="card">
        <h3 style="margin-top:0;">Arquivos preparados automaticamente</h3>
        <div class="maintenance-list">${arquivos}</div>
      </section>
      <section class="card">
        <h3 style="margin-top:0;">Ações de manutenção</h3>
        ${status.maintenanceActionRunning ? `
          <div class="card form-error" style="margin-bottom:14px;">
            <strong>Uma ação já está em andamento.</strong><br />
            ${esc(maintenanceActionLabel(status.maintenanceActionInfo?.action))}
            ${status.maintenanceActionInfo?.at ? `<br /><span class="muted">Iniciada em ${esc(formatarDataHoraHumana(status.maintenanceActionInfo.at))}</span>` : ''}
            <div class="maintenance-refresh-note" data-auto-refresh-status>Atualizando automaticamente em 15s</div>
            ${status.maintenanceActionInfo?.progressLabel ? `<div class="maintenance-live-status">${esc(status.maintenanceActionInfo.progressLabel)}</div>` : ''}
            <div class="maintenance-progress-bar"><span style="width:${Number(status.maintenanceActionInfo?.progressPercent || 10)}%"></span></div>
            <div class="maintenance-progress-text">${Number(status.maintenanceActionInfo?.progressPercent || 10)}% concluído</div>
            <div class="maintenance-step-list" style="margin-top:12px;">
              ${maintenanceStepStatus(status.maintenanceActionInfo?.action, status.maintenanceActionInfo?.progressPercent).map((item, index) => `<div class="maintenance-step ${item.state}"><span class="maintenance-step-number">${index + 1}</span><div><strong>${esc(item.step)}</strong><small class="muted">${item.state === 'done' ? 'Concluído' : item.state === 'active' ? 'Em andamento agora' : 'Próxima etapa'}</small></div></div>`).join('')}
            </div>
          </div>
        ` : ''}
        <div class="maintenance-actions-grid">
          <form method="post" action="/painel/manutencao/revalidar-health" class="maintenance-action-card">
            <h4>Revalidar saúde do sistema</h4>
            <p class="muted">Faz uma checagem rápida para confirmar se o sistema e o banco estão respondendo normalmente.</p>
            ${renderMaintenancePasswordField()}
            <button type="submit" ${status.maintenanceActionRunning ? 'disabled' : ''}>Revalidar agora</button>
          </form>
          <form method="post" action="/painel/manutencao/regenerar-artefatos" class="maintenance-action-card">
            <h4>Regenerar arquivos do setup</h4>
            <p class="muted">Refaz automaticamente os arquivos de apoio com base na configuração atual do sistema.</p>
            ${renderMaintenancePasswordField()}
            <button type="submit" class="btn-secondary" ${status.maintenanceActionRunning ? 'disabled' : ''}>Regenerar arquivos</button>
          </form>
          <form method="post" action="/painel/manutencao/rodar-update" class="maintenance-action-card" onsubmit="return confirm('Deseja rodar o update assistido agora?');">
            <h4>Rodar update assistido</h4>
            <p class="muted">Executa a atualização guiada do sistema e registra um resumo do que foi feito.</p>
            ${renderMaintenancePasswordField()}
            <button type="submit" class="btn-secondary" ${status.maintenanceActionRunning ? 'disabled' : ''}>Executar update</button>
          </form>
        </div>
<p class="muted" style="margin:12px 0 0;">Estas ações pedem a senha do painel e funcionam uma por vez, para evitar erros e deixar a manutenção mais segura.</p>
      </section>
      <section class="card">
        <div class="filters-actions" style="justify-content:space-between;align-items:center;">
          <div>
            <h3 style="margin-top:0;">Histórico de execuções de manutenção</h3>
            <p class="muted" style="margin:6px 0 0;">Resumo enxuto das execuções recentes. O detalhamento completo foi movido para uma página própria.</p>
          </div>
          <a class="btn-link" href="/painel/manutencao/historico">Abrir histórico completo</a>
        </div>
        <div class="stats" style="margin-top:16px;">
          <div class="stat-card"><span class="muted">Total de execuções</span><strong>${status.historySummary.total}</strong></div>
          <div class="stat-card"><span class="muted">Sucessos</span><strong>${status.historySummary.success}</strong></div>
          <div class="stat-card"><span class="muted">Falhas</span><strong>${status.historySummary.failure}</strong></div>
        </div>
      </section>
      ${scriptAutoRefreshManutencao(status.maintenanceActionRunning)}
    `,
  }));
});

app.post('/painel/manutencao/revalidar-health', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Senha do painel inválida.'));
  if (maintenanceActionRunning()) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Já existe outra ação de manutenção em execução.'));
  try {
    startMaintenanceAction('revalidar-health');
    updateMaintenanceActionProgress('Verificando se a aplicação está pronta para responder.', 30);
    updateMaintenanceActionProgress('Verificando a conexão com o banco de dados e a resposta do sistema.', 70);
    await pool.query('select 1');
    updateMaintenanceActionProgress('Finalizando a checagem e registrando o resultado.', 100);
    salvarResumoManutencao({ action: 'revalidar-health', ok: true, at: new Date().toISOString(), summary: 'Aplicação e banco responderam normalmente.', progressPercent: 100 });
    return res.redirect('/painel/manutencao?ok=' + encodeURIComponent('Checagem concluída com sucesso. O sistema e o banco responderam normalmente.'));
  } catch (error) {
    salvarResumoManutencao({ action: 'revalidar-health', ok: false, at: new Date().toISOString(), summary: resumirSaidaComando(error.message), progressPercent: Number(maintenanceActionInfo()?.progressPercent || 10) });
    return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Não foi possível concluir a checagem do sistema: ' + error.message));
  } finally {
    finishMaintenanceAction();
  }
});

app.post('/painel/manutencao/regenerar-artefatos', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Senha do painel inválida.'));
  const situacaoComercial = validarSituacaoComercial();
  if (!situacaoComercial.ok) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent(situacaoComercial.message));
  if (maintenanceActionRunning()) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Já existe outra ação de manutenção em execução.'));
  try {
    startMaintenanceAction('regenerar-artefatos');
    updateMaintenanceActionProgress('Lendo a configuração atual para recriar os arquivos de apoio.', 20);
    const env = configuracoesSistemaValores();
    if (!env.panelDomain || !env.formDomain || !env.galleryDomain || !env.imagesDomain) {
      return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Antes de recriar os arquivos de apoio, preencha os endereços principais em Configurações.'));
    }
    const wizardPath = path.join(__dirname, '..', 'scripts', 'install-wizard.sh');
    const command = `printf 'n\\nn\\n${String(env.panelDomain).replace(/'/g, `'\\''`)}\\nsetup@local.invalid\\n' | '${wizardPath.replace(/'/g, `'\\''`)}'`;
    updateMaintenanceActionProgress('Gerando novamente os arquivos automáticos do sistema.', 65);
    const result = await runExecFile('bash', ['-lc', command], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
    });
    updateMaintenanceActionProgress('Finalizando a atualização dos arquivos e salvando o resultado.', 100);
    salvarResumoManutencao({ action: 'regenerar-artefatos', ok: true, at: new Date().toISOString(), summary: resumirSaidaComando(`${result.stdout}\n${result.stderr}`), progressPercent: 100 });
    return res.redirect('/painel/manutencao?ok=' + encodeURIComponent('Os arquivos de apoio foram recriados com sucesso.'));
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    salvarResumoManutencao({ action: 'regenerar-artefatos', ok: false, at: new Date().toISOString(), summary: resumirSaidaComando(detail), progressPercent: Number(maintenanceActionInfo()?.progressPercent || 10) });
    return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Não foi possível recriar os arquivos de apoio: ' + detail.slice(0, 300)));
  } finally {
    finishMaintenanceAction();
  }
});


app.post('/painel/manutencao/rodar-update', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Senha do painel inválida.'));
  const situacaoComercial = validarSituacaoComercial();
  if (!situacaoComercial.ok) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent(situacaoComercial.message));
  if (maintenanceActionRunning()) return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Já existe outra ação de manutenção em execução.'));
  try {
    startMaintenanceAction('rodar-update');
    updateMaintenanceActionProgress('Preparando backup e atualização guiada do sistema.', 15);
    const scriptPath = path.join(__dirname, '..', 'scripts', 'update-assisted.sh');
    updateMaintenanceActionProgress('Aplicando dependências, banco e demais ajustes da atualização.', 55);
    const result = await runExecFile('bash', ['-lc', `'${scriptPath.replace(/'/g, `'\\''`)}'`], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, RESTART_SERVICE: 'never', SKIP_CHECK: '1', MAINTENANCE_PROGRESS_FILE: maintenanceProgressFilePath() },
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 8,
    });
    updateMaintenanceActionProgress('Finalizando a atualização guiada e registrando o resultado.', 100);
    salvarResumoManutencao({ action: 'rodar-update', ok: true, at: new Date().toISOString(), summary: resumirSaidaComando(`${result.stdout}\n${result.stderr}`), progressPercent: 100 });
    return res.redirect('/painel/manutencao?ok=' + encodeURIComponent('A atualização guiada foi concluída com sucesso.'));
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    salvarResumoManutencao({ action: 'rodar-update', ok: false, at: new Date().toISOString(), summary: resumirSaidaComando(detail), progressPercent: Number(maintenanceActionInfo()?.progressPercent || 10) });
    clearMaintenanceLockSafe();
    return res.redirect('/painel/manutencao?erro=' + encodeURIComponent('Não foi possível concluir a atualização guiada: ' + detail.slice(0, 300)));
  } finally {
    finishMaintenanceAction();
  }
});



app.get('/painel/manutencao/historico', auth, async (req, res) => {
  const filtroStatus = String(req.query.filtroStatus || '').trim();
  const filtroAcao = String(req.query.filtroAcao || '').trim();
  const historico = maintenanceHistoryItems(200).filter((run) => {
    const statusOk = filtroStatus === 'sucesso' ? run.ok === true : filtroStatus === 'falha' ? run.ok === false : true;
    const actionOk = filtroAcao ? run.action === filtroAcao : true;
    return statusOk && actionOk;
  });
  const buildFiltroLink = (nextStatus, nextAcao) => {
    const params = new URLSearchParams();
    if (nextStatus) params.set('filtroStatus', nextStatus);
    if (nextAcao) params.set('filtroAcao', nextAcao);
    return `/painel/manutencao/historico${params.toString() ? `?${params.toString()}` : ''}`;
  };
  res.send(shell({
    title: 'Histórico de manutenção',
    active: 'manutencao',
    content: `
      ${erro ? renderFormError(erro) : ''}
      ${ok ? `<div class="card" style="border:2px solid #16a34a;background:#f0fdf4;color:#166534;font-weight:700;">${esc(ok)}</div>` : ''}
      <section class="card">
        <div class="filters-actions" style="justify-content:space-between;align-items:center;">
          <div>
            <h3 style="margin:0;">Histórico completo de manutenção</h3>
            <p class="muted" style="margin:6px 0 0;">Aqui ficam os detalhes das execuções para análise sem ocupar a tela principal.</p>
          </div>
          <a class="btn-link" href="/painel/manutencao">Voltar para manutenção</a>
        </div>
        <div class="filters-actions" style="margin-top:16px;flex-wrap:wrap;gap:8px;">
          <a class="maintenance-filter-pill ${!filtroStatus ? 'active' : ''}" href="${buildFiltroLink('', filtroAcao)}">Todos os status</a>
          <a class="maintenance-filter-pill ${filtroStatus === 'sucesso' ? 'active' : ''}" href="${buildFiltroLink('sucesso', filtroAcao)}">Só sucessos</a>
          <a class="maintenance-filter-pill ${filtroStatus === 'falha' ? 'active' : ''}" href="${buildFiltroLink('falha', filtroAcao)}">Só falhas</a>
          <a class="maintenance-filter-pill ${!filtroAcao ? 'active' : ''}" href="${buildFiltroLink(filtroStatus, '')}">Todas as ações</a>
          <a class="maintenance-filter-pill ${filtroAcao === 'revalidar-health' ? 'active' : ''}" href="${buildFiltroLink(filtroStatus, 'revalidar-health')}">Revalidar saúde</a>
          <a class="maintenance-filter-pill ${filtroAcao === 'regenerar-artefatos' ? 'active' : ''}" href="${buildFiltroLink(filtroStatus, 'regenerar-artefatos')}">Regenerar setup</a>
          <a class="maintenance-filter-pill ${filtroAcao === 'rodar-update' ? 'active' : ''}" href="${buildFiltroLink(filtroStatus, 'rodar-update')}">Rodar update</a>
        </div>
      </section>
      <section class="results-grid" style="margin-top:16px;">
        ${historico.length ? historico.map((run) => `
          <article class="result-card">
            <div class="filters-actions" style="justify-content:space-between;align-items:center;">
              <span class="match-badge ${run.ok ? 'match-alto' : 'match-baixo'}">${run.ok ? 'sucesso' : 'falha'}</span>
              <span class="muted">${esc(formatarDataHoraHumana(run.at))}</span>
            </div>
            <h4 style="margin-top:12px;">${esc(maintenanceActionLabel(run.action))}</h4>
            <div class="maintenance-step-list" style="margin-top:12px;">
              ${maintenanceStepStatus(run.action, Number(run.progressPercent || 0)).map((item, index) => `<div class="maintenance-step ${item.state}"><span class="maintenance-step-number">${index + 1}</span><div><strong>${esc(item.step)}</strong><small class="muted">${item.state === 'done' ? 'Concluído' : item.state === 'active' ? 'Em andamento' : 'Pendente'}</small></div></div>`).join('')}
            </div>
            <div class="card" style="margin-top:14px;padding:14px;">
              <strong>Resumo</strong>
              <p>${esc(run.summary || 'Sem detalhes registrados.')}</p>
            </div>
          </article>
        `).join('') : '<div class="empty">Nenhum registro encontrado.</div>'}
      </section>
    `,
  }));
});



app.get('/painel/configuracoes', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha)) return res.status(403).send('Senha inválida');
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const ok = req.query.ok === '1';
  const v = { ...configuracoesSistemaValores(), ...req.query };
  const temLogo = Boolean(logoTag());
  const status = montarStatusConfiguracaoSistema();
  const etapas = [
    {
      titulo: 'Etapa 1, identidade',
      descricao: 'Defina nome, logo e apresentação principal do sistema.',
      ok: Boolean(v.appName && v.panelTitle && temLogo),
      itens: ['Nome do sistema', 'Título do painel', 'Logo da empresa'],
      recomendacao: 'Preencha nome, título do painel e envie a logo da empresa.',
    },
    {
      titulo: 'Etapa 2, acesso',
      descricao: 'Configure como o usuário entra no painel.',
      ok: Boolean(v.panelAdminUser && process.env.PANEL_ADMIN_PASSWORD && pareceEmailValido(v.panelRecoveryEmail)),
      itens: ["Usuário do painel", "Senha do painel", "E-mail de recuperação"],
      recomendacao: "Defina o usuário, confirme a senha e informe um e-mail válido para recuperação do painel.",
    },
    {
      titulo: 'Etapa 3, domínios',
      descricao: 'Defina os endereços principais da operação online.',
      ok: Boolean(v.panelDomain && v.formDomain && v.galleryDomain && v.imagesDomain),
      itens: ['Domínio do painel', 'Domínio do formulário', 'Domínio da galeria', 'Domínio das imagens'],
      recomendacao: 'Informe os domínios principais para painel, formulário, galeria e imagens.',
    },
    {
      titulo: 'Etapa 4, revisão visual',
      descricao: 'Revise textos públicos e cores principais.',
      ok: Boolean(v.publicFormTitle && v.publicGalleryTitle && v.themeHeaderBg && v.themeHeaderText),
      itens: ['Textos públicos principais', 'Cores principais'],
      recomendacao: 'Revise os textos públicos e ajuste as cores principais da marca.',
    },
  ];
  const proximaEtapa = etapas.find((item) => !item.ok) || null;
  const etapasHtml = etapas.map((etapa) => `
    <div class="result-card">
      <div class="filters-actions" style="margin-top:0;justify-content:space-between;align-items:center;">
        <div>
          <strong style="display:block;margin:0;">${esc(etapa.titulo)}</strong>
          <p class="muted" style="margin:6px 0 0;">${esc(etapa.descricao)}</p>
        </div>
        <span class="match-badge ${etapa.ok ? 'match-alto' : (status.percentual >= 100 ? 'match-alto' : (proximaEtapa && proximaEtapa.titulo === etapa.titulo ? 'match-medio' : 'match-baixo'))}">${etapa.ok ? 'Concluída' : (status.percentual >= 100 ? 'Concluída' : (proximaEtapa && proximaEtapa.titulo === etapa.titulo ? 'Próxima' : 'Pendente'))}</span>
      </div>
      <div class="card" style="margin-top:14px;padding:14px;">
        <strong>Itens desta etapa</strong>
        <ul class="list">${etapa.itens.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      </div>
    </div>
  `).join('');
  const cardsStatus = status.checks.map((item) => `
    <div class="result-card">
      <div class="filters-actions" style="margin-top:0;justify-content:space-between;align-items:center;">
        <strong style="margin:0;">${esc(item.label)}</strong>
        <span class="match-badge ${item.ok ? 'match-alto' : 'match-baixo'}">${item.ok ? 'OK' : 'Pendente'}</span>
      </div>
      <p class="muted" style="margin:10px 0 0;">${esc(item.ok ? 'Configuração concluída.' : item.hint)}</p>
    </div>
  `).join('');
  const pendenciasHtml = status.pendencias.length
    ? `<div class="card form-error"><strong style="display:block;margin-bottom:8px;">Pendências prioritárias</strong><ul class="list">${status.pendencias.slice(0, 4).map((item) => `<li>${esc(item.label)}: ${esc(item.hint)}</li>`).join('')}</ul></div>`
    : '<div class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">Todas as etapas principais da configuração foram concluídas.</div>';

  res.send(shell({
    title: 'Configurações do sistema',
    subtitle: 'Ajuste nome, textos principais, identidade visual, acesso e domínios sem editar arquivos manualmente.',
    active: 'configuracoes',
    content: `
      ${renderFormError(erro)}
      ${ok ? '<div class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">Configurações salvas com sucesso.</div>' : ''}
      ${(status.percentual < 100 && proximaEtapa) ? `<section class="card" style="border:1px solid #fde68a;background:#fffbeb;"><div class="filters-actions" style="justify-content:space-between;align-items:center;"><div><h3 style="margin:0;">Próximo passo recomendado</h3><p class="muted" style="margin:6px 0 0;">${esc(proximaEtapa.titulo)}</p></div><span class="match-badge match-medio">Continuar</span></div><p style="margin:12px 0 0;">${esc(proximaEtapa.recomendacao)}</p></section>` : '<section class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;font-weight:700;">Setup principal concluído. Agora você pode revisar detalhes finos do sistema.</section>'}
      ${pendenciasHtml}
      <section class="card">
        <div class="filters-actions" style="justify-content:space-between;align-items:center;">
          <div>
            <h3 style="margin:0;">Etapas da configuração</h3>
            <p class="muted" style="margin:6px 0 0;">${status.concluidos} de ${status.total} itens concluídos (${status.percentual}%).</p>
          </div>
          <span class="match-badge ${status.percentual >= 100 ? 'match-alto' : status.percentual >= 60 ? 'match-medio' : 'match-baixo'}">${status.percentual}%</span>
        </div>
        <div class="results-grid" style="margin-top:16px;">
          ${etapasHtml}
        </div>
      </section>
      <section class="card">
        <h3 style="margin-top:0;">Checklist detalhado</h3>
        <div class="results-grid" style="margin-top:16px;">
          ${cardsStatus}
        </div>
      </section>
      <section class="card">
        <form method="post" action="/painel/configuracoes" enctype="multipart/form-data">
          <input type="hidden" name="senha" value="${esc(req.query.senha || '')}" />
          <div class="search-blocks">
            <div class="search-block">
              <h3>Identidade</h3>
              <div class="grid-2">
                <div><label>Nome do sistema</label><input name="appName" value="${esc(v.appName)}" placeholder="Ex.: Cléber Corretor" required /><small class="muted">Nome principal exibido no sistema.</small></div>
                <div><label>Título do painel</label><input name="panelTitle" value="${esc(v.panelTitle)}" placeholder="Ex.: Painel Cléber Corretor" required /><small class="muted">Título que aparece no topo do painel.</small></div>
                <div><label>Subtítulo do PDF</label><input name="panelSubtitlePdf" value="${esc(v.panelSubtitlePdf)}" placeholder="Ex.: CRECI: 080879" /></div>
                <div><label>Nome padrão do atendimento público</label><input name="leadFallbackName" value="${esc(v.leadFallbackName)}" placeholder="Ex.: Atendimento" /></div>
                <div><label>Logo da empresa</label><input type="file" name="logo" accept="image/png,image/jpeg,image/webp" /><small class="muted">Formatos aceitos: PNG, JPG, JPEG ou WEBP.</small></div>
                <div><label>Status da logo</label><input value="${temLogo ? 'Logo configurada' : 'Sem logo cadastrada'}" readonly /></div>
              </div>
            </div>
            <div class="search-block">
              <h3>Textos públicos principais</h3>
              <div class="grid-2">
                <div><label>Título do formulário</label><input name="publicFormTitle" value="${esc(v.publicFormTitle)}" /></div>
                <div><label>Título da galeria pública</label><input name="publicGalleryTitle" value="${esc(v.publicGalleryTitle)}" /></div>
                <div class="field-full"><label>Subtítulo do formulário</label><textarea name="publicFormSubtitle">${esc(v.publicFormSubtitle)}</textarea></div>
              </div>
            </div>
            <div class="search-block">
              <h3>Cores principais</h3>
              <div class="grid-2">
                <div><label>Fundo do cabeçalho</label><input name="themeHeaderBg" value="${esc(v.themeHeaderBg)}" placeholder="#111827" /></div>
                <div><label>Texto geral do cabeçalho</label><input name="themeHeaderText" value="${esc(v.themeHeaderText)}" placeholder="#ffffff" /></div>
                <div><label>Nome da empresa</label><input name="themeBrandHighlight" value="${esc(v.themeBrandHighlight)}" placeholder="#f4c542" /></div>
                <div><label>Nome da pagina atual</label><input name="themeBrandSubtext" value="${esc(v.themeBrandSubtext)}" placeholder="#d1d5db" /></div>
                <div><label>Texto do menu</label><input name="themeMenuText" value="${esc(v.themeMenuText)}" placeholder="#ffffff" /></div>
                <div><label>Título da página</label><input name="themePageTitle" value="${esc(v.themePageTitle)}" placeholder="#111827" /></div>
                <div><label>Subtítulo da página</label><input name="themePageSubtitle" value="${esc(v.themePageSubtitle)}" placeholder="#6b7280" /></div>
                <div><label>Fundo do menu ativo</label><input name="themeMenuActiveBg" value="${esc(v.themeMenuActiveBg)}" placeholder="#d4af37" /></div>
                <div><label>Texto do menu ativo</label><input name="themeMenuActiveText" value="${esc(v.themeMenuActiveText)}" placeholder="#111827" /></div>
              </div>
            </div>
            <div class="search-block">
              <h3>Acesso do painel</h3>
              <div class="grid-2">
                <div><label>Usuário do painel</label><input name="panelAdminUser" value="${esc(v.panelAdminUser)}" placeholder="Ex.: admin" required /><small class="muted">Usuário usado para entrar no painel.</small></div>
                <div><label>Nova senha do painel</label><input type="password" name="panelAdminPassword" value="" placeholder="Preencha só se quiser trocar" /><small class="muted">Deixe em branco para manter a senha atual.</small></div>
                <div class="field-full"><label>E-mail de recuperação</label><input type="email" name="panelRecoveryEmail" value="${esc(v.panelRecoveryEmail)}" placeholder="recuperacao@seudominio.com" required /><small class="muted">Importante: informe um e-mail válido. Ele será usado para recuperação de usuário e senha.</small></div>
              </div>
            </div>
            <div class="search-block">
              <h3>Domínios principais</h3>
              <div class="grid-2">
                <div><label>Domínio do painel</label><input name="panelDomain" value="${esc(v.panelDomain)}" placeholder="painel.seudominio.com" /><small class="muted">Ex.: cadastro.seudominio.com</small></div>
                <div><label>Domínio do formulário</label><input name="formDomain" value="${esc(v.formDomain)}" placeholder="form.seudominio.com" /><small class="muted">Onde o cliente vai preencher o formulário.</small></div>
                <div><label>Domínio da galeria</label><input name="galleryDomain" value="${esc(v.galleryDomain)}" placeholder="galeria.seudominio.com" /><small class="muted">Usado para compartilhar galerias públicas.</small></div>
                <div><label>Domínio das imagens</label><input name="imagesDomain" value="${esc(v.imagesDomain)}" placeholder="imagens.seudominio.com" /><small class="muted">Base pública dos arquivos de imagem.</small></div>
              </div>
            </div>
          </div>
          <div class="filters-actions">
            <a class="btn-link" href="/painel">Cancelar</a>
            <button type="submit" id="btn-salvar-config" disabled>Salvar configurações</button>
          </div>
        </form>
        <script>
          (() => {
            const form = document.querySelector('form[action="/painel/configuracoes"]');
            const btn = document.getElementById('btn-salvar-config');
            if (!form || !btn) return;
            const initial = new FormData(form);
            const snapshot = new URLSearchParams();
            for (const [key, value] of initial.entries()) snapshot.append(key, value instanceof File ? value.name : String(value ?? ''));
            const currentState = () => {
              const fd = new FormData(form);
              const params = new URLSearchParams();
              for (const [key, value] of fd.entries()) params.append(key, value instanceof File ? value.name : String(value ?? ''));
              return params.toString();
            };
            const toggle = () => { btn.disabled = currentState() === snapshot.toString(); };
            form.addEventListener('input', toggle);
            form.addEventListener('change', toggle);
            toggle();
          })();
        </script>
      </section>
    `,
  }));
});

app.post('/painel/configuracoes', auth, upload.single('logo'), async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.redirect('/painel/configuracoes?erro=' + encodeURIComponent('Senha do painel inválida.'));
  const senhaQuery = `senha=${encodeURIComponent(req.body.senha || '')}`;
  const b = configuracoesSistemaValores(req.body);
  if (!String(b.appName || '').trim()) {
    return res.redirect(`/painel/configuracoes?${senhaQuery}&erro=${encodeURIComponent('Informe o nome do sistema.')}`);
  }
  if (!String(b.panelTitle || '').trim()) {
    return res.redirect(`/painel/configuracoes?${senhaQuery}&erro=${encodeURIComponent('Informe o título do painel.')}`);
  }
  if (!String(b.panelAdminUser || '').trim()) {
    return res.redirect(`/painel/configuracoes?${senhaQuery}&erro=${encodeURIComponent('Informe o usuário do painel.')}`);
  }
  if (!pareceEmailValido(b.panelRecoveryEmail)) {
    return res.redirect(`/painel/configuracoes?${senhaQuery}&erro=${encodeURIComponent("Informe um e-mail de recuperação válido.")}`);
  }
  const dominios = [
    ['Domínio do painel', b.panelDomain],
    ['Domínio do formulário', b.formDomain],
    ['Domínio da galeria', b.galleryDomain],
    ['Domínio das imagens', b.imagesDomain],
  ];
  for (const [label, value] of dominios) {
    const text = String(value || '').trim();
    if (text && !pareceDominio(text)) {
      return res.redirect(`/painel/configuracoes?${senhaQuery}&erro=${encodeURIComponent(`${label} inválido. Use um domínio como exemplo.com ou sub.exemplo.com`)}`);
    }
  }
  if (String(b.panelAdminPassword || '').trim() && String(b.panelAdminPassword).trim().length < 6) {
    return res.redirect(`/painel/configuracoes?${senhaQuery}&erro=${encodeURIComponent('A nova senha do painel deve ter pelo menos 6 caracteres.')}`);
  }
  const values = {
    APP_NAME: b.appName,
    PANEL_TITLE: b.panelTitle,
    PANEL_SUBTITLE_PDF: b.panelSubtitlePdf,
    PUBLIC_FORM_TITLE: b.publicFormTitle,
    PUBLIC_FORM_SUBTITLE: b.publicFormSubtitle,
    PUBLIC_GALLERY_HOME_TITLE: b.publicGalleryTitle,
    PUBLIC_LEAD_FALLBACK_NAME: b.leadFallbackName,
    THEME_HEADER_BG: b.themeHeaderBg,
    THEME_HEADER_TEXT: b.themeHeaderText,
    THEME_BRAND_HIGHLIGHT: b.themeBrandHighlight,
    THEME_BRAND_SUBTEXT: b.themeBrandSubtext,
    THEME_MENU_TEXT: b.themeMenuText,
    THEME_PAGE_TITLE: b.themePageTitle,
    THEME_PAGE_SUBTITLE: b.themePageSubtitle,
    THEME_MENU_ACTIVE_BG: b.themeMenuActiveBg,
    THEME_MENU_ACTIVE_TEXT: b.themeMenuActiveText,
    PANEL_ADMIN_USER: b.panelAdminUser,
    PANEL_RECOVERY_EMAIL: b.panelRecoveryEmail,
    PANEL_DOMAIN: b.panelDomain,
    FORM_DOMAIN: b.formDomain,
    GALLERY_DOMAIN: b.galleryDomain,
    IMAGES_DOMAIN: b.imagesDomain,
  };
  if (String(b.panelAdminPassword || '').trim()) values.PANEL_ADMIN_PASSWORD = b.panelAdminPassword;
  atualizarEnvValores(values);

  if (req.file) {
    const publicDir = path.join(__dirname, 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    for (const file of ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp']) {
      const full = path.join(publicDir, file);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.png';
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const finalExt = allowed.has(ext) ? ext : '.png';
    fs.renameSync(req.file.path, path.join(publicDir, `logo${finalExt}`));
  }

  return res.redirect(`/painel/configuracoes?${senhaQuery}&ok=1`);
});

app.get('/painel/oportunidades', auth, async (req, res) => {
  const previewCliente = montarClientePreviewMatch(req.query);
  const temPreview = Boolean(previewCliente.cidade && previewCliente.tipo_imovel_desejado && (previewCliente.valor_minimo || previewCliente.valor_maximo));
  const oportunidades = temPreview
    ? (await buscarMatchesParaCliente(previewCliente, 100)).map((match) => ({ imovel: match.imovel, cliente: previewCliente, score: match.score, motivos: match.motivos }))
    : await carregarOportunidades(100);
  const rows = oportunidades.length
    ? oportunidades.map(({ imovel, cliente, score, motivos }) => {
      const classeScore = score >= 75 ? 'match-alto' : score >= 60 ? 'match-medio' : 'match-baixo';
      const labelScore = score >= 75 ? 'Match alto' : score >= 60 ? 'Match médio' : 'Match baixo';
      return `
      <article class="result-card">
        <h4>${esc(imovel.codigo)} ↔ ${esc(cliente.nome || cliente.telefone || 'Cliente')}</h4>
        <div class="filters-actions" style="margin-top:0;margin-bottom:12px;align-items:center;">
          <span class="match-badge ${classeScore}">${labelScore} · ${score}%</span>
        </div>
        <div class="result-meta">
          <div><strong>Imóvel</strong>${esc(imovel.titulo || imovel.codigo)}</div>
          <div><strong>Cliente</strong>${esc(cliente.nome || cliente.telefone || '-')}</div>
          <div><strong>Valor imóvel</strong>${money(imovel.valor)}</div>
          <div><strong>Cidade</strong>${esc(imovel.cidade || '-')}</div>
          <div><strong>Bairro</strong>${esc(imovel.bairro || '-')}</div>
          <div><strong>Telefone cliente</strong>${esc(cliente.telefone || '-')}</div>
        </div>
        <div class="card" style="margin-top:16px;padding:14px;">
          <strong>Motivos do match</strong>
          <p>${esc(motivos.join(', ') || 'Compatibilidade geral')}</p>
        </div>
        <div class="result-actions">
          <a class="btn-link" href="/painel/imoveis?codigo=${encodeURIComponent(imovel.codigo)}">Ver imóvel</a>
          <a class="btn-link" href="/painel/clientes?telefone=${encodeURIComponent(cliente.telefone || '')}">Ver cliente</a>
        </div>
      </article>
    `;
    }).join('')
    : '<div class="empty">Nenhuma oportunidade encontrada no momento.</div>';

  res.send(shell({
    title: 'Oportunidades',
    subtitle: temPreview ? 'Pré-visualização de imóveis compatíveis com os dados preenchidos no cadastro do cliente.' : 'Cruzamento entre imóveis e clientes com score de compatibilidade.',
    active: 'oportunidades',
    content: `
      ${temPreview ? `<section class="card" style="border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;font-weight:700;">Pré-visualização baseada nos dados atuais do cliente. Esse cliente ainda não precisa estar salvo para ver os imóveis compatíveis.</section>` : ''}
      <section class="card">
        <div class="results-grid">
          ${rows}
        </div>
      </section>
    `,
  }));
});

function normalizarSlugCategoria(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function categoriaFormValores(source = {}) {
  return {
    slug: source.slug || '',
    nome_exibicao: source.nome_exibicao || '',
    sigla_codigo: source.sigla_codigo || '',
    pasta_slug: source.pasta_slug || '',
    ativa: source.ativa === false || source.ativa === 'false' || source.ativa === '0' ? '' : '1',
  };
}

function prepararCategoriaPayload(source = {}) {
  const nome = String(source.nome_exibicao || '').trim();
  const sigla = String(source.sigla_codigo || '').trim().toUpperCase();
  const slug = normalizarSlugCategoria(nome);
  return {
    nome_exibicao: nome,
    sigla_codigo: sigla,
    slug,
    pasta_slug: slug,
    ativa: source.ativa === false || source.ativa === 'false' || source.ativa === '0' ? false : true,
  };
}

function validarSiglaCodigo(value) {
  return /^[A-Z0-9]+$/.test(String(value || '').trim().toUpperCase());
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function jsonResponseDownload(res, filename, contentType, body) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(body);
}

function formatarDataPtBr(value) {
  if (!value) return '-';
  if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim())) return value.trim();
  const data = new Date(value);
  if (Number.isNaN(data.getTime())) return String(value);
  return data.toLocaleDateString('pt-BR');
}

function normalizarTelefone(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatarTelefone(value) {
  const digits = normalizarTelefone(value);
  if (!digits) return '-';
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

function formatarNumero(value) {
  if (value == null || value === '') return '-';
  const numero = Number(value);
  if (Number.isNaN(numero)) return String(value);
  return new Intl.NumberFormat('pt-BR').format(numero);
}

function montarLinkGaleriaImovel(codigo) {
  const baseUrl = getGalleryBaseUrl();
  if (!baseUrl) return `/imovel/${encodeURIComponent(String(codigo || '').trim())}/galeria`;
  return `${baseUrl}/imovel/${encodeURIComponent(String(codigo || '').trim())}/galeria`;
}

function montarUrlImagemPublica(pastaSlug, codigo, nomeArquivo) {
  return `/files/${encodeURIComponent(String(pastaSlug || '').trim())}/${encodeURIComponent(String(codigo || '').trim())}/${encodeURIComponent(String(nomeArquivo || '').trim())}`;
}

function normalizarImagemPublica(urlPublica, pastaSlug, codigo, nomeArquivo) {
  const fallback = montarUrlImagemPublica(pastaSlug, codigo, nomeArquivo);
  if (!urlPublica) return fallback;
  const texto = String(urlPublica).trim();
  if (!texto) return fallback;
  try {
    const parsed = new URL(texto, 'http://localhost');
    if (parsed.pathname) return parsed.pathname;
  } catch {}
  return texto.startsWith('/') ? texto : fallback;
}

function boolTexto(value) {
  if (value === true) return 'Sim';
  if (value === false) return 'Não';
  return '-';
}

function listaDiferenciais(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function pdfCss() {
  const theme = getPdfTheme();
  return `
    <style>
      *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;margin:0;padding:24px;background:#fff}h1,h2,h3,p{margin:0}p{line-height:1.5}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;background:${esc(theme.headerBg)};color:${esc(theme.headerText)};border-radius:18px;padding:20px 22px;margin-bottom:24px}.brand{display:flex;gap:16px;align-items:center}.brand img{width:72px;height:72px;object-fit:contain;background:transparent;border:none;border-radius:0;padding:0}.brand h1{color:${esc(theme.brandHighlight)}}.brand small{display:block;color:${esc(theme.brandHighlight)};margin-top:6px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:${esc(theme.badgeBg)};color:${esc(theme.badgeText)};font-size:12px;font-weight:700}.hero{background:#f9fafb;border:1px solid #e5e7eb;border-radius:16px;padding:20px;margin-bottom:20px}.hero-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.hero-item{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px}.hero-item strong{display:block;font-size:12px;color:#6b7280;margin-bottom:6px}.section{margin-top:20px}.section h2{font-size:20px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px}.card strong{display:block;font-size:12px;color:#6b7280;margin-bottom:6px}.images{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.image-card{border:1px solid #e5e7eb;border-radius:14px;padding:10px}.image-card img{width:100%;height:220px;object-fit:cover;border-radius:10px;border:1px solid #e5e7eb}.image-card span{display:block;margin-top:8px;font-size:12px;color:#6b7280}.list{margin:0;padding-left:18px}.list li{margin-bottom:6px}.footer{margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px}.muted{color:#6b7280}.two-col{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}@page{margin:20mm}
    </style>
  `;
}

function logoPdfTag() {
  const base = path.join(__dirname, 'public');
  for (const file of ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp']) {
    const full = path.join(base, file);
    if (fs.existsSync(full)) {
      const ext = path.extname(file).replace('.', '').toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      const content = fs.readFileSync(full).toString('base64');
      return `<img src="data:image/${mime};base64,${content}" alt="Logo" />`;
    }
  }
  return '';
}

async function carregarImovelCompleto(id) {
  const imovel = await pool.query(`
    SELECT i.*, c.nome_exibicao AS categoria_nome, d.endereco_completo, d.uf, d.cep, d.matricula_imovel, d.registro_cartorio, d.possui_escritura, d.possui_averbacao
    FROM imoveis i
    LEFT JOIN categorias_imovel c ON c.slug = i.categoria_slug
    LEFT JOIN documental_imovel d ON d.imovel_id = i.id
    WHERE i.id = $1
  `, [id]);
  if (!imovel.rows.length) throw new Error('Imóvel não encontrado');
  const fotos = await pool.query('SELECT nome_arquivo, url_publica, caminho_local, ordem FROM imovel_fotos WHERE imovel_id = $1 ORDER BY ordem', [id]);
  return { item: imovel.rows[0], fotos: fotos.rows };
}

function imageMimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase().replace('.', '');
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  if (ext === 'gif') return 'gif';
  return 'jpeg';
}

function pdfImageSrc(foto) {
  const candidates = [foto?.caminho_local, foto?.url_publica].filter(Boolean);
  for (const candidate of candidates) {
    const texto = String(candidate).trim();
    if (!texto) continue;
    if (texto.startsWith('data:image/')) return texto;
    if (fs.existsSync(texto)) {
      const content = fs.readFileSync(texto).toString('base64');
      return `data:image/${imageMimeFromName(texto)};base64,${content}`;
    }
    if (texto.startsWith('/files/')) {
      const localFromPublic = path.join(mediaRoot, texto.replace(/^\/files\//, ''));
      if (fs.existsSync(localFromPublic)) {
        const content = fs.readFileSync(localFromPublic).toString('base64');
        return `data:image/${imageMimeFromName(localFromPublic)};base64,${content}`;
      }
    }
    if (texto.startsWith('http://') || texto.startsWith('https://')) return texto;
  }
  return '';
}

function renderPdfImovel({ item, fotos, tipo }) {
  const company = process.env.PANEL_TITLE || getAppDisplayName();
  const diferenciais = listaDiferenciais(item.diferenciais);
  const linkGaleria = item.galeria_imagem || montarLinkGaleriaImovel(item.codigo);
  const blocoGaleria = `
    <div class="card">
      <p>As imagens deste imóvel estão disponíveis na galeria pública abaixo.</p>
      <p style="margin-top:10px;"><strong>Link da galeria pública:</strong><br /><a href="${esc(linkGaleria)}">${esc(linkGaleria)}</a></p>
      ${fotos.length ? `<p class="muted" style="margin-top:10px;">Total de imagens cadastradas: ${fotos.length}</p>` : '<p class="muted" style="margin-top:10px;">Nenhuma imagem cadastrada.</p>'}
    </div>
  `;

  const detalhesComerciais = `
    <section class="section">
      <h2>Resumo do imóvel</h2>
      <div class="grid">
        <div class="card"><strong>Categoria</strong>${esc(item.categoria_nome || item.categoria_slug || '-')}</div>
        <div class="card"><strong>Código</strong>${esc(item.codigo || '-')}</div>
        <div class="card"><strong>Cidade</strong>${esc(item.cidade || '-')}</div>
        <div class="card"><strong>Bairro</strong>${esc(item.bairro || '-')}</div>
        <div class="card"><strong>Área total</strong>${formatarNumero(item.area_total_m2)} m²</div>
        <div class="card"><strong>Área construída</strong>${formatarNumero(item.area_construida_m2)} m²</div>
        <div class="card"><strong>Dormitórios</strong>${formatarNumero(item.numero_dormitorios)}</div>
        <div class="card"><strong>Banheiros</strong>${formatarNumero(item.numero_banheiros)}</div>
        <div class="card"><strong>Vagas</strong>${formatarNumero(item.numero_vagas_garagem)}</div>
        <div class="card"><strong>Estado do imóvel</strong>${esc(item.estado_imovel || '-')}</div>
      </div>
    </section>
    <section class="section">
      <h2>Descrição</h2>
      <div class="card"><p>${esc(item.descricao || 'Sem descrição cadastrada.')}</p></div>
    </section>
  `;

  const detalhesCompletos = `
    ${detalhesComerciais}
    <section class="section">
      <h2>Detalhes completos</h2>
      <div class="two-col">
        <div>
          <div class="card"><strong>Endereço completo</strong>${esc(item.endereco_completo || '-')}</div>
          <div class="card"><strong>UF</strong>${esc(item.uf || '-')}</div>
          <div class="card"><strong>CEP</strong>${formatarNumero(item.cep)}</div>
          <div class="card"><strong>Matrícula</strong>${formatarNumero(item.matricula_imovel)}</div>
          <div class="card"><strong>Posição solar</strong>${esc(item.posicao_solar || '-')}</div>
          <div class="card"><strong>Andar</strong>${formatarNumero(item.andar)}</div>
          <div class="card"><strong>Possui elevador</strong>${boolTexto(item.possui_elevador)}</div>
          <div class="card"><strong>Valor condomínio</strong>${money(item.valor_condominio)}</div>
        </div>
        <div>
          <div class="card"><strong>Registro cartório</strong>${boolTexto(item.registro_cartorio)}</div>
          <div class="card"><strong>Possui escritura</strong>${boolTexto(item.possui_escritura)}</div>
          <div class="card"><strong>Possui averbação</strong>${boolTexto(item.possui_averbacao)}</div>
          <div class="card"><strong>Aceita financiamento</strong>${boolTexto(item.aceita_financiamento)}</div>
          <div class="card"><strong>Aceita permuta</strong>${boolTexto(item.aceita_permuta)}</div>
          <div class="card"><strong>Frente</strong>${formatarNumero(item.dimensao_frente_m)} m</div>
          <div class="card"><strong>Fundos</strong>${formatarNumero(item.dimensao_fundos_m)} m</div>
          <div class="card"><strong>Suítes</strong>${formatarNumero(item.numero_suites)}</div>
        </div>
      </div>
    </section>
  `;

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8" /><title>${esc(item.codigo)} - PDF</title>${pdfCss()}</head><body>
    <div class="top">
      <div class="brand">
        ${logoPdfTag()}
        <div>
          <h1>${esc(company)}</h1>
          <small>${esc(process.env.PANEL_SUBTITLE_PDF || '')}</small>
          <small>${tipo === 'completo' ? 'Ficha completa do imóvel' : 'Ficha comercial do imóvel'}</small>
        </div>
      </div>
      <span class="badge">${tipo === 'completo' ? 'PDF completo' : 'PDF comercial'}</span>
    </div>
    <section class="hero">
      <h2>${esc(item.titulo || item.codigo)}</h2>
      <p class="muted">${esc(item.cidade || '-')} / ${esc(item.bairro || '-')}</p>
      <div class="hero-grid">
        <div class="hero-item"><strong>Código</strong>${esc(item.codigo || '-')}</div>
        <div class="hero-item"><strong>Valor</strong>${money(item.valor)}</div>
        <div class="hero-item"><strong>Status</strong>${esc(item.status_publicacao || '-')}</div>
        <div class="hero-item"><strong>Cadastro</strong>${formatarDataPtBr(item.created_at)}</div>
      </div>
    </section>
    ${tipo === 'completo' ? detalhesCompletos : detalhesComerciais}
    <section class="section">
      <h2>Diferenciais</h2>
      <div class="card">${diferenciais.length ? `<ul class="list">${diferenciais.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="muted">Nenhum diferencial informado.</p>'}</div>
    </section>
    <section class="section">
      <h2>Galeria pública de imagens</h2>
      ${blocoGaleria}
    </section>
    <div class="footer">Documento gerado em ${new Date().toLocaleString('pt-BR')} pelo painel ${esc(company)}.</div>
  </body></html>`;
}

async function gerarPdfHtml(html) {
  if (!fs.existsSync('/usr/bin/wkhtmltopdf') && !fs.existsSync('/bin/wkhtmltopdf')) {
    throw new Error('wkhtmltopdf não encontrado no servidor. Instale o pacote wkhtmltopdf para habilitar os PDFs.');
  }
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'corretorcenter-pdf-'));
  const htmlPath = path.join(tmpDir, 'documento.html');
  const pdfPath = path.join(tmpDir, 'documento.pdf');
  fs.writeFileSync(htmlPath, html, 'utf8');
  try {
    await execFileAsync('wkhtmltopdf', [
      '--enable-local-file-access',
      '--print-media-type',
      '--margin-top', '10mm',
      '--margin-right', '10mm',
      '--margin-bottom', '10mm',
      '--margin-left', '10mm',
      htmlPath,
      pdfPath,
    ]);
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function gerarPdfImovel(id, tipo) {
  const dados = await carregarImovelCompleto(id);
  const html = renderPdfImovel({ ...dados, tipo });
  return gerarPdfHtml(html);
}

async function carregarClienteCompleto(id) {
  const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
  if (!cliente.rows.length) throw new Error('Cliente não encontrado');
  return cliente.rows[0];
}

function renderPdfCliente(item) {
  const company = process.env.PANEL_TITLE || getAppDisplayName();
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8" /><title>${esc(item.nome || item.telefone || 'cliente')} - PDF</title>${pdfCss()}</head><body>
    <div class="top">
      <div class="brand">
        ${logoPdfTag()}
        <div>
          <h1>${esc(company)}</h1>
          <small>${esc(process.env.PANEL_SUBTITLE_PDF || '')}</small>
          <small>Ficha completa do cliente</small>
        </div>
      </div>
      <span class="badge">PDF cliente</span>
    </div>
    <section class="hero">
      <h2>${esc(item.nome || 'Cliente sem nome')}</h2>
      <p class="muted">${esc(formatarTelefone(item.telefone))}</p>
      <div class="hero-grid">
        <div class="hero-item"><strong>Corretor</strong>${esc(item.corretor || '-')}</div>
        <div class="hero-item"><strong>Atendente</strong>${esc(item.atendente || '-')}</div>
        <div class="hero-item"><strong>Proposta</strong>${esc(item.tipo_pagamento || '-')}</div>
        <div class="hero-item"><strong>Cadastro</strong>${formatarDataPtBr(item.data_cadastro)}</div>
      </div>
    </section>
    <section class="section">
      <h2>Preferência do cliente</h2>
      <div class="grid">
        <div class="card"><strong>Tipo imóvel desejado</strong>${esc(item.tipo_imovel_desejado || '-')}</div>
        <div class="card"><strong>Estado imóvel desejado</strong>${esc(item.estado_imovel_desejado || '-')}</div>
        <div class="card"><strong>N° de quartos</strong>${formatarNumero(item.numero_quartos_desejado)}</div>
        <div class="card"><strong>N° banheiro</strong>${formatarNumero(item.numero_banheiros_desejado)}</div>
        <div class="card"><strong>Vaga garagem</strong>${formatarNumero(item.numero_vagas_garagem_desejada)}</div>
        <div class="card"><strong>N° suit</strong>${formatarNumero(item.numero_suites_desejada)}</div>
        <div class="card"><strong>Cidade de interesse</strong>${esc(item.cidade || '-')}</div>
        <div class="card"><strong>Bairro de interesse</strong>${esc(item.bairro || '-')}</div>
        <div class="card"><strong>Valor mínimo</strong>${money(item.valor_minimo)}</div>
        <div class="card"><strong>Valor máximo</strong>${money(item.valor_maximo)}</div>
      </div>
    </section>
    <section class="section">
      <h2>Resumo atendimento</h2>
      <div class="card"><p>${esc(item.resumo_atendimento || 'Sem resumo cadastrado.')}</p></div>
    </section>
    <div class="footer">Documento gerado em ${new Date().toLocaleString('pt-BR')} pelo painel ${esc(company)}.</div>
  </body></html>`;
}

async function gerarPdfCliente(id) {
  const item = await carregarClienteCompleto(id);
  const html = renderPdfCliente(item);
  return gerarPdfHtml(html);
}

function exportFilename(tipo, formato) {
  const agora = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}`;
  return `${getAppInternalName()}_${tipo}_${stamp}.${formato}`;
}

function runPgDump(args) {
  return new Promise((resolve, reject) => {
    execFile('pg_dump', args, {
      env: {
        ...process.env,
        PGPASSWORD: process.env.DB_PASSWORD || '',
      },
      maxBuffer: 1024 * 1024 * 50,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(stdout);
    });
  });
}


function selectTipoPagamento(value, includeEmptyLabel = 'Selecione', name = 'tipo_pagamento') {
  return `<select name="${esc(name)}">${renderSelectOptions(OPCOES_TIPO_PAGAMENTO, value, includeEmptyLabel)}</select>`;
}

function selectSimNaoTantoFaz(name, value, labelVazio = 'Tanto faz') {
  return `<select name="${esc(name)}"><option value="">${esc(labelVazio)}</option><option value="true" ${String(value) === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${String(value) === 'false' ? 'selected' : ''}>Não</option></select>`;
}

function clienteFormValores(source = {}) {
  return {
    telefone: source.telefone || '',
    nome: source.nome || '',
    corretor: source.corretor || '',
    atendente: source.atendente || '',
    interesse: source.interesse || '',
    tipo_imovel_desejado: source.tipo_imovel_desejado || '',
    estado_imovel_desejado: source.estado_imovel_desejado || '',
    numero_quartos_desejado: source.numero_quartos_desejado || '',
    numero_banheiros_desejado: source.numero_banheiros_desejado || '',
    numero_vagas_garagem_desejada: source.numero_vagas_garagem_desejada || '',
    numero_suites_desejada: source.numero_suites_desejada || '',
    valor_minimo: source.valor_minimo || '',
    valor_maximo: source.valor_maximo || '',
    cidade: source.cidade || '',
    bairro: source.bairro || '',
    tipo_pagamento: source.tipo_pagamento || '',
    resumo_atendimento: source.resumo_atendimento || '',
  };
}

async function gerarCodigo(client, categoriaSlug) {
  const categoria = await client.query('SELECT sigla_codigo, pasta_slug FROM categorias_imovel WHERE slug = $1', [categoriaSlug]);
  if (!categoria.rows.length) throw new Error('Categoria inválida');
  const { sigla_codigo, pasta_slug } = categoria.rows[0];
  const usados = await client.query("SELECT codigo FROM imoveis WHERE categoria_slug = $1 AND codigo LIKE $2 ORDER BY codigo", [categoriaSlug, `${sigla_codigo}%`]);
  const numeros = usados.rows.map((r) => Number(String(r.codigo).replace(sigla_codigo, ''))).filter((n) => !Number.isNaN(n));
  const proximo = (Math.max(0, ...numeros) + 1).toString().padStart(4, '0');
  return { codigo: `${sigla_codigo}${proximo}`, pasta_slug };
}

async function removerPastaCategoriaSeVazia(client, categoriaSlug) {
  const info = await client.query('SELECT pasta_slug FROM categorias_imovel WHERE slug = $1', [categoriaSlug]);
  if (!info.rows.length || !info.rows[0].pasta_slug) return;
  const uso = await client.query('SELECT count(*)::int AS total FROM imoveis WHERE categoria_slug = $1', [categoriaSlug]);
  if (uso.rows[0].total > 0) return;
  const baseImagesDir = resolveMediaRoot();
  const pastaCategoria = path.resolve(baseImagesDir, info.rows[0].pasta_slug);
  fs.rmSync(pastaCategoria, { recursive: true, force: true });
}

function cargoFuncionarioFormValores(source = {}) {
  return {
    nome: source.nome || '',
    ativo: source.ativo === false || source.ativo === 'false' || source.ativo === '0' ? '' : '1',
  };
}

function prepararCargoFuncionarioPayload(source = {}) {
  return {
    nome: String(source.nome || '').trim(),
    ativo: source.ativo === false || source.ativo === 'false' || source.ativo === '0' ? false : true,
  };
}

function funcionarioFormValores(source = {}) {
  return {
    nome: source.nome || '',
    sobrenome: source.sobrenome || '',
    telefone: source.telefone || '',
    email: source.email || '',
    endereco: source.endereco || '',
    cargo_id: source.cargo_id || '',
    codigo: source.codigo || '',
    login_temp_password: source.login_temp_password || '',
  };
}

function renderFuncionarioLinkFormulario(codigo, req = null) {
  const link = montarLinkFormularioCorretor(codigo, req);
  const inputId = `link-formulario-${normalizarCodigoFuncionario(codigo).toLowerCase() || 'novo'}`;
  return `
    <div class="field-full">
      <label>Link do formulário</label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <input id="${esc(inputId)}" value="${esc(link)}" readonly style="flex:1;min-width:280px;" />
        <button type="button" class="btn-secondary" onclick="copiarLinkFuncionario('${esc(inputId)}')">Copiar</button>
      </div>
    </div>
  `;
}

function validarCamposObrigatoriosFuncionario(payload) {
  const campos = [
    ['nome', 'nome'],
    ['sobrenome', 'sobrenome'],
    ['telefone', 'telefone'],
    ['cargo_id', 'cargo'],
  ];
  return campos.find(([key]) => !String(payload[key] || '').trim()) || null;
}

function fieldErrorClass(field, missingField) {
  return missingField === field ? 'input-error' : '';
}

async function gerarCodigoFuncionario(client, { lock = true } = {}) {
  const sqlBase = "SELECT codigo FROM funcionarios WHERE codigo LIKE 'COD%' ORDER BY codigo";
  const usados = await client.query(lock ? `${sqlBase} FOR UPDATE` : sqlBase);
  const numeros = usados.rows
    .map((r) => Number(String(r.codigo || '').replace(/^COD/, '')))
    .filter((n) => !Number.isNaN(n));
  const proximo = (Math.max(0, ...numeros) + 1).toString().padStart(3, '0');
  return `COD${proximo}`;
}

app.get('/painel/funcionarios', auth, async (req, res) => {
  const [totais, cargos] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM funcionarios'),
    pool.query('SELECT count(*)::int AS total FROM cargos_funcionario WHERE ativo IS TRUE'),
  ]);
  res.send(shell({
    title: 'Funcionários',
    subtitle: 'Módulo para cadastro, pesquisa e gestão de cargos dos funcionários.',
    active: 'funcionarios',
    content: `
      <section class="stats stats-home">
        <article class="stat-card"><span class="muted">Funcionários cadastrados</span><strong>${totais.rows[0].total}</strong></article>
        <article class="stat-card"><span class="muted">Cargos ativos</span><strong>${cargos.rows[0].total}</strong></article>
      </section>
      <section class="card">
        <div class="results-grid">
          <article class="result-card">
            <h4>Cadastrar funcionário</h4>
            <p class="muted">Cadastro operacional com código automático, cargo e validação de campos obrigatórios.</p>
            <div class="result-actions"><a class="btn-link" href="/painel/funcionarios/novo">Abrir cadastro</a></div>
          </article>
          <article class="result-card">
            <h4>Pesquisar funcionário</h4>
            <p class="muted">Busca por nome, telefone e cargo, com edição e exclusão protegidas por senha.</p>
            <div class="result-actions"><a class="btn-link" href="/painel/funcionarios/pesquisar">Abrir pesquisa</a></div>
          </article>
          <article class="result-card">
            <h4>Criar/Editar cargo</h4>
            <p class="muted">Criar Cargo, ativar, desativar e exclusão (exclusão bloqueada quando houver vínculo.)</p>
            <div class="result-actions"><a class="btn-link" href="/painel/funcionarios/cargos">Abrir cargos</a></div>
          </article>
        </div>
      </section>
    `,
  }));
});

app.get('/painel/funcionarios/cargos', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const v = cargoFuncionarioFormValores(req.query);
  const cargos = await pool.query(`
    SELECT c.*, count(f.id)::int AS total_funcionarios
    FROM cargos_funcionario c
    LEFT JOIN funcionarios f ON f.cargo_id = c.id
    GROUP BY c.id
    ORDER BY c.nome
  `);
  const rows = cargos.rows.map((item) => `
    <article class="result-card">
      <h4>${esc(item.nome)}</h4>
      <div class="result-meta">
        <div><strong>Status</strong>${item.ativo ? 'Ativo' : 'Inativo'}</div>
        <div><strong>Funcionários vinculados</strong>${item.total_funcionarios}</div>
      </div>
      <div class="result-actions">
        <form method="post" action="/painel/funcionarios/cargos-editar-senha/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCargoFuncionario(event, 'editar')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-secondary">Editar cargo</button>
        </form>
        <form method="post" action="/painel/funcionarios/cargos-status/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCargoFuncionario(event, '${item.ativo ? 'desativar' : 'ativar'}')">
          <input type="hidden" name="senha" value="" />
          <input type="hidden" name="ativo" value="${item.ativo ? '0' : '1'}" />
          <button type="submit" class="btn-secondary">${item.ativo ? 'Desativar' : 'Ativar'}</button>
        </form>
        <form method="post" action="/painel/funcionarios/cargos-excluir/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCargoFuncionario(event, 'excluir')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-danger">Excluir cargo</button>
        </form>
      </div>
    </article>
  `).join('');

  res.send(shell({
    title: 'Cargos de funcionários',
    active: 'cargos-funcionarios',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <h3>Novo cargo</h3>
        <form method="post" action="/painel/funcionarios/cargos/novo" onsubmit="return confirmarSenhaPainel(event, 'cadastrar o cargo')">
          <input type="hidden" name="senha" value="" />
          <div class="grid">
            <div><label>Nome do cargo</label><input name="nome" value="${esc(v.nome)}" required /></div>
            <div><label>Ativo</label><select name="ativo"><option value="1" ${v.ativo ? 'selected' : ''}>Sim</option><option value="0" ${!v.ativo ? 'selected' : ''}>Não</option></select></div>
          </div>
          <div class="filters-actions"><button type="submit">Cadastrar cargo</button><a href="/painel/funcionarios/novo"><button type="button" class="btn-secondary">Voltar para cadastro de funcionários</button></a></div>
        </form>
      </section>
      <section class="card">
        <h3>Lista de cargos</h3>
        <div class="results-grid">${rows || '<div class="empty">Nenhum cargo cadastrado.</div>'}</div>
      </section>
      <script>
        function confirmarSenhaAcaoCargoFuncionario(event, acao) {
          const senha = window.prompt('Digite a senha para ' + acao + ' o cargo:');
          if (!senha) return false;
          if (acao === 'excluir') {
            const confirmar = window.confirm('Confirma excluir este cargo?');
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
      </script>
    `,
  }));
});

app.post('/painel/funcionarios/cargos/novo', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const b = cargoFuncionarioFormValores(req.body);
  const payload = prepararCargoFuncionarioPayload(req.body);
  if (!payload.nome) {
    const qs = new URLSearchParams({ ...b, erro: 'Informe o nome do cargo.' }).toString();
    return res.redirect(`/painel/funcionarios/cargos?${qs}`);
  }
  try {
    await pool.query('INSERT INTO cargos_funcionario (nome, ativo) VALUES ($1, $2)', [payload.nome, payload.ativo]);
    res.redirect('/painel/funcionarios/cargos');
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe cargo com esse nome.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    res.redirect(`/painel/funcionarios/cargos?${qs}`);
  }
});

app.post('/painel/funcionarios/cargos-editar-senha/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  res.redirect(`/painel/funcionarios/cargos-editar/${req.params.id}?senha=${encodeURIComponent(req.body.senha)}`);
});

app.get('/painel/funcionarios/cargos-editar/:id', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const result = await pool.query('SELECT * FROM cargos_funcionario WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).send('Cargo não encontrado');
  const item = { ...result.rows[0], ...req.query };
  const v = cargoFuncionarioFormValores(item);
  res.send(shell({
    title: `Editar cargo ${item.nome}`,
    subtitle: 'Edição de cargo com proteção por senha.',
    active: 'cargos-funcionarios',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/funcionarios/cargos-salvar/${item.id}?senha=${encodeURIComponent(req.query.senha || '')}">
          <div class="grid">
            <div><label>Nome do cargo</label><input name="nome" value="${esc(v.nome)}" required /></div>
            <div><label>Ativo</label><select name="ativo"><option value="1" ${v.ativo ? 'selected' : ''}>Sim</option><option value="0" ${!v.ativo ? 'selected' : ''}>Não</option></select></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Salvar cargo</button>
            <a href="/painel/funcionarios/cargos"><button type="button" class="btn-secondary">Cancelar</button></a>
          </div>
        </form>
      </section>
    `,
  }));
});

app.post('/painel/funcionarios/cargos-salvar/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha || req.body.senha)) return res.status(403).send('Senha inválida');
  const b = cargoFuncionarioFormValores(req.body);
  const payload = prepararCargoFuncionarioPayload(req.body);
  if (!payload.nome) {
    const qs = new URLSearchParams({ ...b, erro: 'Informe o nome do cargo.' }).toString();
    return res.redirect(`/painel/funcionarios/cargos-editar/${req.params.id}?${qs}`);
  }
  try {
    await pool.query('UPDATE cargos_funcionario SET nome = $2, ativo = $3, updated_at = now() WHERE id = $1', [req.params.id, payload.nome, payload.ativo]);
    res.redirect('/painel/funcionarios/cargos');
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe cargo com esse nome.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    res.redirect(`/painel/funcionarios/cargos-editar/${req.params.id}?${qs}`);
  }
});

app.post('/painel/funcionarios/cargos-status/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  await pool.query('UPDATE cargos_funcionario SET ativo = $2, updated_at = now() WHERE id = $1', [req.params.id, req.body.ativo === '1']);
  res.redirect('/painel/funcionarios/cargos');
});

app.post('/painel/funcionarios/cargos-excluir/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const vinculos = await pool.query('SELECT count(*)::int AS total FROM funcionarios WHERE cargo_id = $1', [req.params.id]);
  if (vinculos.rows[0].total > 0) {
    return res.redirect(`/painel/funcionarios/cargos?erro=${encodeURIComponent('Não é possível excluir cargo com funcionários vinculados.')}`);
  }
  await pool.query('DELETE FROM cargos_funcionario WHERE id = $1', [req.params.id]);
  res.redirect('/painel/funcionarios/cargos');
});

app.get('/painel/funcionarios/novo', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const ok = req.query.ok ? decodeURIComponent(req.query.ok) : '';
  const missingField = req.query.missingField ? String(req.query.missingField) : '';
  const v = funcionarioFormValores(req.query);
  const [cargos, codigoPreview] = await Promise.all([
    pool.query('SELECT id, nome FROM cargos_funcionario WHERE ativo IS TRUE ORDER BY nome'),
    gerarCodigoFuncionario(pool, { lock: false }),
  ]);
  res.send(shell({
    title: 'Cadastrar funcionário',
    active: 'novo-funcionario',
    content: `
      ${renderFormError(erro || ok)}
      <section class="card">
        <form method="post" action="/painel/funcionarios/novo" onsubmit="return confirmarSenhaPainel(event, 'salvar o cadastro do funcionário')">
          <input type="hidden" name="senha" value="" />
          <div class="grid">
            <div><label>Código</label><input value="${esc(codigoPreview)}" readonly /></div>
            <div><label>Nome ${missingField === 'nome' ? '<span class="field-error-marker">*</span>' : ''}</label><input name="nome" value="${esc(v.nome)}" class="${fieldErrorClass('nome', missingField)}" required /></div>
            <div><label>Sobrenome ${missingField === 'sobrenome' ? '<span class="field-error-marker">*</span>' : ''}</label><input name="sobrenome" value="${esc(v.sobrenome)}" class="${fieldErrorClass('sobrenome', missingField)}" required /></div>
            <div><label>Telefone ${missingField === 'telefone' ? '<span class="field-error-marker">*</span>' : ''}</label><input name="telefone" value="${v.telefone ? esc(formatarTelefone(v.telefone)) : ''}" class="${fieldErrorClass('telefone', missingField)}" placeholder="(51) 98035-7562" inputmode="numeric" oninput="let v=this.value.replace(/[^0-9]/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" required /></div>
            <div><label>E-mail</label><input type="email" name="email" value="${esc(v.email)}" /></div>
            <div class="field-full"><label>Endereço</label><input name="endereco" value="${esc(v.endereco)}" /></div>
            <div><label>Cargo ${missingField === 'cargo_id' ? '<span class="field-error-marker">*</span>' : ''}</label><select name="cargo_id" class="${fieldErrorClass('cargo_id', missingField)}" required><option value="">Selecione</option>${cargos.rows.map((cargo) => `<option value="${cargo.id}" ${v.cargo_id === cargo.id ? 'selected' : ''}>${esc(cargo.nome)}</option>`).join('')}</select></div>
            <div style="display:flex;align-items:end;"><a class="btn-link" href="/painel/funcionarios/cargos">Novo cargo</a></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Salvar cadastro</button>
            <a href="/painel/funcionarios/novo"><button type="button" class="btn-secondary">Cancelar</button></a>
          </div>
        </form>
      </section>
    `,
  }));
});

app.post('/painel/funcionarios/novo', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const b = funcionarioFormValores(req.body);
  const payload = {
    nome: String(b.nome || '').trim(),
    sobrenome: String(b.sobrenome || '').trim(),
    telefone: normalizarTelefone(b.telefone),
    email: String(b.email || '').trim(),
    endereco: String(b.endereco || '').trim(),
    cargo_id: String(b.cargo_id || '').trim(),
  };
  const obrigatorio = validarCamposObrigatoriosFuncionario(payload);
  if (obrigatorio) {
    const qs = new URLSearchParams({ ...b, erro: `Preencha o campo ${obrigatorio[1]}.`, missingField: obrigatorio[0] }).toString();
    return res.redirect(`/painel/funcionarios/novo?${qs}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const codigo = await gerarCodigoFuncionario(client);
    const senhaInicial = senhaInicialFuncionario(codigo);
    await client.query(`INSERT INTO funcionarios (codigo, nome, sobrenome, telefone, email, endereco, cargo_id, login_password_hash, login_reset_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`, [codigo, payload.nome, payload.sobrenome, payload.telefone, payload.email || null, payload.endereco || null, payload.cargo_id, criarHashSenhaFuncionario(senhaInicial)]);
    await client.query('COMMIT');
    return res.redirect(`/painel/funcionarios/novo?ok=${encodeURIComponent(`Funcionário ${codigo} cadastrado com sucesso. Login: ${codigo} | Senha inicial: ${senhaInicial}`)}`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    const mensagem = error.code === '23505' ? 'Já existe funcionário com esse código.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    return res.redirect(`/painel/funcionarios/novo?${qs}`);
  } finally {
    client.release();
  }
});

app.get('/painel/funcionarios/pesquisar', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const ok = req.query.ok ? decodeURIComponent(req.query.ok) : '';
  const filtros = {
    nome: String(req.query.nome || '').trim(),
    telefone: String(req.query.telefone || '').trim(),
    cargo_id: String(req.query.cargo_id || '').trim(),
  };
  const [cargos, sugestoes] = await Promise.all([
    pool.query('SELECT id, nome FROM cargos_funcionario ORDER BY nome'),
    pool.query('SELECT nome, sobrenome, telefone FROM funcionarios ORDER BY nome, sobrenome LIMIT 200'),
  ]);
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$X', `$${params.length}`)); };
  if (filtros.nome) add("concat_ws(' ', f.nome, f.sobrenome) ILIKE $X", `%${filtros.nome}%`);
  if (filtros.telefone) add("regexp_replace(f.telefone, '\\D', '', 'g') ILIKE $X", `%${normalizarTelefone(filtros.telefone)}%`);
  if (filtros.cargo_id) add('f.cargo_id = $X', filtros.cargo_id);
  const temFiltros = Object.values(filtros).some(Boolean);
  const result = temFiltros ? await pool.query(`
    SELECT f.*, c.nome AS cargo_nome
    FROM funcionarios f
    JOIN cargos_funcionario c ON c.id = f.cargo_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.data_cadastro DESC, f.nome, f.sobrenome
    LIMIT 100
  `, params) : { rows: [] };
  const rows = result.rows.map((item) => `
    <article class="result-card">
      <h4>${esc(item.nome)} ${esc(item.sobrenome)}</h4>
      <div class="result-meta">
        <div><strong>Código</strong>${esc(item.codigo)}</div>
        <div><strong>Telefone</strong>${esc(formatarTelefone(item.telefone))}</div>
        <div><strong>E-mail</strong>${esc(item.email || '-')}</div>
        <div><strong>Cargo</strong>${esc(item.cargo_nome || '-')}</div>
        <div><strong>Data cadastro</strong>${formatarDataPtBr(item.data_cadastro)}</div>
        <div><strong>Data alteração</strong>${formatarDataPtBr(item.data_alteracao)}</div>
      </div>
      <div class="card" style="margin-top:16px;padding:14px;"><strong>Endereço</strong><p>${esc(item.endereco || '-')}</p></div>
      <div class="card" style="margin-top:16px;padding:14px;">
        <strong>Link do formulário</strong>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px;">
          <input id="link-formulario-${esc(String(item.codigo || '').toLowerCase())}" value="${esc(montarLinkFormularioCorretor(item.codigo, req))}" readonly style="flex:1;min-width:260px;" />
          <button type="button" class="btn-secondary" onclick="copiarLinkFuncionario('link-formulario-${esc(String(item.codigo || '').toLowerCase())}')">Copiar</button>
        </div>
      </div>
      <div class="card" style="margin-top:16px;padding:14px;">
        <strong>Acesso do funcionário</strong>
        <p style="margin:10px 0 0;"><strong>Usuário:</strong> ${esc(item.codigo)}</p>
        <p style="margin:6px 0 0;">Se usuário esquecer a senha, use <strong>Resetar senha de login</strong> para gerar uma nova temporária.</p>
      </div>
      <div class="result-actions">
        <form method="post" action="/painel/funcionarios-editar-senha/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoFuncionario(event, 'editar')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-secondary">Editar funcionário</button>
        </form>
        <form method="post" action="/painel/funcionarios-login-reset/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoFuncionario(event, 'resetar login')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-secondary">Resetar senha de login</button>
        </form>
        <form method="post" action="/painel/funcionarios-excluir/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoFuncionario(event, 'excluir')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-danger">Excluir funcionário</button>
        </form>
      </div>
    </article>
  `).join('');
  res.send(shell({
    title: 'Pesquisar funcionários',
    subtitle: 'Busca por nome, telefone e cargo.',
    active: 'funcionarios',
    content: `
      ${erro ? renderFormError(erro) : ''}
      ${ok ? `<div class="card" style="border:2px solid #16a34a;background:#f0fdf4;color:#166534;font-weight:700;">${esc(ok)}</div>` : ''}
      <section class="card">
        <form method="get" action="/painel/funcionarios/pesquisar">
          <div class="grid grid-3">
            <div><label>Nome</label><input name="nome" value="${esc(filtros.nome)}" list="funcionarios-nomes" autocomplete="off" /></div>
            <div><label>Telefone</label><input name="telefone" value="${filtros.telefone ? esc(formatarTelefone(filtros.telefone)) : ''}" placeholder="(51) 98035-7562" inputmode="numeric" oninput="let v=this.value.replace(/[^0-9]/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" /></div>
            <div><label>Cargo</label><select name="cargo_id"><option value="">Todos</option>${cargos.rows.map((cargo) => `<option value="${cargo.id}" ${filtros.cargo_id === cargo.id ? 'selected' : ''}>${esc(cargo.nome)}</option>`).join('')}</select></div>
          </div>
          <div class="filters-actions"><button type="submit">Pesquisar</button><a href="/painel/funcionarios/pesquisar">Limpar</a></div>
        </form>
      </section>
      <section class="card"><h3>Resultados</h3><div class="results-grid">${rows || '<div class="empty">Nenhum funcionário encontrado.</div>'}</div></section>
      <datalist id="funcionarios-nomes">${[...new Set(sugestoes.rows.map((item) => `${String(item.nome || '').trim()} ${String(item.sobrenome || '').trim()}`.trim()).filter(Boolean))].map((nome) => `<option value="${esc(nome)}"></option>`).join('')}</datalist>
      <script>
        function confirmarSenhaAcaoFuncionario(event, acao) {
          const senha = window.prompt('Digite a senha para ' + acao + ' o funcionário:');
          if (!senha) return false;
          if (acao === 'excluir') {
            const confirmar = window.confirm('Confirma excluir este funcionário?');
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
        function copiarLinkFuncionario(id) {
          const input = document.getElementById(id);
          if (!input) return;
          input.select();
          input.setSelectionRange(0, input.value.length);
          navigator.clipboard.writeText(input.value).then(() => {
            window.alert('Link copiado para a área de transferência.');
          }).catch(() => {
            document.execCommand('copy');
            window.alert('Link copiado para a área de transferência.');
          });
        }
      </script>
    `,
  }));
});

app.post('/painel/funcionarios-editar-senha/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  res.redirect(`/painel/funcionarios-editar/${req.params.id}?senha=${encodeURIComponent(req.body.senha)}`);
});

app.get('/painel/funcionarios-editar/:id', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const missingField = req.query.missingField ? String(req.query.missingField) : '';
  const [result, cargos] = await Promise.all([
    pool.query('SELECT * FROM funcionarios WHERE id = $1', [req.params.id]),
    pool.query('SELECT id, nome FROM cargos_funcionario ORDER BY nome'),
  ]);
  if (!result.rows.length) return res.status(404).send('Funcionário não encontrado');
  const item = { ...result.rows[0], ...req.query };
  const v = funcionarioFormValores(item);
  const linkFormulario = renderFuncionarioLinkFormulario(item.codigo, req);
  res.send(shell({
    title: `Editar funcionário ${item.codigo}`,
    subtitle: 'Edição protegida por senha do painel.',
    active: 'funcionarios',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/funcionarios-salvar/${item.id}?senha=${encodeURIComponent(req.query.senha || '')}">
          <div class="grid">
            <div><label>Código</label><input value="${esc(item.codigo)}" readonly /></div>
            ${linkFormulario}
            <div><label>Nome ${missingField === 'nome' ? '<span class="field-error-marker">*</span>' : ''}</label><input name="nome" value="${esc(v.nome)}" class="${fieldErrorClass('nome', missingField)}" required /></div>
            <div><label>Sobrenome ${missingField === 'sobrenome' ? '<span class="field-error-marker">*</span>' : ''}</label><input name="sobrenome" value="${esc(v.sobrenome)}" class="${fieldErrorClass('sobrenome', missingField)}" required /></div>
            <div><label>Telefone ${missingField === 'telefone' ? '<span class="field-error-marker">*</span>' : ''}</label><input name="telefone" value="${v.telefone ? esc(formatarTelefone(v.telefone)) : ''}" class="${fieldErrorClass('telefone', missingField)}" placeholder="(51) 98035-7562" inputmode="numeric" oninput="let v=this.value.replace(/[^0-9]/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" required /></div>
            <div><label>E-mail</label><input type="email" name="email" value="${esc(v.email)}" /></div>
            <div class="field-full"><label>Endereço</label><input name="endereco" value="${esc(v.endereco)}" /></div>
            <div><label>Cargo ${missingField === 'cargo_id' ? '<span class="field-error-marker">*</span>' : ''}</label><select name="cargo_id" class="${fieldErrorClass('cargo_id', missingField)}" required><option value="">Selecione</option>${cargos.rows.map((cargo) => `<option value="${cargo.id}" ${v.cargo_id === cargo.id ? 'selected' : ''}>${esc(cargo.nome)}</option>`).join('')}</select></div>
            <div style="display:flex;align-items:end;"><a class="btn-link" href="/painel/funcionarios/cargos">Novo cargo</a></div>
          </div>
          <div class="filters-actions"><button type="submit">Salvar funcionário</button><a href="/painel/funcionarios/pesquisar"><button type="button" class="btn-secondary">Cancelar</button></a></div>
        </form>
      </section>
      <script>
        function copiarLinkFuncionario(id) {
          const input = document.getElementById(id);
          if (!input) return;
          input.select();
          input.setSelectionRange(0, input.value.length);
          navigator.clipboard.writeText(input.value).then(() => {
            window.alert('Link copiado para a área de transferência.');
          }).catch(() => {
            document.execCommand('copy');
            window.alert('Link copiado para a área de transferência.');
          });
        }
      </script>
    `,
  }));
});

app.post('/painel/funcionarios-salvar/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha || req.body.senha)) return res.status(403).send('Senha inválida');
  const b = funcionarioFormValores(req.body);
  const payload = {
    nome: String(b.nome || '').trim(),
    sobrenome: String(b.sobrenome || '').trim(),
    telefone: normalizarTelefone(b.telefone),
    email: String(b.email || '').trim(),
    endereco: String(b.endereco || '').trim(),
    cargo_id: String(b.cargo_id || '').trim(),
  };
  const obrigatorio = validarCamposObrigatoriosFuncionario(payload);
  if (obrigatorio) {
    const qs = new URLSearchParams({ ...b, erro: `Preencha o campo ${obrigatorio[1]}.`, missingField: obrigatorio[0] }).toString();
    return res.redirect(`/painel/funcionarios-editar/${req.params.id}?${qs}`);
  }
  await pool.query(`UPDATE funcionarios SET nome = $2, sobrenome = $3, telefone = $4, email = $5, endereco = $6, cargo_id = $7, data_alteracao = now() WHERE id = $1`, [req.params.id, payload.nome, payload.sobrenome, payload.telefone, payload.email || null, payload.endereco || null, payload.cargo_id]);
  res.redirect('/painel/funcionarios/pesquisar');
});

app.post('/painel/funcionarios-login-reset/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const result = await pool.query('SELECT id, codigo FROM funcionarios WHERE id = $1 LIMIT 1', [req.params.id]);
  if (!result.rows.length) return res.status(404).send('Funcionário não encontrado');
  const item = result.rows[0];
  const senhaTemporaria = gerarSenhaTemporariaFuncionario(item.codigo);
  await pool.query('UPDATE funcionarios SET login_password_hash = $2, login_reset_required = true, data_alteracao = now() WHERE id = $1', [item.id, criarHashSenhaFuncionario(senhaTemporaria)]);
  return res.redirect(`/painel/funcionarios/pesquisar?ok=${encodeURIComponent(`Senha de login resetada para ${item.codigo}. Senha temporária: ${senhaTemporaria}`)}`);
});

app.post('/painel/funcionarios-excluir/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  await pool.query('DELETE FROM funcionarios WHERE id = $1', [req.params.id]);
  res.redirect('/painel/funcionarios/pesquisar');
});

app.get('/painel/categorias', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const v = categoriaFormValores(req.query);
  const categorias = await pool.query('SELECT * FROM categorias_imovel ORDER BY nome_exibicao');
  const rows = categorias.rows.map((item) => `
    <article class="result-card">
      <h4>${esc(item.nome_exibicao)}</h4>
      <div class="result-meta">
        <div><strong>Slug</strong>${esc(item.slug)}</div>
        <div><strong>Sigla código</strong>${esc(item.sigla_codigo)}</div>
        <div><strong>Pasta</strong>${esc(item.pasta_slug)}</div>
        <div><strong>Ativa</strong>${item.ativa ? 'Sim' : 'Não'}</div>
      </div>
      <div class="result-actions">
        <form method="post" action="/painel/categorias-editar-senha/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCategoria(event, 'editar')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-secondary">Editar categoria</button>
        </form>
        <form method="post" action="/painel/categorias-status/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCategoria(event, '${item.ativa ? 'desativar' : 'ativar'}')">
          <input type="hidden" name="senha" value="" />
          <input type="hidden" name="ativa" value="${item.ativa ? '0' : '1'}" />
          <button type="submit" class="btn-secondary">${item.ativa ? 'Desativar' : 'Ativar'}</button>
        </form>
        <form method="post" action="/painel/categorias-excluir/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCategoria(event, 'excluir')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-danger">Excluir categoria</button>
        </form>
      </div>
    </article>
  `).join('');

  res.send(shell({
    title: 'Categorias de imóveis',
    subtitle: getCategoriesPageSubtitle(),
    active: 'categorias',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <h3>Nova categoria</h3>
        <form method="post" action="/painel/categorias/novo" onsubmit="return confirmarSenhaPainel(event, 'cadastrar a categoria')">
          <input type="hidden" name="senha" value="" />
          <div class="grid">
            <div><label>Nome de exibição</label><input name="nome_exibicao" value="${esc(v.nome_exibicao)}" required /></div>
            <div><label>Sigla código</label><input name="sigla_codigo" value="${esc(v.sigla_codigo)}" placeholder="ex.: SO" required /></div>
            <div><label>Ativa</label><select name="ativa"><option value="1" ${v.ativa ? 'selected' : ''}>Sim</option><option value="0" ${!v.ativa ? 'selected' : ''}>Não</option></select></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Cadastrar categoria</button>
          </div>
        </form>
      </section>
      <section class="card">
        <h3>Lista de categorias</h3>
        <div class="results-grid">
          ${rows || '<div class="empty">Nenhuma categoria cadastrada.</div>'}
        </div>
      </section>
      <script>
        function confirmarSenhaAcaoCategoria(event, acao) {
          const senha = window.prompt('Digite a senha para ' + acao + ' a categoria:');
          if (!senha) return false;
          if (acao === 'excluir') {
            const confirmar = window.confirm('Confirma excluir esta categoria?');
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
      </script>
    `,
  }));
});

app.post('/painel/categorias/novo', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const b = categoriaFormValores(req.body);
  const payload = prepararCategoriaPayload(req.body);
  if (!payload.nome_exibicao) {
    const qs = new URLSearchParams({ ...b, erro: 'Informe o nome de exibição da categoria.' }).toString();
    return res.redirect(`/painel/categorias?${qs}`);
  }
  if (!payload.slug) {
    const qs = new URLSearchParams({ ...b, erro: 'Não foi possível gerar slug válido para esta categoria.' }).toString();
    return res.redirect(`/painel/categorias?${qs}`);
  }
  if (!validarSiglaCodigo(payload.sigla_codigo)) {
    const qs = new URLSearchParams({ ...b, erro: 'Sigla código deve conter apenas letras maiúsculas e números.' }).toString();
    return res.redirect(`/painel/categorias?${qs}`);
  }
  try {
    await pool.query(`INSERT INTO categorias_imovel (slug, nome_exibicao, sigla_codigo, pasta_slug, ativa) VALUES ($1,$2,$3,$4,$5)`, [
      payload.slug,
      payload.nome_exibicao,
      payload.sigla_codigo,
      payload.pasta_slug,
      payload.ativa,
    ]);
    res.redirect(`/painel/categorias?slug=${encodeURIComponent(payload.slug)}`);
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe categoria com esse slug ou sigla.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    res.redirect(`/painel/categorias?${qs}`);
  }
});

app.post('/painel/categorias-editar-senha/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  res.redirect(`/painel/categorias-editar/${req.params.id}?senha=${encodeURIComponent(req.body.senha)}`);
});

app.get('/painel/categorias-editar/:id', auth, async (req, res) => {
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const result = await pool.query('SELECT * FROM categorias_imovel WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).send('Categoria não encontrada');
  const item = { ...result.rows[0], ...req.query };
  const uso = await pool.query('SELECT count(*)::int AS total FROM imoveis WHERE categoria_slug = $1', [result.rows[0].slug]);
  const bloqueada = uso.rows[0].total > 0;
  const v = categoriaFormValores(item);
  res.send(shell({
    title: `Editar categoria ${item.nome_exibicao}`,
    subtitle: getCategoriesEditSubtitle(),
    active: 'categorias',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/categorias-salvar/${item.id}?senha=${encodeURIComponent(req.query.senha || '')}">
          <div class="grid">
            <div><label>Nome de exibição</label><input name="nome_exibicao" value="${esc(v.nome_exibicao)}" required /></div>
            <div><label>Sigla código</label><input name="sigla_codigo" value="${esc(v.sigla_codigo)}" ${bloqueada ? 'readonly' : ''} required /></div>
            <div><label>Ativa</label><select name="ativa"><option value="1" ${v.ativa ? 'selected' : ''}>Sim</option><option value="0" ${!v.ativa ? 'selected' : ''}>Não</option></select></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Salvar categoria</button>
            <a href="/painel/categorias"><button type="button" class="btn-secondary">Cancelar</button></a>
          </div>
          ${bloqueada ? '<p class="muted">A sigla fica bloqueada quando já existem imóveis vinculados a esta categoria.</p>' : ''}
        </form>
      </section>
    `,
  }));
});

app.post('/painel/categorias-salvar/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha || req.body.senha)) return res.status(403).send('Senha inválida');
  const b = categoriaFormValores(req.body);
  const payload = prepararCategoriaPayload(req.body);
  if (!payload.nome_exibicao) {
    const qs = new URLSearchParams({ ...b, erro: 'Informe o nome de exibição da categoria.' }).toString();
    return res.redirect(`/painel/categorias-editar/${req.params.id}?${qs}`);
  }
  if (!payload.slug) {
    const qs = new URLSearchParams({ ...b, erro: 'Não foi possível gerar slug válido para esta categoria.' }).toString();
    return res.redirect(`/painel/categorias-editar/${req.params.id}?${qs}`);
  }
  if (!validarSiglaCodigo(payload.sigla_codigo)) {
    const qs = new URLSearchParams({ ...b, erro: 'Sigla código deve conter apenas letras maiúsculas e números.' }).toString();
    return res.redirect(`/painel/categorias-editar/${req.params.id}?${qs}`);
  }
  try {
    const atual = await pool.query('SELECT slug, sigla_codigo FROM categorias_imovel WHERE id = $1', [req.params.id]);
    if (!atual.rows.length) return res.status(404).send('Categoria não encontrada');
    const uso = await pool.query('SELECT count(*)::int AS total FROM imoveis WHERE categoria_slug = $1', [atual.rows[0].slug]);
    const bloqueada = uso.rows[0].total > 0;
    const novoSlug = payload.slug;
    const novaSigla = bloqueada ? atual.rows[0].sigla_codigo : payload.sigla_codigo;
    await pool.query(`UPDATE categorias_imovel SET slug = $2, nome_exibicao = $3, sigla_codigo = $4, pasta_slug = $5, ativa = $6, updated_at = now() WHERE id = $1`, [
      req.params.id,
      novoSlug,
      payload.nome_exibicao,
      novaSigla,
      novoSlug,
      payload.ativa,
    ]);
    res.redirect('/painel/categorias');
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe categoria com esse slug ou sigla.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    res.redirect(`/painel/categorias-editar/${req.params.id}?${qs}`);
  }
});

app.post('/painel/categorias-status/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  await pool.query('UPDATE categorias_imovel SET ativa = $2, updated_at = now() WHERE id = $1', [req.params.id, req.body.ativa === '1']);
  res.redirect('/painel/categorias');
});

app.post('/painel/categorias-excluir/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const categoria = await client.query('SELECT slug, pasta_slug FROM categorias_imovel WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!categoria.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Categoria não encontrada');
    }
    const uso = await client.query('SELECT count(*)::int AS total FROM imoveis WHERE categoria_slug = $1', [categoria.rows[0].slug]);
    if (uso.rows[0].total > 0) {
      await client.query('ROLLBACK');
      return res.redirect(`/painel/categorias?erro=${encodeURIComponent('Não é possível excluir categoria com imóveis vinculados.')}`);
    }
    const baseImagesDir = resolveMediaRoot();
    const pastaCategoria = categoria.rows[0].pasta_slug ? path.resolve(baseImagesDir, categoria.rows[0].pasta_slug) : null;
    if (pastaCategoria) {
      fs.rmSync(pastaCategoria, { recursive: true, force: true });
      if (fs.existsSync(pastaCategoria)) {
        throw new Error(`Falha ao remover pasta vazia da categoria: ${pastaCategoria}`);
      }
    }
    await client.query('DELETE FROM categorias_imovel WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.redirect('/painel/categorias');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).send(error.message);
  } finally {
    client.release();
  }
});

app.get('/painel/clientes/simular-compatibilidade', auth, async (req, res) => {
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const filtros = {
    nome: (req.query.nome || '').trim(),
    telefone: (req.query.telefone || '').trim(),
    cidade: (req.query.cidade || '').trim(),
    bairro: (req.query.bairro || '').trim(),
    tipo_imovel_desejado: (req.query.tipo_imovel_desejado || '').trim(),
    estado_imovel_desejado: (req.query.estado_imovel_desejado || '').trim(),
    valor_minimo: normalizarNumeroFormulario(req.query.valor_minimo || '', { decimal: true }),
    valor_maximo: normalizarNumeroFormulario(req.query.valor_maximo || '', { decimal: true }),
    numero_quartos_desejado: normalizarNumeroFormulario(req.query.numero_quartos_desejado || ''),
    numero_banheiros_desejado: normalizarNumeroFormulario(req.query.numero_banheiros_desejado || ''),
    numero_vagas_garagem_desejada: normalizarNumeroFormulario(req.query.numero_vagas_garagem_desejada || ''),
    numero_suites_desejada: normalizarNumeroFormulario(req.query.numero_suites_desejada || ''),
    tipo_pagamento: (req.query.tipo_pagamento || '').trim(),
    possui_escritura: req.query.possui_escritura || '',
  };

  let clienteBase = null;
  if (filtros.telefone || filtros.nome) {
    const where = [];
    const params = [];
    if (filtros.telefone) { params.push(`%${normalizarTelefone(filtros.telefone)}%`); where.push(`regexp_replace(telefone, '\D', '', 'g') ILIKE $${params.length}`); }
    if (filtros.nome) { params.push(`%${filtros.nome}%`); where.push(`nome ILIKE $${params.length}`); }
    if (where.length) {
      const found = await pool.query(`SELECT * FROM clientes WHERE ${where.join(' AND ')} ORDER BY data_cadastro DESC, id DESC LIMIT 1`, params);
      clienteBase = found.rows[0] || null;
      if (clienteBase && req.query.acao === 'puxar-cliente') {
        filtros.nome = clienteBase.nome || '';
        filtros.telefone = clienteBase.telefone || '';
        filtros.cidade = clienteBase.cidade || '';
        filtros.bairro = clienteBase.bairro || '';
        filtros.tipo_imovel_desejado = clienteBase.tipo_imovel_desejado || '';
        filtros.estado_imovel_desejado = clienteBase.estado_imovel_desejado || '';
        filtros.valor_minimo = clienteBase.valor_minimo != null ? String(clienteBase.valor_minimo) : '';
        filtros.valor_maximo = clienteBase.valor_maximo != null ? String(clienteBase.valor_maximo) : '';
        filtros.numero_quartos_desejado = clienteBase.numero_quartos_desejado != null ? String(clienteBase.numero_quartos_desejado) : '';
        filtros.numero_banheiros_desejado = clienteBase.numero_banheiros_desejado != null ? String(clienteBase.numero_banheiros_desejado) : '';
        filtros.numero_vagas_garagem_desejada = clienteBase.numero_vagas_garagem_desejada != null ? String(clienteBase.numero_vagas_garagem_desejada) : '';
        filtros.numero_suites_desejada = clienteBase.numero_suites_desejada != null ? String(clienteBase.numero_suites_desejada) : '';
        filtros.tipo_pagamento = clienteBase.tipo_pagamento || '';
        filtros.possui_escritura = clienteBase.possui_escritura != null ? String(clienteBase.possui_escritura) : '';
      }
    }
  }

  const [categoriasCliente, sugestoesClientes] = await Promise.all([
    carregarCategoriasAtivas(),
    pool.query("SELECT nome, telefone FROM clientes WHERE (nome IS NOT NULL AND nome <> '') OR (telefone IS NOT NULL AND telefone <> '') ORDER BY nome NULLS LAST, telefone NULLS LAST LIMIT 200"),
  ]);

  let matches = [];
  const temBaseSimulacao = filtros.cidade && filtros.tipo_imovel_desejado && (filtros.valor_minimo || filtros.valor_maximo);
  if (temBaseSimulacao) {
    matches = await buscarMatchesParaCliente(filtros, 20);
    if (filtros.possui_escritura) matches = matches.filter(({ imovel }) => String(imovel.possui_escritura) === String(filtros.possui_escritura === 'true'));
  }

  res.send(shell({
    title: 'Simular compatibilidade',
    subtitle: 'Selecione um cliente base, edite os campos e rode a simulação.',
    active: 'clientes',
    content: `
      <section class="card">
        <form method="get" action="/painel/clientes/simular-compatibilidade">
          <div class="search-blocks">
            <section class="search-block">
              <h3>Selecionar cliente base</h3>
              <div class="grid grid-3">
                <div><label>Nome</label><input name="nome" value="${esc(filtros.nome)}" placeholder="Nome do cliente" list="simular-clientes-nomes" autocomplete="off" /></div>
                <div><label>Telefone</label><input name="telefone" value="${filtros.telefone ? esc(formatarTelefone(filtros.telefone)) : ''}" placeholder="(51) 98035-7562" autocomplete="off" inputmode="numeric" oninput="let v=this.value.replace(/[^0-9]/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" /></div>
                <div style="display:flex; align-items:end;"><button type="submit" name="acao" value="puxar-cliente" class="btn-secondary" style="height:42px; white-space:nowrap;">Puxar dados do cliente</button></div>
              </div>
            </section>

            <section class="search-block">
              <h3>Dados do cliente</h3>
              <div class="grid">
                <div><label>Cidade</label><input id="simular-cidade" name="cidade" value="${esc(filtros.cidade)}" list="cidades-imoveis" autocomplete="off" /></div>
                <div><label>Bairro</label><input id="simular-bairro" name="bairro" value="${esc(filtros.bairro)}" list="bairros-imoveis" autocomplete="off" /></div>
                <div><label>Tipo de imóvel</label><select name="tipo_imovel_desejado"><option value="">Selecione</option>${categoriasCliente.rows.map((c) => `<option value="${esc(c.nome_exibicao)}" ${filtros.tipo_imovel_desejado === c.nome_exibicao ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
                <div><label>Estado do imóvel</label>${selectEstadoImovel('estado_imovel_desejado', filtros.estado_imovel_desejado, 'Tanto faz')}</div>
                <div><label>Valor mínimo</label><input name="valor_minimo" value="${esc(filtros.valor_minimo)}" placeholder="Ex.: 250.000,00" ${mascaraNumeroAttrs({ decimal: true, monetario: true })} /></div>
                <div><label>Valor máximo</label><input name="valor_maximo" value="${esc(filtros.valor_maximo)}" placeholder="Ex.: 500.000,00" ${mascaraNumeroAttrs({ decimal: true, monetario: true })} /></div>
                <div><label>Quartos</label><input name="numero_quartos_desejado" value="${esc(filtros.numero_quartos_desejado)}" /></div>
                <div><label>Banheiros</label><input name="numero_banheiros_desejado" value="${esc(filtros.numero_banheiros_desejado)}" /></div>
                <div><label>Vagas</label><input name="numero_vagas_garagem_desejada" value="${esc(filtros.numero_vagas_garagem_desejada)}" /></div>
                <div><label>Suítes</label><input name="numero_suites_desejada" value="${esc(filtros.numero_suites_desejada)}" /></div>
                <div><label>Proposta</label>${selectTipoPagamento(filtros.tipo_pagamento, 'Tanto faz')}</div>
                <div><label>Possui escritura</label>${selectSimNaoTantoFaz('possui_escritura', filtros.possui_escritura)}</div>
              </div>
            </section>
          </div>
          <div class="filters-actions">
            <button type="submit" name="acao" value="simular">Simular compatibilidade</button>
            <a href="/painel/clientes/simular-compatibilidade">Limpar</a>
            <a href="/painel/clientes">Voltar</a>
          </div>
        </form>
      </section>
      <section class="card">
        <h3>Resultado da simulação</h3>
        <div class="results-grid" style="margin-top:16px;">
          ${temBaseSimulacao ? (matches.length ? matches.map(({ imovel, score, motivos }) => `
            <article class="result-card">
              <h4>${esc(imovel.codigo)}${imovel.titulo ? ` · ${esc(imovel.titulo)}` : ''}</h4>
              <div class="filters-actions" style="margin-top:0;margin-bottom:12px;align-items:center;">
                <span class="match-badge ${score >= 75 ? 'match-alto' : score >= 60 ? 'match-medio' : 'match-baixo'}">${score}% compatível</span>
              </div>
              <div class="result-meta">
                <div><strong>Cidade</strong>${esc(imovel.cidade || '-')}</div>
                <div><strong>Bairro</strong>${esc(imovel.bairro || '-')}</div>
                <div><strong>Valor</strong>${money(imovel.valor)}</div>
                <div><strong>Tipo</strong>${esc(imovel.categoria_nome || imovel.categoria_slug || '-')}</div>
                <div><strong>Estado</strong>${esc(imovel.estado_imovel || '-')}</div>
                <div><strong>Escritura</strong>${boolTexto(imovel.possui_escritura)}</div>
              </div>
              <div class="card" style="margin-top:16px;padding:14px;">
                <strong>Motivos do match</strong>
                <p>${esc(motivos.join(', ') || 'Compatibilidade geral')}</p>
              </div>
              <div class="result-actions"><a class="btn-link" href="/painel/imoveis?codigo=${encodeURIComponent(imovel.codigo)}">Ver imóvel</a></div>
            </article>
          `).join('') : '<div class="empty">Nenhum imóvel compatível encontrado para essa simulação.</div>') : '<div class="empty">Preencha cidade, tipo de imóvel e valor para ver os resultados.</div>'}
        </div>
      </section>
      <datalist id="simular-clientes-nomes">${[...new Set(sugestoesClientes.rows.map((item) => String(item.nome || '').trim()).filter(Boolean))].map((nome) => `<option value="${esc(nome)}"></option>`).join('')}</datalist>
      ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      <script>
        function confirmarSenhaAcaoCliente(event, acao) {
          const senha = window.prompt('Digite a senha para ' + acao + ' o cliente:');
          if (!senha) return false;
          if (acao === 'excluir') {
            const confirmar = window.confirm('Confirma excluir este cliente?');
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
        document.addEventListener('DOMContentLoaded', () => {
          const form = document.querySelector('form[action="/painel/clientes/simular-compatibilidade"]');
          if (!form) return;
          const telefoneInput = document.getElementById('simular-telefone');
          const telefoneSugestoes = document.getElementById('simular-telefone-sugestoes');
          const sugestoesTelefoneData = ${JSON.stringify(sugestoesClientes.rows.map((item) => ({ nome: String(item.nome || '').trim(), telefone: String(item.telefone || '').trim() })).filter((item) => item.telefone || item.nome))};
          const renderTelefoneSugestoes = () => {
            if (!telefoneInput || !telefoneSugestoes) return;
            const q = String(telefoneInput.value || '').replace(/[^0-9]/g,'');
            const items = sugestoesTelefoneData.filter((item) => String(item.telefone || '').replace(/[^0-9]/g,'').includes(q) || String(item.nome || '').toLowerCase().includes(String(q || '').toLowerCase())).slice(0, 8);
            if (!q || !items.length) { telefoneSugestoes.style.display = 'none'; telefoneSugestoes.innerHTML = ''; return; }
            telefoneSugestoes.innerHTML = items.map((item) => '<button type="button" style="width:100%; text-align:left; padding:10px 12px; border:0; background:transparent; cursor:pointer; display:flex; flex-direction:column; gap:2px;">' +
              '<strong style="font-size:13px;">' + String(item.nome || 'Cliente sem nome').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</strong>' +
              '<span class="muted" style="font-size:12px;">' + String(item.telefone || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
            '</button>').join('');
            telefoneSugestoes.style.display = 'block';
            telefoneSugestoes.querySelectorAll('button').forEach((btn, index) => btn.addEventListener('click', () => { const item = items[index]; telefoneInput.value = item.telefone; telefoneSugestoes.style.display = 'none'; }));
          };
          if (telefoneInput && telefoneSugestoes) {
            telefoneInput.addEventListener('input', renderTelefoneSugestoes);
            telefoneInput.addEventListener('focus', renderTelefoneSugestoes);
            document.addEventListener('click', (event) => { if (!telefoneSugestoes.contains(event.target) && event.target !== telefoneInput) telefoneSugestoes.style.display = 'none'; });
          }
          form.addEventListener('submit', (event) => {
            const submitter = event.submitter;
            const nome = String(form.querySelector('input[name="nome"]')?.value || '').trim();
            const telefone = String(form.querySelector('input[name="telefone"]')?.value || '').trim();
            if (!nome && !telefone) {
              event.preventDefault();
              window.alert(submitter && submitter.value === 'puxar-cliente' ? 'Informe nome ou telefone para puxar os dados do cliente.' : 'Informe pelo menos nome ou telefone para simular a compatibilidade.');
            }
          });
        });
      </script>
    `,
  }));
});

app.get('/painel/clientes', auth, async (req, res) => {
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const filtros = {
    telefone: (req.query.telefone || '').trim(),
    nome: (req.query.nome || '').trim(),
    corretor: normalizarLeadBroker(req.query.corretor),
    tipo_imovel_desejado: (req.query.tipo_imovel_desejado || '').trim(),
    estado_imovel_desejado: (req.query.estado_imovel_desejado || '').trim(),
    numero_quartos_desejado: normalizarNumeroFormulario(req.query.numero_quartos_desejado || ''),
    numero_banheiros_desejado: normalizarNumeroFormulario(req.query.numero_banheiros_desejado || ''),
    numero_vagas_garagem_desejada: normalizarNumeroFormulario(req.query.numero_vagas_garagem_desejada || ''),
    numero_suites_desejada: normalizarNumeroFormulario(req.query.numero_suites_desejada || ''),
    cidade: (req.query.cidade || '').trim(),
    bairro: (req.query.bairro || '').trim(),
    valor_minimo: normalizarNumeroFormulario(req.query.valor_minimo || '', { decimal: true }),
    valor_maximo: normalizarNumeroFormulario(req.query.valor_maximo || '', { decimal: true }),
    tipo_pagamento: (req.query.tipo_pagamento || '').trim(),
  };
  const [categoriasCliente, sugestoesClientes] = await Promise.all([
    carregarCategoriasAtivas(),
    pool.query("SELECT nome, telefone FROM clientes WHERE (nome IS NOT NULL AND nome <> '') OR (telefone IS NOT NULL AND telefone <> '') ORDER BY nome NULLS LAST, telefone NULLS LAST LIMIT 200"),
  ]);

  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$X', `$${params.length}`)); };

  if (filtros.telefone) add('telefone ILIKE $X', `%${filtros.telefone}%`);
  if (filtros.nome) add('nome ILIKE $X', `%${filtros.nome}%`);
  if (filtros.corretor) add('corretor ILIKE $X', `%${filtros.corretor}%`);
  if (filtros.tipo_imovel_desejado) add('tipo_imovel_desejado ILIKE $X', `%${filtros.tipo_imovel_desejado}%`);
  if (filtros.estado_imovel_desejado) add('estado_imovel_desejado = $X', filtros.estado_imovel_desejado);
  if (filtros.numero_quartos_desejado) add('numero_quartos_desejado = $X::int', filtros.numero_quartos_desejado);
  if (filtros.numero_banheiros_desejado) add('numero_banheiros_desejado = $X::int', filtros.numero_banheiros_desejado);
  if (filtros.numero_vagas_garagem_desejada) add('numero_vagas_garagem_desejada = $X::int', filtros.numero_vagas_garagem_desejada);
  if (filtros.numero_suites_desejada) add('numero_suites_desejada = $X::int', filtros.numero_suites_desejada);
  if (filtros.cidade) add('cidade ILIKE $X', `%${filtros.cidade}%`);
  if (filtros.bairro) add('bairro ILIKE $X', `%${filtros.bairro}%`);
  if (filtros.valor_minimo) add('(valor_maximo IS NULL OR valor_maximo >= $X::numeric)', filtros.valor_minimo);
  if (filtros.valor_maximo) add('(valor_minimo IS NULL OR valor_minimo <= $X::numeric)', filtros.valor_maximo);
  if (filtros.tipo_pagamento) add('tipo_pagamento ILIKE $X', `%${filtros.tipo_pagamento}%`);

  const temFiltros = Object.values(filtros).some((value) => value);
  const result = temFiltros
    ? await pool.query(`SELECT * FROM clientes WHERE ${where.join(' AND ')} ORDER BY data_cadastro DESC, id DESC LIMIT 100`, params)
    : { rows: [] };

  const rows = (await Promise.all(result.rows.map(async (item) => {
    const matches = await buscarMatchesParaCliente(item, 100);
    const matchCount = matches.length;
    const matchText = matchCount > 0
      ? `<a href="/painel/oportunidades?nome=${encodeURIComponent(item.nome || '')}&telefone=${encodeURIComponent(item.telefone || '')}&cidade=${encodeURIComponent(item.cidade || '')}&bairro=${encodeURIComponent(item.bairro || '')}&tipo_imovel_desejado=${encodeURIComponent(item.tipo_imovel_desejado || '')}&estado_imovel_desejado=${encodeURIComponent(item.estado_imovel_desejado || '')}&numero_quartos_desejado=${encodeURIComponent(item.numero_quartos_desejado ?? '')}&numero_banheiros_desejado=${encodeURIComponent(item.numero_banheiros_desejado ?? '')}&numero_vagas_garagem_desejada=${encodeURIComponent(item.numero_vagas_garagem_desejada ?? '')}&numero_suites_desejada=${encodeURIComponent(item.numero_suites_desejada ?? '')}&valor_minimo=${encodeURIComponent(item.valor_minimo ?? '')}&valor_maximo=${encodeURIComponent(item.valor_maximo ?? '')}&tipo_pagamento=${encodeURIComponent(item.tipo_pagamento || '')}" class="link-destaque">${matchCount} imóveis compatíveis com esse cliente</a>`
      : '<span class="muted">Nenhum imóvel compatível com esse cliente no momento.</span>';
    return `
    <article class="result-card">
      <h4>${esc(item.nome || 'Cliente sem nome')}</h4>
      <div class="card" style="margin-bottom:16px;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;">
        ${matchText}
      </div>
      <div class="result-meta">
        <div><strong>Telefone</strong>${esc(formatarTelefone(item.telefone))}</div>
        <div><strong>${esc(getLeadBrokerLabel())}</strong>${esc(item.corretor || '-')}</div>
        <div><strong>${esc(getLeadAttendantLabel())}</strong>${esc(item.atendente || '-')}</div>
        <div><strong>Tipo desejado</strong>${esc(item.tipo_imovel_desejado || '-')}</div>
        <div><strong>Estado desejado</strong>${esc(item.estado_imovel_desejado || '-')}</div>
        <div><strong>N° quartos</strong>${item.numero_quartos_desejado ?? '-'}</div>
        <div><strong>N° banheiros</strong>${item.numero_banheiros_desejado ?? '-'}</div>
        <div><strong>Vaga garagem</strong>${item.numero_vagas_garagem_desejada ?? '-'}</div>
        <div><strong>N° suit</strong>${item.numero_suites_desejada ?? '-'}</div>
        <div><strong>Cidade</strong>${esc(item.cidade || '-')}</div>
        <div><strong>Bairro</strong>${esc(item.bairro || '-')}</div>
        <div><strong>Valor mínimo</strong>${money(item.valor_minimo)}</div>
        <div><strong>Valor máximo</strong>${money(item.valor_maximo)}</div>
        <div><strong>Proposta</strong>${esc(item.tipo_pagamento || '-')}</div>
        <div><strong>Data cadastro</strong>${formatarDataPtBr(item.data_cadastro)}</div>
      </div>
      <div class="card" style="margin-top:16px;padding:14px;">
        <strong>Interesse</strong>
        <p>${esc(item.interesse || '-')}</p>
        <strong style="margin-top:12px;">Resumo atendimento</strong>
        <p>${esc(item.resumo_atendimento || '-')}</p>
      </div>
      <div class="result-actions">
        <a href="/painel/clientes-pdf/${item.id}"><button type="button">Baixar PDF cliente</button></a>
        <a href="/painel/clientes/simular-compatibilidade?nome=${encodeURIComponent(item.nome || '')}&telefone=${encodeURIComponent(item.telefone || '')}"><button type="button" class="btn-secondary">Simular compatibilidade</button></a>
        <form method="post" action="/painel/clientes-editar-senha/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCliente(event, 'editar')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-secondary">Editar cliente</button>
        </form>
        <form method="post" action="/painel/clientes-excluir/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcaoCliente(event, 'excluir')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-danger">Excluir cliente</button>
        </form>
      </div>
    </article>
  `;
  }))).join('');

  res.send(shell({
    title: 'Pesquisar clientes',
    subtitle: 'Busca de clientes em módulo separado do fluxo de imóveis.',
    active: 'clientes',
    content: `
      <section class="card">
        <form method="get" action="/painel/clientes">
          <div class="search-blocks">
            <section class="search-block">
              <h3>Dados do cliente</h3>
              <div class="grid grid-3">
                <div><label>Nome</label><input name="nome" value="${esc(filtros.nome)}" placeholder="Nome do cliente" list="simular-clientes-nomes" autocomplete="off" /></div>
                <div style="position:relative; display:grid; grid-template-columns:1fr auto; gap:10px; align-items:end;">
                  <div style="position:relative;">
                    <label>Telefone</label>
                    <input id="simular-telefone" name="telefone" value="${filtros.telefone ? esc(formatarTelefone(filtros.telefone)) : ''}" placeholder="(51) 98035-7562" autocomplete="off" inputmode="numeric" oninput="let v=this.value.replace(/[^0-9]/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') ' + v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') ' + v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') ' + v.slice(2)):v;" />
                    <div id="simular-telefone-sugestoes" style="position:absolute; z-index:10; left:0; right:0; top:100%; margin-top:6px; background:#fff; border:1px solid #dbe3ee; border-radius:12px; box-shadow:0 10px 25px rgba(15,23,42,.08); display:none; max-height:240px; overflow:auto;"></div>
                  </div>
                </div>
                <div></div>
              </div>
            </section>
          </div>
          <div class="filters-actions">
            <button type="submit" name="acao" value="buscar">Pesquisar cliente selecionado</button>
            <a href="/painel/clientes">Limpar</a>
          </div>
        </form>
      </section>
      <section class="card">
        <h3>Resultados</h3>
        <div class="results-grid">
          ${rows || '<div class="empty">Nenhum cliente encontrado.</div>'}
        </div>
      </section>
      <datalist id="simular-clientes-nomes">${[...new Set(sugestoesClientes.rows.map((item) => String(item.nome || '').trim()).filter(Boolean))].map((nome) => `<option value="${esc(nome)}"></option>`).join('')}</datalist>
      ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      <script>
        function confirmarSenhaAcaoCliente(event, acao) {
          const senha = window.prompt('Digite a senha para ' + acao + ' o cliente:');
          if (!senha) return false;
          if (acao === 'excluir') {
            const confirmar = window.confirm('Confirma excluir este cliente?');
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
        document.addEventListener('DOMContentLoaded', () => {
          const form = document.querySelector('form[action="/painel/clientes/simular-compatibilidade"]');
          if (!form) return;
          form.addEventListener('submit', (event) => {
            const submitter = event.submitter;
            const nome = String(form.querySelector('input[name="nome"]')?.value || '').trim();
            const telefone = String(form.querySelector('input[name="telefone"]')?.value || '').trim();
            if (!nome && !telefone) {
              event.preventDefault();
              window.alert(submitter && submitter.value === 'puxar-cliente'
                ? 'Informe nome ou telefone para puxar os dados do cliente.'
                : 'Informe pelo menos nome ou telefone para simular a compatibilidade.');
              return;
            }
          });
        });
      </script>
      ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      <script>
        document.addEventListener('DOMContentLoaded', () => {
          const cidadeInput = document.getElementById('simular-cidade');

          const telefoneInput = document.getElementById('simular-telefone');
          const telefoneSugestoes = document.getElementById('simular-telefone-sugestoes');
          const sugestoesTelefoneData = ${JSON.stringify(sugestoesClientes.rows.map((item) => ({ nome: String(item.nome || '').trim(), telefone: String(item.telefone || '').trim() })).filter((item) => item.telefone || item.nome))};
          const renderTelefoneSugestoes = () => {
            if (!telefoneInput || !telefoneSugestoes) return;
            const q = String(telefoneInput.value || '').replace(/[^0-9]/g,'');
            const items = sugestoesTelefoneData.filter((item) => String(item.telefone || '').replace(/[^0-9]/g,'').includes(q) || String(item.nome || '').toLowerCase().includes(String(q || '').toLowerCase())).slice(0, 8);
            if (!q || !items.length) {
              telefoneSugestoes.style.display = 'none';
              telefoneSugestoes.innerHTML = '';
              return;
            }
            telefoneSugestoes.innerHTML = items.map((item) => '<button type="button" style="width:100%; text-align:left; padding:10px 12px; border:0; background:transparent; cursor:pointer; display:flex; flex-direction:column; gap:2px;">' +
              '<strong style="font-size:13px;">' + String(item.nome || 'Cliente sem nome').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</strong>' +
              '<span class="muted" style="font-size:12px;">' + String(item.telefone || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
            '</button>').join('');
            telefoneSugestoes.style.display = 'block';
            telefoneSugestoes.querySelectorAll('button').forEach((btn, index) => {
              btn.addEventListener('click', () => {
                const item = items[index];
                telefoneInput.value = item.telefone;
                telefoneSugestoes.style.display = 'none';
              });
            });
          };
          if (telefoneInput && telefoneSugestoes) {
            telefoneInput.addEventListener('input', renderTelefoneSugestoes);
            telefoneInput.addEventListener('focus', renderTelefoneSugestoes);
            document.addEventListener('click', (event) => {
              if (!telefoneSugestoes.contains(event.target) && event.target !== telefoneInput) telefoneSugestoes.style.display = 'none';
            });
          }
          const bairroInput = document.getElementById('simular-bairro');
          const bairrosList = document.getElementById('bairros-imoveis');
          const bairrosPorCidade = ${JSON.stringify(bairrosPorCidade)};

          const renderBairros = () => {
            if (!cidadeInput || !bairroInput || !bairrosList) return;
            const cidade = String(cidadeInput.value || '').trim();
            const bairros = bairrosPorCidade[cidade] || [];
            bairrosList.innerHTML = bairros.map((bairro) => '<option value="' + String(bairro).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"></option>').join('');
          };

          if (cidadeInput && bairroInput && bairrosList) {
            cidadeInput.addEventListener('input', renderBairros);
            cidadeInput.addEventListener('change', renderBairros);
            renderBairros();
          }
        });
      </script>
    `,
  }));
});

app.get('/painel/clientes/novo', auth, async (req, res) => {
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const v = clienteFormValores(req.query);
  const categoriasCliente = await carregarCategoriasAtivas();
  res.send(shell({
    title: 'Cadastrar cliente',
    subtitle: 'Cadastro operacional separado do módulo de imóveis.',
    active: 'novo-cliente',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/clientes/novo" data-validate-numeric="true">
          <div id="cliente-match-preview" class="card" style="margin-bottom:16px;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;">
            <span id="cliente-match-preview-text" class="muted">Preencha cidade, tipo de imóvel e faixa de valor para ver imóveis compatíveis.</span>
          </div>
          <div class="grid">
            <div><label>Telefone</label><input name="telefone" value="${v.telefone ? esc(formatarTelefone(v.telefone)) : ""}" placeholder="(51) 98035-7562" inputmode="numeric" oninput="let v=this.value.replace(/\\D/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" required /></div>
            <div><label>Nome</label><input name="nome" value="${esc(v.nome)}" /></div>
            <div><label>${esc(getLeadBrokerLabel())}</label><input name="corretor" value="${esc(v.corretor)}" /></div>
            <div><label>${esc(getLeadAttendantLabel())}</label><input name="atendente" value="${esc(v.atendente)}" /></div>
            <div><label>Tipo imóvel desejado</label><select name="tipo_imovel_desejado"><option value="">Selecione</option>${categoriasCliente.rows.map((c) => `<option value="${esc(c.nome_exibicao)}" ${v.tipo_imovel_desejado === c.nome_exibicao ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
            <div><label>Estado imóvel desejado</label>${selectEstadoImovel('estado_imovel_desejado', v.estado_imovel_desejado)}</div>
            <div><label for="numero_quartos_desejado">N° de quartos</label><input id="numero_quartos_desejado" name="numero_quartos_desejado" type="text" data-numero="inteiro" value="${esc(v.numero_quartos_desejado)}" /></div>
            <div><label for="numero_banheiros_desejado">N° banheiro</label><input id="numero_banheiros_desejado" name="numero_banheiros_desejado" type="text" data-numero="inteiro" value="${esc(v.numero_banheiros_desejado)}" /></div>
            <div><label for="numero_vagas_garagem_desejada">Vaga garagem</label><input id="numero_vagas_garagem_desejada" name="numero_vagas_garagem_desejada" type="text" data-numero="inteiro" value="${esc(v.numero_vagas_garagem_desejada)}" /></div>
            <div><label for="numero_suites_desejada">N° suit</label><input id="numero_suites_desejada" name="numero_suites_desejada" type="text" data-numero="inteiro" value="${esc(v.numero_suites_desejada)}" /></div>
            <div><label for="valor_minimo">Valor mínimo</label><input id="valor_minimo" name="valor_minimo" type="text" data-numero="decimal" data-monetario="true" value="${esc(v.valor_minimo)}" /></div>
            <div><label for="valor_maximo">Valor máximo</label><input id="valor_maximo" name="valor_maximo" type="text" data-numero="decimal" data-monetario="true" value="${esc(v.valor_maximo)}" /></div>
            <div><label>Cidade de interesse</label><input name="cidade" value="${esc(v.cidade)}" list="cidades-imoveis" autocomplete="off" /></div>
            <div><label>Bairro de interesse</label><input name="bairro" value="${esc(v.bairro)}" list="bairros-imoveis" autocomplete="off" /></div>
            <div><label>Tipo pagamento</label>${selectTipoPagamento(v.tipo_pagamento)}</div>
            <div class="field-full"><label>Resumo atendimento</label><textarea name="resumo_atendimento">${esc(v.resumo_atendimento)}</textarea></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Cadastrar cliente</button>
            <a href="/painel/clientes"><button type="button" class="btn-secondary">Cancelar</button></a>
          </div>
        </form>
        ${renderLocationDatalists({ cidades, bairrosPorCidade })}
        <script>
          document.addEventListener('DOMContentLoaded', () => {
            const form = document.querySelector('form[action="/painel/clientes/novo"]');
            const previewText = document.getElementById('cliente-match-preview-text');
            if (!form || !previewText) return;

            const updatePreview = async () => {
              const data = new URLSearchParams(new FormData(form));
              const cidade = String(data.get('cidade') || '').trim();
              const tipo = String(data.get('tipo_imovel_desejado') || '').trim();
              const min = String(data.get('valor_minimo') || '').trim();
              const max = String(data.get('valor_maximo') || '').trim();
              if (!cidade || !tipo || (!min && !max)) {
                previewText.className = 'muted';
                previewText.innerHTML = 'Preencha cidade, tipo de imóvel e faixa de valor para ver imóveis compatíveis.';
                return;
              }
              previewText.className = 'muted';
              previewText.textContent = 'Buscando imóveis compatíveis...';
              try {
                const resp = await fetch('/painel/clientes/novo/matches-count?' + data.toString());
                const json = await resp.json();
                if (json.total > 0) {
                  previewText.className = 'link-destaque';
                  previewText.innerHTML = '<a href="' + json.url + '" class="link-destaque">' + json.total + ' imóveis compatíveis com esse cliente</a>';
                } else {
                  previewText.className = 'muted';
                  previewText.textContent = 'Nenhum imóvel compatível com esse cliente no momento.';
                }
              } catch {
                previewText.className = 'muted';
                previewText.textContent = 'Não foi possível carregar a prévia de compatibilidade agora.';
              }
            };

            form.querySelectorAll('input, select, textarea').forEach((el) => {
              el.addEventListener('change', updatePreview);
              el.addEventListener('input', updatePreview);
            });
            updatePreview();
          });
        </script>
      </section>
    `,
  }));
});


app.get('/painel/clientes/novo/matches-count', auth, async (req, res) => {
  try {
    const cliente = montarClientePreviewMatch(req.query);
    if (!cliente.cidade || !cliente.tipo_imovel_desejado || (!cliente.valor_minimo && !cliente.valor_maximo)) {
      return res.json({ total: 0, url: '' });
    }
    const matches = await buscarMatchesParaCliente(cliente, 100);
    const qs = new URLSearchParams({
      nome: cliente.nome || '',
      telefone: cliente.telefone || '',
      cidade: cliente.cidade || '',
      bairro: cliente.bairro || '',
      tipo_imovel_desejado: cliente.tipo_imovel_desejado || '',
      estado_imovel_desejado: cliente.estado_imovel_desejado || '',
      numero_quartos_desejado: cliente.numero_quartos_desejado || '',
      numero_banheiros_desejado: cliente.numero_banheiros_desejado || '',
      numero_vagas_garagem_desejada: cliente.numero_vagas_garagem_desejada || '',
      numero_suites_desejada: cliente.numero_suites_desejada || '',
      valor_minimo: cliente.valor_minimo || '',
      valor_maximo: cliente.valor_maximo || '',
      tipo_pagamento: cliente.tipo_pagamento || '',
    }).toString();
    return res.json({ total: matches.length, url: `/painel/oportunidades?${qs}` });
  } catch (error) {
    return res.status(500).json({ total: 0, url: '', error: error.message });
  }
});

app.post('/painel/clientes/novo', auth, async (req, res) => {
  const b = clienteFormValores(req.body);
  const campoNumericoInvalido = validarNumerosFormulario(b, ['numero_quartos_desejado', 'numero_banheiros_desejado', 'numero_vagas_garagem_desejada', 'numero_suites_desejada', 'valor_minimo', 'valor_maximo']);
  if (campoNumericoInvalido) {
    const qs = new URLSearchParams({ ...b, erro: `Preencha o campo ${campoNumericoInvalido} apenas com números.` }).toString();
    return res.redirect(`/painel/clientes/novo?${qs}`);
  }
  try {
    await pool.query(`INSERT INTO clientes (telefone, nome, corretor, atendente, interesse, tipo_imovel_desejado, estado_imovel_desejado, numero_quartos_desejado, numero_banheiros_desejado, numero_vagas_garagem_desejada, numero_suites_desejada, valor_minimo, valor_maximo, cidade, bairro, tipo_pagamento, resumo_atendimento) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::int,NULLIF($9,'')::int,NULLIF($10,'')::int,NULLIF($11,'')::int,NULLIF($12,'')::numeric,NULLIF($13,'')::numeric,$14,$15,$16,$17)`, [normalizarTelefone(b.telefone), b.nome, b.corretor, b.atendente, b.interesse, b.tipo_imovel_desejado, b.estado_imovel_desejado, normalizarNumeroFormulario(b.numero_quartos_desejado), normalizarNumeroFormulario(b.numero_banheiros_desejado), normalizarNumeroFormulario(b.numero_vagas_garagem_desejada), normalizarNumeroFormulario(b.numero_suites_desejada), normalizarNumeroFormulario(b.valor_minimo, { decimal: true }), normalizarNumeroFormulario(b.valor_maximo, { decimal: true }), b.cidade, b.bairro, b.tipo_pagamento || null, b.resumo_atendimento]);
    res.redirect('/painel/clientes');
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe cliente cadastrado com este telefone.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    res.redirect(`/painel/clientes/novo?${qs}`);
  }
});

app.get('/painel/clientes-pdf/:id', auth, async (req, res) => {
  try {
    const buffer = await gerarPdfCliente(req.params.id);
    return jsonResponseDownload(res, exportFilename(`cliente_${req.params.id}`, 'pdf'), 'application/pdf', buffer);
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

app.post('/painel/clientes-editar-senha/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  res.redirect(`/painel/clientes-editar/${req.params.id}?senha=${encodeURIComponent(req.body.senha)}`);
});

app.get('/painel/clientes-editar/:id', auth, async (req, res) => {
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).send('Cliente não encontrado');
  const categoriasCliente = await carregarCategoriasAtivas();
  const item = { ...result.rows[0], ...req.query };
  const v = clienteFormValores(item);
  res.send(shell({
    title: `Editar cliente ${item.nome || item.telefone}`,
    subtitle: 'Edição de cliente em página própria do módulo de clientes.',
    active: 'clientes',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/clientes-salvar/${item.id}?senha=${encodeURIComponent(req.query.senha || '')}" data-validate-numeric="true">
          <div class="grid">
            <div><label>Telefone</label><input name="telefone" value="${v.telefone ? esc(formatarTelefone(v.telefone)) : ""}" placeholder="(51) 98035-7562" inputmode="numeric" oninput="let v=this.value.replace(/\\D/g,'').slice(0,11);this.value=v.length>10?('('+v.slice(0,2)+') '+v.slice(2,7)+(v.length>7?'-'+v.slice(7):'')):v.length>6?('('+v.slice(0,2)+') '+v.slice(2,6)+(v.length>6?'-'+v.slice(6):'')):v.length>2?('('+v.slice(0,2)+') '+v.slice(2)):v;" required /></div>
            <div><label>Nome</label><input name="nome" value="${esc(v.nome)}" /></div>
            <div><label>${esc(getLeadBrokerLabel())}</label><input name="corretor" value="${esc(v.corretor)}" /></div>
            <div><label>${esc(getLeadAttendantLabel())}</label><input name="atendente" value="${esc(v.atendente)}" /></div>
            <div><label>Tipo imóvel desejado</label><select name="tipo_imovel_desejado"><option value="">Selecione</option>${categoriasCliente.rows.map((c) => `<option value="${esc(c.nome_exibicao)}" ${v.tipo_imovel_desejado === c.nome_exibicao ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
            <div><label>Estado imóvel desejado</label>${selectEstadoImovel('estado_imovel_desejado', v.estado_imovel_desejado)}</div>
            <div><label for="numero_quartos_desejado">N° de quartos</label><input id="numero_quartos_desejado" name="numero_quartos_desejado" type="text" data-numero="inteiro" value="${esc(v.numero_quartos_desejado)}" /></div>
            <div><label for="numero_banheiros_desejado">N° banheiro</label><input id="numero_banheiros_desejado" name="numero_banheiros_desejado" type="text" data-numero="inteiro" value="${esc(v.numero_banheiros_desejado)}" /></div>
            <div><label for="numero_vagas_garagem_desejada">Vaga garagem</label><input id="numero_vagas_garagem_desejada" name="numero_vagas_garagem_desejada" type="text" data-numero="inteiro" value="${esc(v.numero_vagas_garagem_desejada)}" /></div>
            <div><label for="numero_suites_desejada">N° suit</label><input id="numero_suites_desejada" name="numero_suites_desejada" type="text" data-numero="inteiro" value="${esc(v.numero_suites_desejada)}" /></div>
            <div><label for="valor_minimo">Valor mínimo</label><input id="valor_minimo" name="valor_minimo" type="text" data-numero="decimal" data-monetario="true" value="${esc(v.valor_minimo)}" /></div>
            <div><label for="valor_maximo">Valor máximo</label><input id="valor_maximo" name="valor_maximo" type="text" data-numero="decimal" data-monetario="true" value="${esc(v.valor_maximo)}" /></div>
            <div><label>Cidade</label><input name="cidade" value="${esc(v.cidade)}" list="cidades-imoveis" autocomplete="off" /></div>
            <div><label>Bairro</label><input name="bairro" value="${esc(v.bairro)}" list="bairros-imoveis" autocomplete="off" /></div>
            <div><label>Tipo pagamento</label>${selectTipoPagamento(v.tipo_pagamento)}</div>
            <div class="field-full"><label>Resumo atendimento</label><textarea name="resumo_atendimento">${esc(v.resumo_atendimento)}</textarea></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Salvar cliente</button>
            <a href="/painel/clientes"><button type="button" class="btn-secondary">Cancelar</button></a>
          </div>
        </form>
        ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      </section>
    `,
  }));
});

app.post('/painel/clientes-salvar/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha || req.body.senha)) return res.status(403).send('Senha inválida');
  const b = clienteFormValores(req.body);
  const campoNumericoInvalido = validarNumerosFormulario(b, ['numero_quartos_desejado', 'numero_banheiros_desejado', 'numero_vagas_garagem_desejada', 'numero_suites_desejada', 'valor_minimo', 'valor_maximo']);
  if (campoNumericoInvalido) {
    const qs = new URLSearchParams({ ...b, erro: `Preencha o campo ${campoNumericoInvalido} apenas com números.` }).toString();
    return res.redirect(`/painel/clientes-editar/${req.params.id}?${qs}`);
  }
  try {
    await pool.query(`UPDATE clientes SET telefone = $2, nome = $3, corretor = $4, atendente = $5, interesse = $6, tipo_imovel_desejado = $7, estado_imovel_desejado = $8, numero_quartos_desejado = NULLIF($9,'')::int, numero_banheiros_desejado = NULLIF($10,'')::int, numero_vagas_garagem_desejada = NULLIF($11,'')::int, numero_suites_desejada = NULLIF($12,'')::int, valor_minimo = NULLIF($13,'')::numeric, valor_maximo = NULLIF($14,'')::numeric, cidade = $15, bairro = $16, tipo_pagamento = $17, resumo_atendimento = $18, data_atualizacao = now() WHERE id = $1`, [req.params.id, normalizarTelefone(b.telefone), b.nome, b.corretor, b.atendente, b.interesse, b.tipo_imovel_desejado, b.estado_imovel_desejado, normalizarNumeroFormulario(b.numero_quartos_desejado), normalizarNumeroFormulario(b.numero_banheiros_desejado), normalizarNumeroFormulario(b.numero_vagas_garagem_desejada), normalizarNumeroFormulario(b.numero_suites_desejada), normalizarNumeroFormulario(b.valor_minimo, { decimal: true }), normalizarNumeroFormulario(b.valor_maximo, { decimal: true }), b.cidade, b.bairro, b.tipo_pagamento || null, b.resumo_atendimento]);
    res.redirect('/painel/clientes');
  } catch (error) {
    const mensagem = error.code === '23505' ? 'Já existe cliente cadastrado com este telefone.' : error.message;
    const qs = new URLSearchParams({ ...b, erro: mensagem }).toString();
    res.redirect(`/painel/clientes-editar/${req.params.id}?${qs}`);
  }
});

app.post('/painel/clientes-excluir/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
  res.redirect('/painel/clientes');
});

app.get('/painel/imoveis', async (req, res) => {
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const filtros = {
    codigo: (req.query.codigo || '').trim(),
    cidade: (req.query.cidade || '').trim(),
    bairro: (req.query.bairro || '').trim(),
    valor_min: normalizarNumeroFormulario(req.query.valor_min || '', { decimal: true }),
    valor_max: normalizarNumeroFormulario(req.query.valor_max || '', { decimal: true }),
    area_total_min: normalizarNumeroFormulario(req.query.area_total_min || '', { decimal: true }),
    area_total_max: normalizarNumeroFormulario(req.query.area_total_max || '', { decimal: true }),
    area_construida_min: normalizarNumeroFormulario(req.query.area_construida_min || '', { decimal: true }),
    area_construida_max: normalizarNumeroFormulario(req.query.area_construida_max || '', { decimal: true }),
    frente_min: normalizarNumeroFormulario(req.query.frente_min || '', { decimal: true }),
    frente_max: normalizarNumeroFormulario(req.query.frente_max || '', { decimal: true }),
    fundos_min: normalizarNumeroFormulario(req.query.fundos_min || '', { decimal: true }),
    fundos_max: normalizarNumeroFormulario(req.query.fundos_max || '', { decimal: true }),
    dormitorios: normalizarNumeroFormulario(req.query.dormitorios || ''),
    suites: normalizarNumeroFormulario(req.query.suites || ''),
    banheiros: normalizarNumeroFormulario(req.query.banheiros || ''),
    vagas: normalizarNumeroFormulario(req.query.vagas || ''),
    posicao_solar: (req.query.posicao_solar || '').trim(),
    andar: normalizarNumeroFormulario(req.query.andar || ''),
    estado_imovel: (req.query.estado_imovel || '').trim(),
    categoria_slug: (req.query.categoria_slug || '').trim(),
  };

  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$X', `$${params.length}`)); };

  if (filtros.codigo) add('codigo ILIKE $X', `%${filtros.codigo}%`);
  if (filtros.cidade) add('cidade ILIKE $X', `%${filtros.cidade}%`);
  if (filtros.bairro) add('bairro ILIKE $X', `%${filtros.bairro}%`);
  if (filtros.valor_min) add('valor >= $X::numeric', filtros.valor_min);
  if (filtros.valor_max) add('valor <= $X::numeric', filtros.valor_max);
  if (filtros.area_total_min) add('area_total_m2 >= $X::numeric', filtros.area_total_min);
  if (filtros.area_total_max) add('area_total_m2 <= $X::numeric', filtros.area_total_max);
  if (filtros.area_construida_min) add('area_construida_m2 >= $X::numeric', filtros.area_construida_min);
  if (filtros.area_construida_max) add('area_construida_m2 <= $X::numeric', filtros.area_construida_max);
  if (filtros.frente_min) add('dimensao_frente_m >= $X::numeric', filtros.frente_min);
  if (filtros.frente_max) add('dimensao_frente_m <= $X::numeric', filtros.frente_max);
  if (filtros.fundos_min) add('dimensao_fundos_m >= $X::numeric', filtros.fundos_min);
  if (filtros.fundos_max) add('dimensao_fundos_m <= $X::numeric', filtros.fundos_max);
  if (filtros.dormitorios) add('numero_dormitorios = $X::int', filtros.dormitorios);
  if (filtros.suites) add('numero_suites = $X::int', filtros.suites);
  if (filtros.banheiros) add('numero_banheiros = $X::int', filtros.banheiros);
  if (filtros.vagas) add('numero_vagas_garagem = $X::int', filtros.vagas);
  if (filtros.posicao_solar) add('posicao_solar ILIKE $X', `%${filtros.posicao_solar}%`);
  if (filtros.andar) add('andar = $X::int', filtros.andar);
  if (filtros.estado_imovel) add('estado_imovel = $X', filtros.estado_imovel);
  if (filtros.categoria_slug) add('categoria_slug = $X', filtros.categoria_slug);

  const categorias = await carregarCategoriasAtivas();
  const temFiltros = Object.values(filtros).some((value) => String(value || '').trim() !== '');
  const result = temFiltros
    ? await pool.query(`SELECT i.id, i.codigo, i.titulo, i.categoria_slug, i.descricao, i.cidade, i.bairro, i.valor, i.area_total_m2, i.area_construida_m2, i.dimensao_frente_m, i.dimensao_fundos_m, i.numero_dormitorios, i.numero_suites, i.numero_banheiros, i.numero_vagas_garagem, i.posicao_solar, i.andar, i.estado_imovel, i.created_at,
          COALESCE((
            SELECT json_agg(json_build_object('url', f.url_publica, 'ordem', f.ordem) ORDER BY f.ordem)
            FROM imovel_fotos f
            WHERE f.imovel_id = i.id
          ), '[]'::json) AS fotos
        FROM imoveis i
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT 100`, params)
    : { rows: [] };

  const clientesBaseMatch = await pool.query('SELECT * FROM clientes ORDER BY data_cadastro DESC, id DESC LIMIT 300');
  const rows = (await Promise.all(result.rows.map(async (item) => {
    const matchClientes = [];
    for (const cliente of clientesBaseMatch.rows) {
      const match = calcularCompatibilidade(item, cliente);
      if (match.score >= MATCH_RULES.scoreMinimo) matchClientes.push(cliente);
    }
    const matchCount = matchClientes.length;
    const matchText = matchCount > 0
      ? `<a href="/painel/clientes?telefone=${encodeURIComponent(matchClientes[0].telefone || '')}" class="link-destaque">${matchCount} clientes compatíveis com esse imóvel</a>`
      : '<span class="muted">Nenhum cliente compatível com esse imóvel no momento.</span>';
    return `
    <article class="result-card">
      <h4>${esc(item.codigo)}</h4>
      <div class="card" style="margin-bottom:16px;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;">
        ${matchText}
      </div>
      <div class="result-meta">
        <div><strong>Cidade</strong>${esc(item.cidade || '-')}</div>
        <div><strong>Bairro</strong>${esc(item.bairro || '-')}</div>
        <div><strong>Valor</strong>${money(item.valor)}</div>
        <div><strong>Área total</strong>${item.area_total_m2 ?? '-'}</div>
        <div><strong>Área construída</strong>${item.area_construida_m2 ?? '-'}</div>
        <div><strong>Frente</strong>${item.dimensao_frente_m ?? '-'}</div>
        <div><strong>Fundos</strong>${item.dimensao_fundos_m ?? '-'}</div>
        <div><strong>Dormitórios</strong>${item.numero_dormitorios ?? '-'}</div>
        <div><strong>Suítes</strong>${item.numero_suites ?? '-'}</div>
        <div><strong>Banheiros</strong>${item.numero_banheiros ?? '-'}</div>
        <div><strong>Vagas</strong>${item.numero_vagas_garagem ?? '-'}</div>
        <div><strong>Posição solar</strong>${esc(item.posicao_solar || '-')}</div>
        <div><strong>Andar</strong>${item.andar ?? '-'}</div>
        <div><strong>Estado imóvel</strong>${esc(item.estado_imovel || '-')}</div>
        <div><strong>Cadastro</strong>${new Date(item.created_at).toLocaleDateString('pt-BR')}</div>
      </div>
      <div class="card" style="margin-top:16px;padding:14px;">
        <strong>Descrição do imóvel</strong>
        <p>${esc(item.descricao || '-')}</p>
      </div>
      <div class="result-actions">
        <a href="/painel/imoveis-galeria/${item.id}?returnTo=${encodeURIComponent(`/painel/imoveis?codigo=${item.codigo}`)}"><button type="button">Ver imagens</button></a>
        <button type="button" class="btn-secondary" onclick="copiarLinkGaleriaPublica('${esc(item.galeria_imagem || montarLinkGaleriaImovel(item.codigo))}')">Copiar link da galeria</button>
        <a href="/painel/imoveis-pdf/${item.id}?tipo=comercial&returnTo=${encodeURIComponent(`/painel/imoveis?codigo=${item.codigo}`)}"><button type="button">PDF comercial</button></a>
        <button type="button" class="btn-secondary" onclick="abrirPdfCompletoImovel('/painel/imoveis-pdf/${item.id}?tipo=completo&returnTo=${encodeURIComponent(`/painel/imoveis?codigo=${item.codigo}`)}')">PDF completo</button>
        <form method="post" action="/painel/imoveis-editar-senha/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcao(event, 'editar')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-secondary">Editar imóvel</button>
        </form>
        <form method="post" action="/painel/imoveis-excluir/${item.id}" class="inline-form" onsubmit="return confirmarSenhaAcao(event, 'excluir')">
          <input type="hidden" name="senha" value="" />
          <button type="submit" class="btn-danger">Excluir imóvel</button>
        </form>
      </div>
    </article>
  `;
  }))).join('');

  res.send(shell({
    title: 'Pesquisar imóveis',
    subtitle: 'Filtros básicos do painel, separado do formulário público.',
    active: 'imoveis',
    content: `
      <section class="card">
        <form method="get" action="/painel/imoveis">
          <div class="grid">
            <div><label>Código</label><input name="codigo" value="${esc(filtros.codigo)}" placeholder="Ex.: CA0001" /></div>
            <div><label>Categoria</label><select name="categoria_slug"><option value="">Todas</option>${categorias.rows.map((c) => `<option value="${c.slug}" ${filtros.categoria_slug === c.slug ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
            <div><label>Cidade</label><input name="cidade" value="${esc(filtros.cidade)}" placeholder="Cidade" list="cidades-imoveis" autocomplete="off" /></div>
            <div><label>Bairro</label><input name="bairro" value="${esc(filtros.bairro)}" placeholder="Bairro" list="bairros-imoveis" autocomplete="off" /></div>
            <div><label>Valor mínimo</label><input name="valor_min" value="${esc(filtros.valor_min)}" placeholder="Ex.: 250.000,00" ${mascaraNumeroAttrs({ decimal: true, monetario: true })} /></div>
            <div><label>Valor máximo</label><input name="valor_max" value="${esc(filtros.valor_max)}" placeholder="Ex.: 500.000,00" ${mascaraNumeroAttrs({ decimal: true, monetario: true })} /></div>
            <div><label>Área total mínima</label><input name="area_total_min" value="${esc(filtros.area_total_min)}" placeholder="m²" /></div>
            <div><label>Área total máxima</label><input name="area_total_max" value="${esc(filtros.area_total_max)}" placeholder="m²" /></div>
            <div><label>Área construída mínima</label><input name="area_construida_min" value="${esc(filtros.area_construida_min)}" placeholder="m²" /></div>
            <div><label>Área construída máxima</label><input name="area_construida_max" value="${esc(filtros.area_construida_max)}" placeholder="m²" /></div>
            <div><label>Frente mínima</label><input name="frente_min" value="${esc(filtros.frente_min)}" placeholder="m" /></div>
            <div><label>Frente máxima</label><input name="frente_max" value="${esc(filtros.frente_max)}" placeholder="m" /></div>
            <div><label>Fundos mínimo</label><input name="fundos_min" value="${esc(filtros.fundos_min)}" placeholder="m" /></div>
            <div><label>Fundos máximo</label><input name="fundos_max" value="${esc(filtros.fundos_max)}" placeholder="m" /></div>
            <div><label>Dormitórios</label><input name="dormitorios" value="${esc(filtros.dormitorios)}" /></div>
            <div><label>Suítes</label><input name="suites" value="${esc(filtros.suites)}" /></div>
            <div><label>Banheiros</label><input name="banheiros" value="${esc(filtros.banheiros)}" /></div>
            <div><label>Vagas garagem</label><input name="vagas" value="${esc(filtros.vagas)}" /></div>
            <div><label>Posição solar</label><input name="posicao_solar" value="${esc(filtros.posicao_solar)}" placeholder="Ex.: Norte" /></div>
            <div><label>Andar</label><input name="andar" value="${esc(filtros.andar)}" /></div>
            <div><label>Estado imóvel</label>${selectEstadoImovel('estado_imovel', filtros.estado_imovel, 'Todos')}</div>
          </div>
          <div class="filters-actions">
            <button type="submit">Pesquisar imóveis</button>
            <a href="/painel/imoveis">Limpar filtros</a>
          </div>
        </form>
      </section>
      ${temFiltros ? `
      <section class="card">
        <h3>Resultado</h3>
        <div class="results-grid">
          ${rows || `<div class="empty">Nenhum imóvel encontrado.</div>`}
        </div>
      </section>
      ` : ''}
      ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      <script>
        async function copiarLinkGaleriaPublica(url) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(url);
            } else {
              const input = document.createElement('input');
              input.value = url;
              document.body.appendChild(input);
              input.select();
              document.execCommand('copy');
              input.remove();
            }
            window.alert('Link público da galeria copiado.');
          } catch {
            window.prompt('Copie o link da galeria pública:', url);
          }
        }
        function confirmarSenhaAcao(event, acao) {
          const senha = window.prompt('Digite a senha para ' + acao + ' o imóvel:');
          if (!senha) return false;
          if (acao === 'excluir') {
            const confirmar = window.confirm('Confirma excluir este imóvel?');
            if (!confirmar) return false;
          }
          event.target.querySelector('input[name="senha"]').value = senha;
          return true;
        }
        function abrirPdfCompletoImovel(url) {
          const senha = window.prompt('Digite a senha para baixar o PDF completo:');
          if (!senha) return false;
          const sep = url.includes('?') ? '&' : '?';
          window.location.href = url + sep + 'senha=' + encodeURIComponent(senha);
          return false;
        }
      </script>
    `,
  }));
});

app.get('/painel/imoveis-pdf/:id', async (req, res) => {
  const tipo = String(req.query.tipo || 'comercial').trim().toLowerCase();
  if (!['comercial', 'completo'].includes(tipo)) return res.status(400).send('Tipo de PDF inválido');
  if (tipo === 'completo' && !validarSenhaPainel(req.query.senha)) return res.status(403).send('Senha inválida');
  try {
    const buffer = await gerarPdfImovel(req.params.id, tipo);
    return jsonResponseDownload(res, exportFilename(`imovel_${req.params.id}_${tipo}`, 'pdf'), 'application/pdf', buffer);
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

app.get('/imovel/:codigo/galeria', async (req, res) => {
  const imovel = await pool.query('SELECT id, categoria_slug, codigo, titulo, cidade, bairro, valor, status_publicacao FROM imoveis WHERE codigo = $1', [req.params.codigo]);
  if (!imovel.rows.length) return res.status(404).send('Imóvel não encontrado');
  const item = imovel.rows[0];
  if (String(item.status_publicacao || '').toLowerCase() === 'inativo') return res.status(404).send(getPublicUnavailablePropertyMessage());
  const fotos = await pool.query('SELECT nome_arquivo, url_publica, ordem FROM imovel_fotos WHERE imovel_id = $1 ORDER BY ordem', [item.id]);
  const imagens = fotos.rows.length
    ? `<div class="gallery-grid">${fotos.rows.map((foto) => {
        const urlImagem = normalizarImagemPublica(foto.url_publica, item.categoria_slug || '', item.codigo, foto.nome_arquivo);
        return `<div class="gallery-item"><a href="${esc(urlImagem)}" target="_blank" rel="noopener noreferrer"><img src="${esc(urlImagem)}" alt="${esc(item.codigo)}" /></a></div>`;
      }).join('')}</div>`
    : '<div class="empty">Nenhuma imagem cadastrada para este imóvel.</div>';
  res.send(formShell({
    title: `Galeria do imóvel ${item.codigo}`,
    subtitle: `${item.titulo || item.codigo} · ${item.cidade || '-'} / ${item.bairro || '-'} · ${money(item.valor)}`,
    content: `
      <section class="card">
        <h3 style="margin-top:0;margin-bottom:16px;">${esc(item.cidade || '-')} / ${esc(item.bairro || '-')}</h3>
        ${imagens}
      </section>
    `,
  }));
});

app.get('/painel/imoveis-galeria/:id', auth, async (req, res) => {
  const imovel = await pool.query('SELECT id, codigo, cidade, bairro, valor FROM imoveis WHERE id = $1', [req.params.id]);
  if (!imovel.rows.length) return res.status(404).send('Imóvel não encontrado');
  const fotos = await pool.query('SELECT i.categoria_slug, f.id, f.nome_arquivo, f.caminho_local, f.url_publica, f.ordem FROM imovel_fotos f JOIN imoveis i ON i.id = f.imovel_id WHERE f.imovel_id = $1 ORDER BY f.ordem', [req.params.id]);
  const item = imovel.rows[0];
  const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/painel/imoveis') ? req.query.returnTo : `/painel/imoveis?codigo=${encodeURIComponent(item.codigo)}`;
  const modoEdicao = ehGaleriaModoEdicao(returnTo, item.id);
  const imagens = fotos.rows.length
    ? `<div class="gallery-grid">${fotos.rows.map((foto) => {
        const urlImagem = normalizarImagemPublica(foto.url_publica, foto.categoria_slug || '', item.codigo, foto.nome_arquivo);
        return modoEdicao
        ? `<div class="gallery-item"><a href="${esc(urlImagem)}" target="_blank" rel="noopener noreferrer"><img src="${esc(urlImagem)}" alt="${esc(item.codigo)}" /></a><div class="gallery-actions"><a href="/painel/imoveis-galeria-download/${foto.id}" class="btn-link">Baixar imagem</a></div><form method="post" action="/painel/imoveis-foto-excluir/${foto.id}" onsubmit="return confirm('Confirma excluir esta imagem?');"><input type="hidden" name="returnTo" value="${esc(`/painel/imoveis-galeria/${item.id}?returnTo=${returnTo}`)}" /><button type="submit" class="btn-danger">Excluir imagem</button></form></div>`
        : `<div class="gallery-item"><a href="${esc(urlImagem)}" target="_blank" rel="noopener noreferrer"><img src="${esc(urlImagem)}" alt="${esc(item.codigo)}" /></a><div class="gallery-actions"><a href="/painel/imoveis-galeria-download/${foto.id}" class="btn-link">Baixar imagem</a></div></div>`;
      }).join('')}</div>`
    : '<div class="empty">Nenhuma imagem cadastrada para este imóvel.</div>';
  res.send(shell({
    title: `Galeria do imóvel ${item.codigo}`,
    subtitle: `${item.cidade || '-'} / ${item.bairro || '-'} / ${money(item.valor)}`,
    active: 'imoveis',
    content: `
      <section class="card">
        ${fotos.rows.length ? `<div class="filters-actions" style="justify-content:flex-end;margin-bottom:16px;"><a href="/painel/imoveis-galeria-download-zip/${item.id}" class="btn-link">Baixar todas (.zip)</a></div>` : ''}
        ${imagens}
        <div class="filters-actions">
          <a href="${esc(returnTo)}"><button type="button" class="btn-secondary">Voltar para descrição do imóvel</button></a>
        </div>
      </section>
    `,
  }));
});

app.get('/painel/imoveis-galeria-download/:fotoId', auth, async (req, res) => {
  const foto = await pool.query('SELECT nome_arquivo, caminho_local FROM imovel_fotos WHERE id = $1', [req.params.fotoId]);
  if (!foto.rows.length) return res.status(404).send('Imagem não encontrada');
  const arquivo = foto.rows[0];
  if (!arquivo.caminho_local || !fs.existsSync(arquivo.caminho_local)) return res.status(404).send('Arquivo não encontrado');
  return res.download(arquivo.caminho_local, arquivo.nome_arquivo);
});

app.get('/painel/imoveis-galeria-download-zip/:id', auth, async (req, res) => {
  const imovel = await pool.query('SELECT codigo FROM imoveis WHERE id = $1', [req.params.id]);
  if (!imovel.rows.length) return res.status(404).send('Imóvel não encontrado');
  const item = imovel.rows[0];
  const fotos = await pool.query('SELECT nome_arquivo, caminho_local FROM imovel_fotos WHERE imovel_id = $1 ORDER BY ordem, nome_arquivo', [req.params.id]);
  const arquivos = fotos.rows.filter((foto) => foto.caminho_local && fs.existsSync(foto.caminho_local));
  if (!arquivos.length) return res.status(404).send('Nenhuma imagem cadastrada para este imóvel.');
  const script = `import sys, zipfile\nout=sys.argv[1]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n    for item in sys.argv[2:]:\n        nome,caminho=item.split('::',1)\n        z.write(caminho, arcname=nome)\n`;
  const tmpZip = path.join('/tmp', `painel_galeria_${item.codigo}_${Date.now()}.zip`);
  const args = ['-c', script, tmpZip, ...arquivos.map((foto) => `${foto.nome_arquivo}::${foto.caminho_local}`)];
  execFile('python3', args, (error) => {
    if (error) {
      if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
      return res.status(500).send('Não foi possível gerar o arquivo ZIP.');
    }
    return res.download(tmpZip, `${item.codigo}_galeria.zip`, (downloadError) => {
      if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
      if (downloadError && !res.headersSent) res.status(500).send('Não foi possível baixar o arquivo ZIP.');
    });
  });
});

app.post('/painel/imoveis-foto-excluir/:fotoId', auth, async (req, res) => {
  const foto = await pool.query('SELECT id, caminho_local FROM imovel_fotos WHERE id = $1', [req.params.fotoId]);
  if (!foto.rows.length) return res.status(404).send('Imagem não encontrada');
  await pool.query('DELETE FROM imovel_fotos WHERE id = $1', [req.params.fotoId]);
  try { fs.unlinkSync(foto.rows[0].caminho_local); } catch {}
  const returnTo = typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/painel/') ? req.body.returnTo : '/painel/imoveis';
  res.redirect(returnTo);
});

app.post('/painel/imoveis-editar-senha/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  res.redirect(`/painel/imoveis-editar/${req.params.id}?senha=${encodeURIComponent(req.body.senha)}`);
});

app.get('/painel/imoveis/novo', auth, async (req, res) => {
  const categorias = await carregarCategoriasAtivas();
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const v = {
    categoria_slug: req.query.categoria_slug || '', titulo: req.query.titulo || '', descricao: req.query.descricao || '', cidade: req.query.cidade || '', bairro: req.query.bairro || '', valor: req.query.valor || '', status_publicacao: req.query.status_publicacao || 'disponivel', estado_imovel: req.query.estado_imovel || '', area_total_m2: req.query.area_total_m2 || '', area_construida_m2: req.query.area_construida_m2 || '', dimensao_frente_m: req.query.dimensao_frente_m || '', dimensao_fundos_m: req.query.dimensao_fundos_m || '', numero_dormitorios: req.query.numero_dormitorios || '', numero_suites: req.query.numero_suites || '', numero_banheiros: req.query.numero_banheiros || '', numero_vagas_garagem: req.query.numero_vagas_garagem || '', posicao_solar: req.query.posicao_solar || '', andar: req.query.andar || '', possui_elevador: req.query.possui_elevador || '', valor_condominio: req.query.valor_condominio || '', aceita_financiamento: req.query.aceita_financiamento || '', aceita_permuta: req.query.aceita_permuta || '', diferenciais: req.query.diferenciais || '', endereco_completo: req.query.endereco_completo || '', uf: req.query.uf || '', cep: req.query.cep || '', matricula_imovel: req.query.matricula_imovel || '', registro_cartorio: req.query.registro_cartorio || '', possui_escritura: req.query.possui_escritura || '', possui_averbacao: req.query.possui_averbacao || '', condicoes_especiais: req.query.condicoes_especiais || ''
  };
  res.send(shell({
    title: 'Cadastrar imóvel',
    subtitle: 'Cadastro completo com campos de imoveis, documental_imovel e upload de imagens.',
    active: 'novo-imovel',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/imoveis/novo" enctype="multipart/form-data" data-validate-numeric="true" onsubmit="return confirmarSenhaPainel(event, 'cadastrar o imóvel')">
          <input type="hidden" name="senha" value="" />
          <div class="grid">
            <div><label>Categoria</label><select name="categoria_slug" required><option value="">Selecione</option>${categorias.rows.map((c) => `<option value="${c.slug}" ${v.categoria_slug === c.slug ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
            <div><label>&nbsp;</label><a href="/painel/categorias"><button type="button" class="btn-secondary">Criar/Editar categoria</button></a></div>
            <div><label>Código</label><input value="Será gerado automaticamente" readonly /></div>
            <div><label>Título</label><input name="titulo" value="${esc(v.titulo)}" /></div>
            <div class="field-full"><label>Descrição</label><textarea name="descricao">${esc(v.descricao)}</textarea></div>
            <div><label>Cidade</label><input name="cidade" value="${esc(v.cidade)}" list="cidades-imoveis" autocomplete="off" /></div>
            <div><label>Bairro</label><input name="bairro" value="${esc(v.bairro)}" list="bairros-imoveis" autocomplete="off" /></div>
            <div><label for="valor">Valor</label><input id="valor" name="valor" type="text" data-numero="decimal" data-monetario="true" value="${esc(v.valor)}" /></div>
            <div><label>Status publicação</label>${selectStatusPublicacao(v.status_publicacao)}</div>
            <div><label>Estado imóvel</label>${selectEstadoImovel('estado_imovel', v.estado_imovel)}</div>
            <div><label for="area_total_m2">Área total m²</label><input id="area_total_m2" name="area_total_m2" type="text" data-numero="decimal" value="${esc(v.area_total_m2)}" /></div>
            <div><label for="area_construida_m2">Área construída m²</label><input id="area_construida_m2" name="area_construida_m2" type="text" data-numero="decimal" value="${esc(v.area_construida_m2)}" /></div>
            <div><label for="dimensao_frente_m">Frente m</label><input id="dimensao_frente_m" name="dimensao_frente_m" type="text" data-numero="decimal" value="${esc(v.dimensao_frente_m)}" /></div>
            <div><label for="dimensao_fundos_m">Fundos m</label><input id="dimensao_fundos_m" name="dimensao_fundos_m" type="text" data-numero="decimal" value="${esc(v.dimensao_fundos_m)}" /></div>
            <div><label for="numero_dormitorios">Dormitórios</label><input id="numero_dormitorios" name="numero_dormitorios" type="text" data-numero="inteiro" value="${esc(v.numero_dormitorios)}" /></div>
            <div><label for="numero_suites">Suítes</label><input id="numero_suites" name="numero_suites" type="text" data-numero="inteiro" value="${esc(v.numero_suites)}" /></div>
            <div><label for="numero_banheiros">Banheiros</label><input id="numero_banheiros" name="numero_banheiros" type="text" data-numero="inteiro" value="${esc(v.numero_banheiros)}" /></div>
            <div><label for="numero_vagas_garagem">Vagas garagem</label><input id="numero_vagas_garagem" name="numero_vagas_garagem" type="text" data-numero="inteiro" value="${esc(v.numero_vagas_garagem)}" /></div>
            <div><label>Posição solar</label><input name="posicao_solar" value="${esc(v.posicao_solar)}" /></div>
            <div><label for="andar">Andar</label><input id="andar" name="andar" type="text" data-numero="inteiro" value="${esc(v.andar)}" /></div>
            <div><label>Possui elevador</label><select name="possui_elevador"><option value="">Selecione</option><option value="true" ${v.possui_elevador === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${v.possui_elevador === 'false' ? 'selected' : ''}>Não</option></select></div>
            <div><label for="valor_condominio">Valor condomínio</label><input id="valor_condominio" name="valor_condominio" type="text" data-numero="decimal" data-monetario="true" value="${esc(v.valor_condominio)}" /></div>
            <div><label>Aceita financiamento</label><select name="aceita_financiamento"><option value="">Selecione</option><option value="true" ${v.aceita_financiamento === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${v.aceita_financiamento === 'false' ? 'selected' : ''}>Não</option></select></div>
            <div><label>Aceita permuta</label><select name="aceita_permuta"><option value="">Selecione</option><option value="true" ${v.aceita_permuta === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${v.aceita_permuta === 'false' ? 'selected' : ''}>Não</option></select></div>
            <div class="field-full"><label>Condições especiais</label><input name="condicoes_especiais" value="${esc(v.condicoes_especiais || '')}" /></div>
            <div class="field-full"><label>Diferenciais (separados por vírgula)</label><input name="diferenciais" value="${esc(v.diferenciais)}" /></div>
            <div class="field-full"><label>Endereço completo</label><textarea name="endereco_completo">${esc(v.endereco_completo)}</textarea></div>
            <div><label>UF</label><input name="uf" maxlength="2" value="${esc(v.uf)}" /></div>
            <div><label for="cep">CEP</label><input id="cep" name="cep" type="text" data-numero="inteiro" value="${esc(v.cep)}" /></div>
            <div><label for="matricula_imovel">Matrícula imóvel</label><input id="matricula_imovel" name="matricula_imovel" type="text" data-numero="inteiro" value="${esc(v.matricula_imovel)}" /></div>
            <div><label>Registro cartório</label><select name="registro_cartorio"><option value="">Selecione</option><option value="true" ${v.registro_cartorio === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${v.registro_cartorio === 'false' ? 'selected' : ''}>Não</option></select></div>
            <div><label>Possui escritura</label><select name="possui_escritura"><option value="">Selecione</option><option value="true" ${v.possui_escritura === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${v.possui_escritura === 'false' ? 'selected' : ''}>Não</option></select></div>
            <div><label>Possui averbação</label><select name="possui_averbacao"><option value="">Selecione</option><option value="true" ${v.possui_averbacao === 'true' ? 'selected' : ''}>Sim</option><option value="false" ${v.possui_averbacao === 'false' ? 'selected' : ''}>Não</option></select></div>
            <div class="field-full"><label>Imagens</label><input type="file" name="fotos" accept="image/*" multiple /></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Cadastrar imóvel</button>
            <a href="/painel/imoveis"><button type="button" class="btn-secondary">Cancelar</button></a>
          </div>
          ${renderLocationDatalists({ cidades, bairrosPorCidade })}
        </form>
      </section>
      </section>
    `,
  }));
});

app.post('/painel/imoveis/novo', auth, upload.array('fotos', 30), async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const client = await pool.connect();
  try {
    const b = { ...req.body };
    const campoNumericoInvalido = validarNumerosFormulario(b, ['valor','area_total_m2','area_construida_m2','dimensao_frente_m','dimensao_fundos_m','valor_condominio','cep','matricula_imovel','numero_dormitorios','numero_suites','numero_banheiros','numero_vagas_garagem','andar']);
    if (campoNumericoInvalido) {
      const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v ?? '')])), erro: `Preencha o campo ${campoNumericoInvalido} apenas com números.` }).toString();
      return res.redirect(`/painel/imoveis/novo?${qs}`);
    }
    await client.query('BEGIN');
    const { codigo, pasta_slug } = await gerarCodigo(client, b.categoria_slug);
    const pasta = path.join(mediaRoot, pasta_slug, codigo);
    fs.mkdirSync(pasta, { recursive: true });
    const baseUrl = `https://${process.env.IMAGES_DOMAIN}/files/${pasta_slug}/${codigo}`;
    const actor = getAuditActor();
    const insert = await client.query(`INSERT INTO imoveis (categoria_slug, codigo, titulo, descricao, cidade, bairro, valor, status_publicacao, caminho_pasta_local, url_base_publica, galeria_imagem, area_total_m2, area_construida_m2, dimensao_frente_m, dimensao_fundos_m, numero_dormitorios, numero_suites, numero_banheiros, numero_vagas_garagem, posicao_solar, andar, possui_elevador, valor_condominio, aceita_financiamento, aceita_permuta, diferenciais, estado_imovel, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::numeric,$8,$9,$10,$11,NULLIF($12,'')::numeric,NULLIF($13,'')::numeric,NULLIF($14,'')::numeric,NULLIF($15,'')::numeric,NULLIF($16,'')::int,NULLIF($17,'')::int,NULLIF($18,'')::int,NULLIF($19,'')::int,$20,NULLIF($21,'')::int,NULLIF($22,'')::boolean,NULLIF($23,'')::numeric,NULLIF($24,'')::boolean,NULLIF($25,'')::boolean,$26::jsonb,$27,$28,$29) RETURNING id`, [b.categoria_slug, codigo, b.titulo, b.descricao, b.cidade, b.bairro, normalizarNumeroFormulario(b.valor, { decimal: true }), b.status_publicacao, pasta, baseUrl, montarLinkGaleriaImovel(codigo), normalizarNumeroFormulario(b.area_total_m2, { decimal: true }), normalizarNumeroFormulario(b.area_construida_m2, { decimal: true }), normalizarNumeroFormulario(b.dimensao_frente_m, { decimal: true }), normalizarNumeroFormulario(b.dimensao_fundos_m, { decimal: true }), normalizarNumeroFormulario(b.numero_dormitorios), normalizarNumeroFormulario(b.numero_suites), normalizarNumeroFormulario(b.numero_banheiros), normalizarNumeroFormulario(b.numero_vagas_garagem), b.posicao_solar, normalizarNumeroFormulario(b.andar), b.possui_elevador, normalizarNumeroFormulario(b.valor_condominio, { decimal: true }), b.aceita_financiamento, b.aceita_permuta, JSON.stringify(([b.condicoes_especiais, b.diferenciais].filter(Boolean).join(', ')).split(',').map((s) => s.trim()).filter(Boolean)), b.estado_imovel, actor, actor]);
    const id = insert.rows[0].id;
    await client.query(`INSERT INTO documental_imovel (imovel_id, endereco_completo, uf, cep, matricula_imovel, registro_cartorio, possui_escritura, possui_averbacao, created_by, updated_by) VALUES ($1,$2,UPPER(NULLIF($3,'')),NULLIF($4,'')::numeric,NULLIF($5,'')::numeric,NULLIF($6,'')::boolean,NULLIF($7,'')::boolean,NULLIF($8,'')::boolean,$9,$10)`, [id, b.endereco_completo, b.uf, b.cep, b.matricula_imovel, b.registro_cartorio, b.possui_escritura, b.possui_averbacao, actor, actor]);
    if (req.files?.length) {
      let ordem = 0;
      for (const file of req.files) {
        ordem += 1;
        const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
        const nomeArquivo = `${codigo}_${String(ordem).padStart(2, '0')}${ext}`;
        const destino = path.join(pasta, nomeArquivo);
        fs.renameSync(file.path, destino);
        await client.query('INSERT INTO imovel_fotos (id, imovel_id, nome_arquivo, caminho_local, url_publica, ordem, legenda) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)', [id, nomeArquivo, destino, montarUrlImagemPublica(pasta_slug, codigo, nomeArquivo), ordem, codigo]);
      }
    }
    await client.query('COMMIT');
    res.redirect('/painel/imoveis');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ERRO EDITAR IMOVEL', { body: req.body, files: req.files?.map((f) => ({ name: f.originalname, path: f.path })), message: error.message, stack: error.stack });
    res.status(500).send(error.message);
  } finally {
    client.release();
  }
});

app.get('/painel/imoveis-editar/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.query.senha)) return res.status(403).send('Senha inválida');
  const result = await pool.query(`SELECT i.id, i.categoria_slug, i.codigo, i.titulo, i.descricao, i.cidade, i.bairro, i.valor, i.status_publicacao, i.area_total_m2, i.area_construida_m2, i.dimensao_frente_m, i.dimensao_fundos_m, i.numero_dormitorios, i.numero_suites, i.numero_banheiros, i.numero_vagas_garagem, i.posicao_solar, i.andar, i.possui_elevador, i.valor_condominio, i.aceita_financiamento, i.aceita_permuta, i.diferenciais, i.estado_imovel, d.endereco_completo, d.uf, d.cep, d.matricula_imovel, d.registro_cartorio, d.possui_escritura, d.possui_averbacao FROM imoveis i LEFT JOIN documental_imovel d ON d.imovel_id = i.id WHERE i.id = $1`, [req.params.id]);
  const categorias = await carregarCategoriasAtivas();
  const { cidades, bairrosPorCidade } = await carregarSugestoesLocalizacao();
  if (!result.rows.length) return res.status(404).send('Imóvel não encontrado');
  const item = result.rows[0];
  const erro = req.query.erro ? decodeURIComponent(req.query.erro) : '';
  const q = req.query;
  if (Object.keys(q).length) {
    item.titulo = q.titulo ?? item.titulo;
    item.descricao = q.descricao ?? item.descricao;
    item.cidade = q.cidade ?? item.cidade;
    item.bairro = q.bairro ?? item.bairro;
    item.valor = q.valor ?? item.valor;
    item.status_publicacao = q.status_publicacao ?? item.status_publicacao;
    item.estado_imovel = q.estado_imovel ?? item.estado_imovel;
    item.area_total_m2 = q.area_total_m2 ?? item.area_total_m2;
    item.area_construida_m2 = q.area_construida_m2 ?? item.area_construida_m2;
    item.dimensao_frente_m = q.dimensao_frente_m ?? item.dimensao_frente_m;
    item.dimensao_fundos_m = q.dimensao_fundos_m ?? item.dimensao_fundos_m;
    item.numero_dormitorios = q.numero_dormitorios ?? item.numero_dormitorios;
    item.numero_suites = q.numero_suites ?? item.numero_suites;
    item.numero_banheiros = q.numero_banheiros ?? item.numero_banheiros;
    item.numero_vagas_garagem = q.numero_vagas_garagem ?? item.numero_vagas_garagem;
    item.posicao_solar = q.posicao_solar ?? item.posicao_solar;
    item.andar = q.andar ?? item.andar;
    item.possui_elevador = q.possui_elevador !== undefined ? q.possui_elevador === 'true' : item.possui_elevador;
    item.valor_condominio = q.valor_condominio ?? item.valor_condominio;
    item.aceita_financiamento = q.aceita_financiamento !== undefined ? q.aceita_financiamento === 'true' : item.aceita_financiamento;
    item.aceita_permuta = q.aceita_permuta !== undefined ? q.aceita_permuta === 'true' : item.aceita_permuta;
    item.diferenciais = q.diferenciais !== undefined ? q.diferenciais.split(',').map((s) => s.trim()).filter(Boolean) : item.diferenciais;
    item.condicoes_especiais = q.condicoes_especiais ?? '';
    item.endereco_completo = q.endereco_completo ?? item.endereco_completo;
    item.uf = q.uf ?? item.uf;
    item.cep = q.cep ?? item.cep;
    item.matricula_imovel = q.matricula_imovel ?? item.matricula_imovel;
    item.registro_cartorio = q.registro_cartorio !== undefined ? q.registro_cartorio === 'true' : item.registro_cartorio;
    item.possui_escritura = q.possui_escritura !== undefined ? q.possui_escritura === 'true' : item.possui_escritura;
    item.possui_averbacao = q.possui_averbacao !== undefined ? q.possui_averbacao === 'true' : item.possui_averbacao;
  }
  const diferenciais = Array.isArray(item.diferenciais) ? item.diferenciais.join(', ') : '';
const condicoesEspeciais = item.condicoes_especiais || '';
  res.send(shell({
    title: `Editar imóvel ${item.codigo}`,
    subtitle: 'Edição protegida pela mesma senha do painel.',
    active: 'imoveis',
    content: `
      ${renderFormError(erro)}
      <section class="card">
        <form method="post" action="/painel/imoveis-salvar/${item.id}" data-validate-numeric="true" enctype="multipart/form-data">
          <input type="hidden" name="senha" value="${esc(req.query.senha)}" />
          <div class="grid">
            <div><label>Categoria</label><select name="categoria_slug" disabled><option value="">Selecione</option>${categorias.rows.map((c) => `<option value="${c.slug}" ${item.categoria_slug === c.slug ? 'selected' : ''}>${esc(c.nome_exibicao)}</option>`).join('')}</select></div>
            <div><label>Código</label><input name="codigo" value="${esc(item.codigo)}" readonly /></div>
            <div><label>Título</label><input name="titulo" value="${esc(item.titulo || '')}" /></div>
            <div class="field-full"><label>Descrição</label><textarea name="descricao">${esc(item.descricao || '')}</textarea></div>
            <div><label>Cidade</label><input name="cidade" value="${esc(item.cidade || '')}" list="cidades-imoveis" autocomplete="off" /></div>
            <div><label>Bairro</label><input name="bairro" value="${esc(item.bairro || '')}" list="bairros-imoveis" autocomplete="off" /></div>
            <div><label for="valor">Valor</label><input id="valor" name="valor" type="text" data-numero="decimal" data-monetario="true" value="${esc(item.valor ?? '')}" /></div>
            <div><label>Status publicação</label>${selectStatusPublicacao(item.status_publicacao)}</div>
            <div><label>Estado imóvel</label>${selectEstadoImovel('estado_imovel', item.estado_imovel)}</div>
            <div><label for="area_total_m2">Área total m²</label><input id="area_total_m2" name="area_total_m2" type="text" data-numero="decimal" value="${esc(item.area_total_m2 ?? '')}" /></div>
            <div><label for="area_construida_m2">Área construída m²</label><input id="area_construida_m2" name="area_construida_m2" type="text" data-numero="decimal" value="${esc(item.area_construida_m2 ?? '')}" /></div>
            <div><label for="dimensao_frente_m">Frente m</label><input id="dimensao_frente_m" name="dimensao_frente_m" type="text" data-numero="decimal" value="${esc(item.dimensao_frente_m ?? '')}" /></div>
            <div><label for="dimensao_fundos_m">Fundos m</label><input id="dimensao_fundos_m" name="dimensao_fundos_m" type="text" data-numero="decimal" value="${esc(item.dimensao_fundos_m ?? '')}" /></div>
            <div><label for="numero_dormitorios">Dormitórios</label><input id="numero_dormitorios" name="numero_dormitorios" type="text" data-numero="inteiro" value="${esc(item.numero_dormitorios ?? '')}" /></div>
            <div><label for="numero_suites">Suítes</label><input id="numero_suites" name="numero_suites" type="text" data-numero="inteiro" value="${esc(item.numero_suites ?? '')}" /></div>
            <div><label for="numero_banheiros">Banheiros</label><input id="numero_banheiros" name="numero_banheiros" type="text" data-numero="inteiro" value="${esc(item.numero_banheiros ?? '')}" /></div>
            <div><label for="numero_vagas_garagem">Vagas garagem</label><input id="numero_vagas_garagem" name="numero_vagas_garagem" type="text" data-numero="inteiro" value="${esc(item.numero_vagas_garagem ?? '')}" /></div>
            <div><label>Posição solar</label><input name="posicao_solar" value="${esc(item.posicao_solar || '')}" /></div>
            <div><label for="andar">Andar</label><input id="andar" name="andar" type="text" data-numero="inteiro" value="${esc(item.andar ?? '')}" /></div>
            <div><label>Possui elevador</label><select name="possui_elevador"><option value="">Selecione</option><option value="true" ${item.possui_elevador === true ? 'selected' : ''}>Sim</option><option value="false" ${item.possui_elevador === false ? 'selected' : ''}>Não</option></select></div>
            <div><label for="valor_condominio">Valor condomínio</label><input id="valor_condominio" name="valor_condominio" type="text" data-numero="decimal" data-monetario="true" value="${esc(item.valor_condominio ?? '')}" /></div>
            <div><label>Aceita financiamento</label><select name="aceita_financiamento"><option value="">Selecione</option><option value="true" ${item.aceita_financiamento === true ? 'selected' : ''}>Sim</option><option value="false" ${item.aceita_financiamento === false ? 'selected' : ''}>Não</option></select></div>
            <div><label>Aceita permuta</label><select name="aceita_permuta"><option value="">Selecione</option><option value="true" ${item.aceita_permuta === true ? 'selected' : ''}>Sim</option><option value="false" ${item.aceita_permuta === false ? 'selected' : ''}>Não</option></select></div>
            <div class="field-full"><label>Condições especiais</label><input name="condicoes_especiais" value="${esc(condicoesEspeciais)}" /></div>
            <div class="field-full"><label>Diferenciais (separados por vírgula)</label><input name="diferenciais" value="${esc(diferenciais)}" /></div>
            <div class="field-full"><label>Endereço completo</label><textarea name="endereco_completo">${esc(item.endereco_completo || '')}</textarea></div>
            <div><label>UF</label><input name="uf" maxlength="2" value="${esc(item.uf || '')}" /></div>
            <div><label for="cep">CEP</label><input id="cep" name="cep" type="text" data-numero="inteiro" value="${esc(item.cep ?? '')}" /></div>
            <div><label for="matricula_imovel">Matrícula imóvel</label><input id="matricula_imovel" name="matricula_imovel" type="text" data-numero="inteiro" value="${esc(item.matricula_imovel ?? '')}" /></div>
            <div><label>Registro cartório</label><select name="registro_cartorio"><option value="">Selecione</option><option value="true" ${item.registro_cartorio === true ? 'selected' : ''}>Sim</option><option value="false" ${item.registro_cartorio === false ? 'selected' : ''}>Não</option></select></div>
            <div><label>Possui escritura</label><select name="possui_escritura"><option value="">Selecione</option><option value="true" ${item.possui_escritura === true ? 'selected' : ''}>Sim</option><option value="false" ${item.possui_escritura === false ? 'selected' : ''}>Não</option></select></div>
            <div><label>Possui averbação</label><select name="possui_averbacao"><option value="">Selecione</option><option value="true" ${item.possui_averbacao === true ? 'selected' : ''}>Sim</option><option value="false" ${item.possui_averbacao === false ? 'selected' : ''}>Não</option></select></div>
            <div class="field-full"><label>Upload de imagens</label><input type="file" name="fotos" accept="image/*" multiple /></div>
          </div>
          <div class="filters-actions">
            <button type="submit">Salvar imóvel</button>
            <a href="/painel/imoveis-galeria/${item.id}?returnTo=${encodeURIComponent(`/painel/imoveis-editar/${item.id}?senha=${req.query.senha}`)}"><button type="button">Editar imagens</button></a>
            <a href="/painel/imoveis"><button type="button" class="btn-secondary">Cancelar</button></a>
            <a href="/painel/imoveis">Voltar</a>
          </div>
        </form>
        ${renderLocationDatalists({ cidades, bairrosPorCidade })}
      </section>
    `,
  }));
});

app.post('/painel/imoveis-salvar/:id', auth, upload.array('fotos', 30), async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const b = req.body;
  for (const key of ['valor','area_total_m2','area_construida_m2','dimensao_frente_m','dimensao_fundos_m','valor_condominio','cep','matricula_imovel','numero_dormitorios','numero_suites','numero_banheiros','numero_vagas_garagem','andar','possui_elevador','aceita_financiamento','aceita_permuta','registro_cartorio','possui_escritura','possui_averbacao']) b[key] = normalizarCampoBanco(b[key]);
  for (const key of ['valor','area_total_m2','area_construida_m2','dimensao_frente_m','dimensao_fundos_m','valor_condominio']) b[key] = normalizarNumeroFormulario(b[key], { decimal: true });
  for (const key of ['cep','matricula_imovel','numero_dormitorios','numero_suites','numero_banheiros','numero_vagas_garagem','andar']) b[key] = normalizarNumeroFormulario(b[key]);
  const campoNumericoInvalido = validarNumerosFormulario(b, ['valor','area_total_m2','area_construida_m2','dimensao_frente_m','dimensao_fundos_m','valor_condominio','cep','matricula_imovel','numero_dormitorios','numero_suites','numero_banheiros','numero_vagas_garagem','andar']);
  if (campoNumericoInvalido) {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v ?? '')])), erro: `Preencha o campo ${campoNumericoInvalido} apenas com números.`, senha: req.body.senha }).toString();
    return res.redirect(`/painel/imoveis-editar/${req.params.id}?${qs}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE imoveis SET titulo = $2, descricao = $3, cidade = $4, bairro = $5, valor = NULLIF($6,'')::numeric, status_publicacao = $7, area_total_m2 = NULLIF($8,'')::numeric, area_construida_m2 = NULLIF($9,'')::numeric, dimensao_frente_m = NULLIF($10,'')::numeric, dimensao_fundos_m = NULLIF($11,'')::numeric, numero_dormitorios = NULLIF($12,'')::int, numero_suites = NULLIF($13,'')::int, numero_banheiros = NULLIF($14,'')::int, numero_vagas_garagem = NULLIF($15,'')::int, posicao_solar = $16, andar = NULLIF($17,'')::int, possui_elevador = NULLIF($18,'')::boolean, valor_condominio = NULLIF($19,'')::numeric, aceita_financiamento = NULLIF($20,'')::boolean, aceita_permuta = NULLIF($21,'')::boolean, diferenciais = $22::jsonb, estado_imovel = $23, updated_at = now() WHERE id = $1`, [req.params.id, b.titulo, b.descricao, b.cidade, b.bairro, b.valor, b.status_publicacao, b.area_total_m2, b.area_construida_m2, b.dimensao_frente_m, b.dimensao_fundos_m, b.numero_dormitorios, b.numero_suites, b.numero_banheiros, b.numero_vagas_garagem, b.posicao_solar, b.andar, b.possui_elevador, b.valor_condominio, b.aceita_financiamento, b.aceita_permuta, JSON.stringify(([b.condicoes_especiais, b.diferenciais].filter(Boolean).join(', ')).split(',').map((s) => s.trim()).filter(Boolean)), b.estado_imovel]);
    await client.query(`UPDATE documental_imovel SET endereco_completo = $2, uf = UPPER(NULLIF($3,'')), cep = NULLIF($4,'')::numeric, matricula_imovel = NULLIF($5,'')::numeric, registro_cartorio = $6::boolean, possui_escritura = $7::boolean, possui_averbacao = $8::boolean, updated_at = now(), updated_by = $9 WHERE imovel_id = $1`, [req.params.id, b.endereco_completo, b.uf, b.cep, b.matricula_imovel, b.registro_cartorio, b.possui_escritura, b.possui_averbacao, getAuditActor()]);
    if (req.files?.length) {
      const info = await client.query('SELECT codigo, caminho_pasta_local, url_base_publica FROM imoveis WHERE id = $1', [req.params.id]);
      const itemFoto = info.rows[0];
      fs.mkdirSync(itemFoto.caminho_pasta_local, { recursive: true });
      const ultimaOrdemResult = await client.query('SELECT COALESCE(MAX(ordem), 0)::int AS max_ordem FROM imovel_fotos WHERE imovel_id = $1', [req.params.id]);
      let ordem = ultimaOrdemResult.rows[0].max_ordem;
      for (const file of req.files) {
        ordem += 1;
        const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
        const nomeArquivo = `${itemFoto.codigo}_${String(ordem).padStart(2, '0')}${ext}`;
        const destino = path.join(itemFoto.caminho_pasta_local, nomeArquivo);
        fs.renameSync(file.path, destino);
        await client.query('INSERT INTO imovel_fotos (id, imovel_id, nome_arquivo, caminho_local, url_publica, ordem, legenda) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)', [req.params.id, nomeArquivo, destino, `${itemFoto.url_base_publica}/${nomeArquivo}`, ordem, itemFoto.codigo]);
      }
    }
    await client.query('COMMIT');
    res.redirect('/painel/imoveis');
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).send(error.message);
  } finally {
    client.release();
  }
});

app.post('/painel/imoveis-excluir/:id', auth, async (req, res) => {
  if (!validarSenhaPainel(req.body.senha)) return res.status(403).send('Senha inválida');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const info = await client.query('SELECT i.categoria_slug, i.caminho_pasta_local FROM imoveis i WHERE i.id = $1', [req.params.id]);
    if (!info.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Imóvel não encontrado');
    }
    const { categoria_slug, caminho_pasta_local } = info.rows[0];
    await client.query('DELETE FROM imoveis WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    try {
      if (caminho_pasta_local && fs.existsSync(caminho_pasta_local)) fs.rmSync(caminho_pasta_local, { recursive: true, force: true });
    } catch (error) {
      console.error('ERRO REMOVER PASTA IMOVEL', { id: req.params.id, pasta: caminho_pasta_local, message: error.message });
    }
    res.redirect('/painel/imoveis');
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).send(error.message);
  } finally {
    client.release();
  }
});

const requiredPanelCreds = [
  ['PANEL_ADMIN_USER', process.env.PANEL_ADMIN_USER],
  ['PANEL_ADMIN_PASSWORD', process.env.PANEL_ADMIN_PASSWORD],
].filter(([, value]) => !String(value || '').trim());

if (requiredPanelCreds.length > 0) {
  console.error('Credenciais obrigatórias ausentes para iniciar o painel:', requiredPanelCreds.map(([key]) => key).join(', '));
  process.exit(1);
}

const port = Number(process.env.APP_PORT || 5180);
app.listen(port, '0.0.0.0', () => {
  console.log(`${getAppDisplayName()} em http://127.0.0.1:${port}`);
});
