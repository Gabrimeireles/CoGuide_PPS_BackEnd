# Merge Train para homologation

## Convencao de branches
- `feat/<issue>-<slug>` para feature/refactor
- `docs/<issue>-<slug>` para documentacao
- `chore/<issue>-<slug>` para ajustes operacionais

## Regras de commit
- Mensagem deve conter referencia: `refs #<issue>`
- Commit final da branch pode usar `closes #<issue>` apenas no PR

## Regras de PR
- Base: `homologation`
- Template minimo:
  - Contexto
  - Escopo
  - Como testar
  - Risco/rollback
  - `Closes #<issue>`

## Ordem sugerida de merge (refactor atual)
1. #10 CI/CD org-wide
2. #9 Config e strategy de secrets
3. #13 Docs operacionais
4. #14 Politica de integracao
5. #11 Observabilidade
6. #12 Qualidade
7. #8 Arquitetura

## Gate de merge
- Build verde
- Swagger workflow verde
- Release workflow sem erro de permissao
- Deploy homologation com health-check verde (ou justificativa de skip)

## Release para servidor
- Merge train concluido em `homologation`
- Atualizar `package.json` version
- Criar release/tag
- Aguardar deploy automatico por `release.published`
