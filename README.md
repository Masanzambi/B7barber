# B7 Barber

## Executar localmente

Requer Python 3.10 ou mais recente; não precisa instalar pacotes npm ou Python.

```bash
python3 server.py
```

Abra http://127.0.0.1:8000. Não abra `index.html` ou `login.html` diretamente como arquivos, porque o login precisa da API HTTP.

## Assinaturas Mercado Pago (sandbox)

O fluxo cria uma assinatura mensal no endpoint `preapproval` com valor definido no servidor. O cliente é enviado ao `init_point` do Mercado Pago; a volta do navegador não confirma pagamento. O Club só é liberado quando um webhook válido leva o servidor a consultar o Mercado Pago e confirmar uma fatura `processed`.

Para testar:

1. Crie uma aplicação no [painel de desenvolvedores do Mercado Pago](https://www.mercadopago.com.br/developers/panel/app) e use o Access Token de teste. Gere também a chave secreta de Webhooks.
2. Inicie um túnel HTTPS para o servidor local, por exemplo `cloudflared tunnel --url http://127.0.0.1:8000`. Use a URL HTTPS pública atribuída ao túnel; `localhost` não pode receber os webhooks do Mercado Pago.
3. Exporte as configurações no terminal em que vai iniciar o servidor. Substitua os valores de exemplo pelos dados obtidos no painel e pela URL do túnel:

```bash
export MERCADOPAGO_ACCESS_TOKEN='TEST-seu-access-token'
export MERCADOPAGO_WEBHOOK_SECRET='seu-segredo-de-webhook'
export B7_PUBLIC_URL='https://seu-subdominio.trycloudflare.com'
export B7_COOKIE_SECURE=1
python3 server.py
```

4. Acesse a home pela URL HTTPS do túnel, entre ou crie uma conta e escolha um plano. O sistema enviará para o checkout hospedado pelo Mercado Pago.
5. A criação da assinatura já envia `notification_url` como `https://seu-subdominio.trycloudflare.com/api/payments/mercadopago/webhook`. Configure a chave secreta de Webhooks da aplicação e habilite os eventos `subscription_preapproval` e `subscription_authorized_payment` conforme as opções disponíveis para a integração de Assinaturas. O endpoint confere `x-signature` e consulta o recurso na API antes de alterar o estado local.
6. Conclua uma cobrança de teste com as contas e cartões de teste documentados pelo Mercado Pago. A home mostrará o plano como ativo somente após uma fatura processada.

O token e a chave secreta ficam apenas nas variáveis de ambiente do servidor; não os coloque no HTML, JavaScript ou em commits. A integração ainda não foi exercitada contra uma conta sandbox porque as credenciais e a URL HTTPS do túnel precisam ser fornecidas/configuradas no ambiente local. A URL de retorno do navegador serve apenas para levar o cliente de volta à home; ela não altera o estado de pagamento.

## Acesso administrativo

Para criar a primeira conta administrativa em um único passo, pare o servidor com `Ctrl+C` e execute:

```bash
python3 server.py --create-admin admin@exemplo.com
```

O terminal pedirá nome, telefone e senha; a senha não aparecerá enquanto é digitada. Depois, inicie o servidor (`python3 server.py`) e acesse http://127.0.0.1:8000/admin.html. Também existe o link “Acesso administrativo” no rodapé da tela de login.

Para promover uma conta de cliente já cadastrada, continua disponível:

```bash
python3 server.py --promote-admin voce@exemplo.com
```

Para configurar um nome de usuário e uma nova senha em uma conta existente, promovendo-a a administradora:

```bash
python3 server.py --set-admin-login voce@exemplo.com Barber07
```

O terminal solicitará a senha sem exibi-la. No painel, é possível entrar usando o nome de usuário ou o e-mail.

O painel permite consultar/desativar contas, alterar e arquivar serviços, criar serviços, ajustar a disponibilidade e registrar entradas e saídas do fluxo de caixa por barbeiro. O caixa apresenta lucro semanal (segunda a domingo), mensal e anual; os lançamentos são manuais e o lucro é calculado como entradas menos saídas. Para desativar contas ou editar dados, é exigido perfil de administrador. A promoção de perfil só pode ser feita por quem tem acesso local ao terminal e ao banco.

## Banco de dados

Na primeira execução, o servidor cria `b7barber.sqlite3` ao lado de `server.py`. O SQLite guarda nome, e-mail, telefone, hash/salt da senha e sessões. As senhas não são armazenadas em texto puro. Para usar outro caminho:

```bash
B7_DATABASE=/caminho/privado/b7barber.sqlite3 python3 server.py
```

Faça backup do arquivo do banco com o servidor parado. Não o publique nem o inclua no controle de versão.

## Limites desta versão

O servidor da biblioteca padrão foi feito para desenvolvimento/local e escuta somente em `127.0.0.1`. Não o exponha diretamente à internet. Para produção, use um servidor WSGI/ASGI mantido, HTTPS, limitação de tentativas, política de backup e configuração de cookies seguros (`B7_COOKIE_SECURE=1` atrás de HTTPS). Recuperação por e-mail e autenticação Google/Apple ainda dependem de configurar serviços externos. Reservas ainda não são persistidas; os horários controlam disponibilidade manual, não compromissos confirmados.

## Testes

```bash
python3 -m unittest discover -s tests -v
```
