CREATE TABLE IF NOT EXISTS cargos_funcionario (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cargos_funcionario_nome_unique UNIQUE (nome)
);

CREATE TABLE IF NOT EXISTS funcionarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL UNIQUE,
  nome text NOT NULL,
  sobrenome text NOT NULL,
  telefone text NOT NULL,
  email text,
  endereco text,
  cargo_id uuid NOT NULL REFERENCES cargos_funcionario(id),
  data_cadastro timestamptz NOT NULL DEFAULT now(),
  data_alteracao timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funcionarios_cargo_id ON funcionarios(cargo_id);
CREATE INDEX IF NOT EXISTS idx_funcionarios_nome ON funcionarios(nome);
CREATE INDEX IF NOT EXISTS idx_funcionarios_telefone ON funcionarios(telefone);
