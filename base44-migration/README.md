# B7 Barber Club no Base44

Este é o início da migração do B7 para o backend/hosting Base44. O site Python original continua fora desta pasta e não foi alterado por esta migração.

## O que está portado

- Home React com planos mensais e catálogo dos 12 serviços.
- Perfis Artur, Fabio e Ricardo com as fotografias copiadas para `public/imagens/`.
- Cadastro Base44 com confirmação de e-mail OTP e login por e-mail/senha.
- Entidades para usuários, serviços, barbeiros, disponibilidade, solicitações de horário, assinaturas e lançamentos de caixa.
- Funções Deno para catálogo, estado do membro, solicitações, administração, checkout Mercado Pago e webhook.
- Preços de assinatura definidos no servidor: corte R$ 84,90, barba R$ 79,90 e corte + barba R$ 149,50.

## Primeira preparação

O ambiente local precisa de Node.js 20.19 ou superior e npm. Na pasta `base44-migration`, instale as dependências e crie/vincule o app ao workspace Base44:

```bash
npm install
npx base44 login
npx base44 link --create --name "B7 Barber Club" --description "Barbearia e assinaturas mensais"
```

Depois do vínculo, `base44/.app.jsonc` conterá o ID do app e ficará fora do Git. Os comandos acima podem solicitar autenticação Base44 no navegador; não compartilhe tokens de acesso no chat.

## Configurar e publicar

Adicione estes segredos ao app pelo dashboard Base44 ou `npx base44 secrets set`:

- `MERCADOPAGO_ACCESS_TOKEN`: Access Token de teste primeiro; não é a Public Key.
- `MERCADOPAGO_WEBHOOK_SECRET`: segredo de assinatura do webhook para o app no Mercado Pago.
- `B7_ADMIN_SETUP_SECRET`: segredo temporário, aleatório e longo para promover o primeiro administrador.

Configure a chave de webhook também na seção de Webhooks do Mercado Pago. O backend verifica `x-signature`, consulta a assinatura/fatura à API do provider e só considera membro ativo quando uma fatura recente está `processed`. Não use a URL de retorno do checkout como prova de pagamento.

Para desenvolver localmente, rode `npx base44 dev` após vincular o app. Para produção, valide os schemas e execute o deploy pelo CLI:

```bash
npx base44 deploy --build
```

O publish real não foi executado: falta vincular o projeto a um app/workspace na conta Base44 e configurar os segredos. Também não foi possível compilar neste ambiente porque Node.js/npm não estão instalados.

## Primeira conta administradora

1. Cadastre a conta pelo fluxo normal do app e confirme o código OTP enviado por e-mail.
2. Invoque uma vez a função `bootstrapAdmin` com o e-mail dessa conta e o header `x-b7-setup-secret` igual ao segredo temporário configurado.
3. Remova imediatamente `B7_ADMIN_SETUP_SECRET` do dashboard Base44; a função deixa de responder quando o segredo não existe.

Não envie o segredo por chat, não o grave nos arquivos e não o deixe configurado após promover o primeiro admin.

## Notas de migração

- O catálogo padrão aparece mesmo antes da carga inicial; entre como admin e use “Carregar catálogo inicial” para gravar serviços e barbeiros nas entidades. O seed confere nomes antes de criar para evitar duplicar registros existentes.
- O admin poderá gerenciar catálogo, disponibilidade, caixa e aprovar/recusar solicitações. Solicitações não são reservas confirmadas até a equipe aprová-las.
- A migração de dados das contas SQLite antigas ainda não foi executada. Será necessário exportar usuários/serviços necessários e importar para as entidades/Base44; senhas não migram e os clientes precisarão criar conta e confirmar e-mail no Base44.
- O CLI Base44, funções backend e publicação requerem uma conta/app Base44 vinculada, ausente neste workspace.