# CorretorCenter

## Instalação (VPS nova, semi-automática)

Nesta versão, **proxy/SSL e subdomínios ficam fora do instalador**.
Você configura isso no **Nginx Proxy Manager (NPM)**, e o instalador cuida só do que o CorretorCenter precisa para rodar (app + banco + service).

### Portas
- **CorretorCenter (app)**: `5180` (padrão)
- **Nginx Proxy Manager**: painel em `81`, proxy em `80/443`

### Etapas (ordem recomendada)

#### 1) Liberar portas no firewall (antes do Nginx Proxy Manager)
Rode este comando **antes** de instalar o NPM para evitar falhas de SSL por portas fechadas.

Ubuntu/Debian (iptables + persistência após reboot):
```bash
sudo bash -lc 'set -e; apt-get update; apt-get install -y iptables-persistent; iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT; iptables -C INPUT -p tcp --dport 81 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 81 -j ACCEPT; iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT; iptables -C INPUT -p tcp --dport 5180 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 5180 -j ACCEPT; mkdir -p /etc/iptables; iptables-save > /etc/iptables/rules.v4'
```

#### 2) Nginx Proxy Manager (pré-requisito)
Na VPS, tenha o NPM instalado e acessível por um subdomínio (ex.: `proxy.seudominio.com`) com HTTPS.

No painel do NPM, crie os subdomínios do CorretorCenter apontando para o app:
- `painel.seudominio.com` → `http://127.0.0.1:5180`
- `form.seudominio.com` → `http://127.0.0.1:5180`
- `galeria.seudominio.com` → `http://127.0.0.1:5180`
- `imagens.seudominio.com` → `http://127.0.0.1:5180`

#### 3) Instalar Git na VPS
Ubuntu/Debian:
```bash
sudo apt update && sudo apt install -y git
```

Oracle Linux/RHEL/Fedora:
```bash
sudo dnf install -y git
```

#### 4) Verificar se o Git foi instalado
```bash
git --version
```

#### 5) Clonar o repositório
```bash
git clone https://github.com/dineiOpenclaw/corretorcenter.git
```

#### 6) Entrar na pasta clonada
```bash
cd corretorcenter
```

#### 7) Rodar o script de ajuste do .env
```bash
./scripts/configure-env.sh
```

Como o script funciona:
- pergunta os domínios: painel, formulário, galeria e imagens
- pergunta usuário e senha do painel
- atualiza o arquivo `.env` (somente as chaves relacionadas)

#### 8) Rodar o instalador
```bash
./scripts/install-wizard.sh
```

Ao final, a aplicação deve responder localmente:
- `http://127.0.0.1:5180/health`

E os subdomínios devem abrir via NPM/HTTPS.

---

## Reset completo para reinstalação limpa

Use este reset apenas em VPS dedicada ao CorretorCenter. Ele tenta remover somente o que existir no momento, então funciona mesmo quando a instalação anterior falhou no meio do caminho.

### Uso normal
Saia da pasta do projeto e execute:
```bash
cd ..
bash corretorcenter/scripts/reset-install.sh
```

### Uso sem confirmação interativa
```bash
cd ..
bash corretorcenter/scripts/reset-install.sh --yes
```

---

## Atualização assistida
```bash
./scripts/update-assisted.sh
```
