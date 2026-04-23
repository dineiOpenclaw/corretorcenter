# Errors

Command failures and integration errors.

---
## [ERR-20260422-001] install_wizard_external_https_validation

**Logged**: 2026-04-22T03:36:30Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Installer reached service and Caddy publication, but external HTTPS validation failed because inbound ports 80/443 were blocked by host firewall rules.

### Error
```text
O subdomínio final ainda não respondeu em https://painel1.codeflowsoluctions.com/health após publicar o Caddy.
```

### Context
- VPS test host: `129.80.184.240`
- DNS for `painel1.codeflowsoluctions.com` already resolved to the VPS IP
- Local app health on `127.0.0.1:5180/health` returned 200
- Caddy listened on `*:80` and `*:443`
- Host firewall rules ended with `-A INPUT -j REJECT --reject-with icmp-host-prohibited`, only allowing SSH and loopback, so ACME/cert validation could not reach ports 80/443

### Suggested Fix
Add explicit firewall validation for inbound 80/443 before final HTTPS check, and fail with a clear message instructing the operator to open those ports in iptables/security lists.

### Metadata
- Reproducible: yes
- Related Files: scripts/install-wizard.sh

---
## [ERR-20260423-001] install-wizard systemd service path mismatch

**Logged**: 2026-04-23T20:10:00-03:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
New semi-automatic installer generated/published a systemd service that still pointed to `/opt/corretorcenter`, causing startup failure on fresh installs under `/home/ubuntu/corretorcenter`.

### Error
```
corretorcenter.service: Failed to load environment files: No such file or directory
corretorcenter.service: Failed to spawn 'start' task: No such file or directory
```

### Context
The simplified installer stopped publishing Caddy but kept using the legacy service template with hardcoded paths and user/group. Fresh install then failed local health validation because the service never started.

### Suggested Fix
Template must use placeholders for working directory, env file, node binary, and runtime user/group; install-wizard must replace them when generating the service.

### Metadata
- Reproducible: yes
- Related Files: scripts/install-wizard.sh,deploy/corretorcenter.service.example

---
