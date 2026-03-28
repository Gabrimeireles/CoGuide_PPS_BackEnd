# CI/CD Reutilizavel Profissional

## Repositorio org-wide
Os workflows reutilizaveis ficam em:
- `Gabrimeireles/reusable-workflows`
- Versao atual: `v1`

## Objetivos
- Reusar o mesmo pipeline em qualquer repositorio da org.
- Eliminar dependencia de `sync:secrets` para versionamento/deploy.
- Padronizar deploy com segredo unico por ambiente (`RUNTIME_ENV_FILE`).

## Workflows remotos (base)
- `Gabrimeireles/reusable-workflows/.github/workflows/docker-build.yml@v1`
- `Gabrimeireles/reusable-workflows/.github/workflows/swagger-pages.yml@v1`
- `Gabrimeireles/reusable-workflows/.github/workflows/github-release.yml@v1`
- `Gabrimeireles/reusable-workflows/.github/workflows/docker-deploy-ssh.yml@v1`

## Callers deste repositorio
- `.github/workflows/backend-build.yml`
- `.github/workflows/backend-swagger.yml`
- `.github/workflows/backend-release.yml`
- `.github/workflows/backend-deploy.yml`

## Fluxo recomendado
1. **Build**: publica imagem com tags de branch/sha e `v<package.json.version>`.
2. **Swagger**: gera docs e publica no GitHub Pages.
3. **Release**: cria tag/release com base no `package.json.version` (ou input manual).
4. **Deploy**: deploy por `release.published` ou manual.

## Sem sync de secrets

### Nao recomendado
- Sincronizar `.env` local para dezenas de `repo secrets` via script.

### Recomendado
- `Environment Secrets` + secret multi-linha `RUNTIME_ENV_FILE`.

Exemplo de `RUNTIME_ENV_FILE`:

```env
DB_URI=mongodb://mongo:27017/coguide
JWT_SECRET=...
JWT_EXPIRES_IN=1h
CORS_ORIGIN=https://app.exemplo.com
PORT=3000
```

## Secrets necessarios (deploy)
- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`
- `GHCR_PAT`
- `RUNTIME_ENV_FILE`
- opcionais: `HEALTH_URL`, `DISCORD_WEBHOOK_URL`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`

## Como usar em qualquer repositorio da org
1. Criar callers `backend-*.yml` apontando para `Gabrimeireles/reusable-workflows/...@v1`.
2. Ajustar `image_name`, `service_name` e secrets.
3. Fixar versao por tag (`@v1`) para estabilidade.
