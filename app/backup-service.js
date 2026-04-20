const fs = require('fs');
const path = require('path');

function escCsv(value) {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function csvParseSimple(content) {
  const lines = String(content || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const parseLine = (line) => {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (quoted) {
        if (ch === '"' && next === '"') { current += '"'; i++; continue; }
        if (ch === '"') { quoted = false; continue; }
        current += ch;
      } else {
        if (ch === ',') { out.push(current); current = ''; continue; }
        if (ch === '"') { quoted = true; continue; }
        current += ch;
      }
    }
    out.push(current);
    return out;
  };
  const headers = parseLine(lines.shift()).map((h) => h.trim());
  return lines.map((line) => {
    const values = parseLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    return row;
  });
}

function norm(v) {
  return String(v ?? '').trim();
}

function pick(row, keys) {
  const out = {};
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

function buildBackupPackage({ appName, tipo, clientes = [], imoveis = [], categorias = [] }) {
  const manifest = { schema: 'corretorcenter-backup-v2', generatedAt: new Date().toISOString(), app: appName, tipo };
  if (tipo === 'clientes') return { manifest, clientes };
  return { manifest, categorias, imoveis };
}

function serializeBackup(pkg, formato) {
  if (formato === 'json') return JSON.stringify(pkg, null, 2);
  if (formato === 'csv') {
    if (pkg.clientes) {
      const cols = pkg.clientes.length ? Object.keys(pkg.clientes[0]) : [];
      return [cols.join(','), ...pkg.clientes.map((r) => cols.map((c) => escCsv(r[c])).join(','))].join('\n');
    }
    const cols = pkg.imoveis.length ? Object.keys(pkg.imoveis[0]).filter((k) => k !== 'documental_imovel') : [];
    return [cols.join(','), ...pkg.imoveis.map((r) => cols.map((c) => escCsv(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(','))].join('\n');
  }
  throw new Error('Formato inválido');
}

function normalizeCliente(row = {}) {
  return {
    telefone: norm(row.telefone),
    nome: row.nome || '',
    corretor: row.corretor || '',
    atendente: row.atendente || '',
    interesse: row.interesse || '',
    tipo_imovel_desejado: row.tipo_imovel_desejado || '',
    estado_imovel_desejado: row.estado_imovel_desejado || '',
    numero_quartos_desejado: row.numero_quartos_desejado || null,
    numero_banheiros_desejado: row.numero_banheiros_desejado || null,
    numero_vagas_garagem_desejada: row.numero_vagas_garagem_desejada || null,
    numero_suites_desejada: row.numero_suites_desejada || null,
    valor_minimo: row.valor_minimo || null,
    valor_maximo: row.valor_maximo || null,
    cidade: row.cidade || '',
    bairro: row.bairro || '',
    tipo_pagamento: row.tipo_pagamento || '',
    resumo_atendimento: row.resumo_atendimento || '',
  };
}

function normalizeImovel(row = {}) {
  const documental = row.documental_imovel && typeof row.documental_imovel === 'object' ? row.documental_imovel : {};
  return {
    categoria_slug: norm(row.categoria_slug || row.categoria || row.slug),
    codigo: norm(row.codigo),
    titulo: row.titulo || row.nome || '',
    descricao: row.descricao || '',
    cidade: row.cidade || '',
    bairro: row.bairro || '',
    valor: row.valor || null,
    status_publicacao: row.status_publicacao || 'disponivel',
    estado_imovel: row.estado_imovel || '',
    area_total_m2: row.area_total_m2 || null,
    area_construida_m2: row.area_construida_m2 || null,
    dimensao_frente_m: row.dimensao_frente_m || null,
    dimensao_fundos_m: row.dimensao_fundos_m || null,
    numero_dormitorios: row.numero_dormitorios || null,
    numero_suites: row.numero_suites || null,
    numero_banheiros: row.numero_banheiros || null,
    numero_vagas_garagem: row.numero_vagas_garagem || null,
    posicao_solar: row.posicao_solar || null,
    andar: row.andar || null,
    possui_elevador: row.possui_elevador || false,
    valor_condominio: row.valor_condominio || null,
    aceita_financiamento: row.aceita_financiamento || false,
    aceita_permuta: row.aceita_permuta || false,
    diferenciais: Array.isArray(row.diferenciais) ? row.diferenciais : (typeof row.diferenciais === 'string' && row.diferenciais ? row.diferenciais.split(',').map((s) => s.trim()).filter(Boolean) : []),
    galeria_imagem: row.galeria_imagem || null,
    caminho_pasta_local: row.caminho_pasta_local || null,
    url_base_publica: row.url_base_publica || null,
    documental_imovel: documental,
    endereco_completo: documental.endereco_completo || row.endereco_completo || '',
    uf: documental.uf || row.uf || '',
    cep: documental.cep || row.cep || null,
    matricula_imovel: documental.matricula_imovel || row.matricula_imovel || null,
    registro_cartorio: documental.registro_cartorio ?? row.registro_cartorio ?? false,
    possui_escritura: documental.possui_escritura ?? row.possui_escritura ?? false,
    possui_averbacao: documental.possui_averbacao ?? row.possui_averbacao ?? false,
  };
}

module.exports = {
  escCsv,
  csvParseSimple,
  buildBackupPackage,
  serializeBackup,
  normalizeCliente,
  normalizeImovel,
  pick,
  norm,
};
