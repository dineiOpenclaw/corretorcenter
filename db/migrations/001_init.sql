CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS categorias_imovel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  nome_exibicao text NOT NULL,
  sigla_codigo text NOT NULL,
  pasta_slug text NOT NULL,
  ativa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clientes (
  id bigserial PRIMARY KEY,
  telefone text NOT NULL,
  nome text,
  corretor text,
  atendente text,
  interesse text,
  tipo_imovel_desejado text,
  estado_imovel_desejado text,
  numero_quartos_desejado int,
  numero_banheiros_desejado int,
  numero_vagas_garagem_desejada int,
  numero_suites_desejada int,
  valor_minimo numeric(14,2),
  valor_maximo numeric(14,2),
  cidade text,
  bairro text,
  tipo_pagamento text,
  resumo_atendimento text,
  data_cadastro timestamptz NOT NULL DEFAULT now(),
  data_atualizacao timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS imoveis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria_slug text REFERENCES categorias_imovel(slug),
  codigo text UNIQUE NOT NULL,
  titulo text,
  descricao text,
  cidade text,
  bairro text,
  valor numeric(14,2),
  status_publicacao text NOT NULL DEFAULT 'disponivel',
  caminho_pasta_local text,
  url_base_publica text,
  galeria_imagem text,
  area_total_m2 numeric(14,2),
  area_construida_m2 numeric(14,2),
  dimensao_frente_m numeric(14,2),
  dimensao_fundos_m numeric(14,2),
  numero_dormitorios int,
  numero_suites int,
  numero_banheiros int,
  numero_vagas_garagem int,
  posicao_solar text,
  andar int,
  possui_elevador boolean,
  valor_condominio numeric(14,2),
  aceita_financiamento boolean,
  aceita_permuta boolean,
  diferenciais jsonb NOT NULL DEFAULT '[]'::jsonb,
  estado_imovel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_by text
);

CREATE TABLE IF NOT EXISTS documental_imovel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imovel_id uuid NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,
  endereco_completo text,
  uf text,
  cep numeric,
  matricula_imovel numeric,
  registro_cartorio boolean,
  possui_escritura boolean,
  possui_averbacao boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_by text,
  UNIQUE (imovel_id)
);

CREATE TABLE IF NOT EXISTS imovel_fotos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imovel_id uuid NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,
  nome_arquivo text NOT NULL,
  caminho_local text,
  url_publica text,
  ordem int NOT NULL DEFAULT 1,
  legenda text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seeds iniciais de categorias ficaram fora da migration base.
-- Quando necessário, devem entrar em bootstrap opcional da instalação.
